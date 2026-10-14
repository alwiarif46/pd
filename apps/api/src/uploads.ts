import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  fitsBidCap,
  isUuid,
  isValidFileSize,
  normalizeSolicitationKey,
  reserveCredit,
  schema,
  withOrg,
  type FileKind,
  type Plan,
} from '@pd/core';
import { requireAuth } from './context.js';
import {
  bidBytesInUse,
  currentCreditPeriod,
  expireAbandonedUploads,
  lockOrg,
  notDeleted,
  releaseSessionCredit,
  removeChunkDirs,
  reserveForBid,
} from './credits.js';
import { apiError } from './errors.js';
import { findBid, inOrg, type Outcome, queueAfterCommit } from './scope.js';
import { enqueueScan } from './queue.js';

const CHUNK_BYTES = 20 * 1024 * 1024;
const dataDir = process.env.DATA_DIR || '/data/files';
const SHA256 = /^[0-9a-f]{64}$/i;

const STORED_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);

/** The extension the sandbox needs to pick an extractor, from a fixed list; otherwise none. */
export function storedExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return STORED_EXTENSIONS.has(extension) ? extension : '';
}

function isKind(value: string): value is FileKind {
  return value === 'solicitation' || value === 'amendment' || value === 'attachment' || value === 'resume' || value === 'draft';
}

/** A bid key that is set. 'PENDING' (or empty) means the first solicitation has not set it yet. */
function settledKey(key: string | null | undefined): string | null {
  const normalized = normalizeSolicitationKey(key ?? '');
  return normalized && normalized !== 'PENDING' ? normalized : null;
}

export async function registerUploads(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/api/bids/:id/uploads', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as {
      fileName?: unknown;
      kind?: unknown;
      declaredSize?: unknown;
      sha256?: unknown;
      chunkCount?: unknown;
      /** The solicitation number printed on the file, when the client knows it. */
      solicitationNumber?: unknown;
    };
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
    const declaredSize = body.declaredSize;
    const chunkCount = body.chunkCount;
    if (
      !fileName
      || !isKind(kind)
      || !isValidFileSize(declaredSize)
      || typeof body.sha256 !== 'string' || !SHA256.test(body.sha256)
      || typeof chunkCount !== 'number' || !Number.isSafeInteger(chunkCount) || chunkCount < 1
      // Every chunk holds at least 1 byte and at most CHUNK_BYTES.
      || chunkCount > declaredSize || chunkCount * CHUNK_BYTES < declaredSize
    ) {
      return reply.code(400).send(apiError('invalid_upload'));
    }
    const sha256 = body.sha256.toLowerCase();
    const fileKey = typeof body.solicitationNumber === 'string' && normalizeSolicitationKey(body.solicitationNumber)
      ? body.solicitationNumber.trim()
      : null;
    const abandoned: string[] = [];
    const result = await inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, bidId);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      // One upload start at a time per organization: period creation and the credit check
      // below must not interleave with another request's.
      const org = await lockOrg(db, orgId);
      if (!org) {
        return respond(404, { error: 'Bid not found' });
      }
      const now = new Date();
      abandoned.push(...await expireAbandonedUploads(db, orgId, now));

      // Same file on the same bid: never a charge, and never a cap refusal (06 s4).
      const [duplicate] = await db.select({ id: schema.documents.id }).from(schema.documents).where(and(
        eq(schema.documents.bidId, bidId),
        eq(schema.documents.orgId, orgId),
        eq(schema.documents.sha256, sha256),
        notDeleted(),
      )).limit(1);
      if (duplicate) {
        return respond(200, { duplicate: true, documentId: duplicate.id });
      }

      const plan = (org.plan ?? 'free') as Plan;
      // Re-read the bid under the org lock: its credit state may have changed meanwhile.
      const current = (await findBid(db, orgId, bidId))!;
      const usedBytes = await bidBytesInUse(db, orgId, bidId, now);
      if (!fitsBidCap(plan, usedBytes, declaredSize)) {
        return respond(413, apiError('bid_cap_exceeded'));
      }

      const holdsCredit = current.creditStatus === 'reserved' || current.creditStatus === 'consumed';
      const needsCredit = kind === 'solicitation' && !holdsCredit;
      const period = needsCredit ? await currentCreditPeriod(db, orgId, now) : null;
      const decision = reserveCredit(
        period
          ? { allowed: period.allowed, used: period.used, reserved: period.reserved }
          // No period row yet: let reserveForBid create it and decide atomically.
          : { allowed: 1, used: 0, reserved: 0 },
        {
          kind,
          sameSha256: false,
          isFirstSolicitation: needsCredit,
          bidKey: settledKey(current.solicitationKey),
          fileKey,
        },
      );
      if (!decision.ok) {
        return decision.reason === 'out_of_credits'
          ? respond(402, apiError('out_of_credits'))
          : respond(409, apiError('key_mismatch'));
      }
      let creditId: string | null = null;
      if (decision.reserved) {
        creditId = await reserveForBid(db, org, bidId, now);
        if (!creditId) {
          return respond(402, apiError('out_of_credits'));
        }
      }
      // The first solicitation sets the bid's key when the bid has none yet (06 s4).
      if (kind === 'solicitation' && fileKey && !settledKey(current.solicitationKey)) {
        await db.update(schema.bids).set({
          solicitationNumber: fileKey,
          solicitationKey: normalizeSolicitationKey(fileKey),
          updatedAt: now,
        }).where(and(eq(schema.bids.id, bidId), eq(schema.bids.orgId, orgId)));
      }
      const [session] = await db.insert(schema.uploadSessions).values({
        orgId,
        bidId,
        userId: request.auth!.userId,
        fileName,
        kind,
        declaredSize,
        sha256,
        chunkCount,
        status: 'open',
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        creditId,
      }).returning();
      return respond(201, { id: session.id, expiresAt: session.expiresAt, creditReserved: creditId !== null });
    });
    await removeChunkDirs(dataDir, orgId, abandoned);
    return result;
  });

  // The client gave up on an upload: the session closes and any credit it reserved goes back.
  app.delete('/api/uploads/:id', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const sessionId = (request.params as { id: string }).id;
    if (!isUuid(sessionId)) {
      return reply.code(404).send({ error: 'Upload session not found' });
    }
    let cancelled = false;
    const result = await inOrg(reply, orgId, async (db, respond) => {
      // Claim it from 'open' once. A concurrent complete or sweep that got there first wins.
      const [session] = await db.update(schema.uploadSessions).set({
        status: 'cancelled',
        updatedAt: new Date(),
      }).where(and(
        eq(schema.uploadSessions.id, sessionId),
        eq(schema.uploadSessions.orgId, orgId),
        eq(schema.uploadSessions.status, 'open'),
      )).returning();
      if (!session) {
        return respond(404, { error: 'Upload session not found' });
      }
      const released = await releaseSessionCredit(db, orgId, session);
      cancelled = true;
      return { ok: true, creditReleased: released };
    });
    if (cancelled) {
      await removeChunkDirs(dataDir, orgId, [sessionId]);
    }
    return result;
  });

  app.put('/api/uploads/:id/chunks/:index', { preHandler: requireAuth, bodyLimit: CHUNK_BYTES + 1024 }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const sessionId = (request.params as { id: string }).id;
    const index = Number((request.params as { index: string }).index);
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > CHUNK_BYTES) {
      return reply.code(400).send({ error: 'Send one chunk up to 20 MB' });
    }
    if (!isUuid(sessionId)) {
      return reply.code(404).send({ error: 'Upload session not found' });
    }
    return inOrg(reply, orgId, async (db, respond) => {
      const [session] = await db.select().from(schema.uploadSessions).where(and(
        eq(schema.uploadSessions.id, sessionId),
        eq(schema.uploadSessions.orgId, orgId),
      ));
      if (!session || session.expiresAt < new Date() || session.status !== 'open') {
        return respond(404, { error: 'Upload session not found' });
      }
      if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) {
        return respond(400, { error: 'Chunk index is out of range' });
      }
      const dir = join(dataDir, orgId, 'chunks', sessionId);
      await mkdir(dir, { recursive: true });
      const chunkPath = join(dir, String(index));
      let already = false;
      try {
        await stat(chunkPath);
        already = true;
      } catch {
        already = false;
      }
      await writeFile(chunkPath, body);
      if (!already) {
        await db.update(schema.uploadSessions).set({
          chunksReceived: session.chunksReceived + 1,
          bytesReceived: session.bytesReceived + body.length,
          updatedAt: new Date(),
        }).where(and(eq(schema.uploadSessions.id, sessionId), eq(schema.uploadSessions.orgId, orgId)));
      }
      return { ok: true };
    });
  });

  app.post('/api/uploads/:id/complete', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const sessionId = (request.params as { id: string }).id;
    if (!isUuid(sessionId)) {
      return reply.code(404).send({ error: 'Upload session not found' });
    }
    const outcome = await withOrg(orgId, async (db): Promise<Outcome> => {
      // Claim the session with a conditional update. The row stays locked until this
      // transaction ends, so a second complete for the same session waits, then finds it
      // no longer open. A failed check below puts it back to open.
      const [session] = await db.update(schema.uploadSessions).set({
        status: 'complete',
        updatedAt: new Date(),
      }).where(and(
        eq(schema.uploadSessions.id, sessionId),
        eq(schema.uploadSessions.orgId, orgId),
        eq(schema.uploadSessions.status, 'open'),
        gt(schema.uploadSessions.expiresAt, new Date()),
      )).returning();
      if (!session) {
        const [existing] = await db.select({ status: schema.uploadSessions.status }).from(schema.uploadSessions).where(and(
          eq(schema.uploadSessions.id, sessionId),
          eq(schema.uploadSessions.orgId, orgId),
        ));
        if (existing?.status === 'complete') {
          return { code: 409, body: { error: 'This upload is already complete' } };
        }
        return { code: 404, body: { error: 'Upload session not found' } };
      }
      const reopen = () => db.update(schema.uploadSessions).set({ status: 'open', updatedAt: new Date() }).where(and(
        eq(schema.uploadSessions.id, sessionId),
        eq(schema.uploadSessions.orgId, orgId),
      ));
      const dir = join(dataDir, orgId, 'chunks', sessionId);
      const names = await readdir(dir).catch(() => [] as string[]);
      if (names.length !== session.chunkCount) {
        await reopen();
        return { code: 400, body: { error: 'Not every chunk has arrived' } };
      }
      // A solicitation never reaches a bid without a credit behind it. Normally its session
      // reserved one at start; if that reservation went back (another session for this bid was
      // abandoned) or processing released it, reserve again now, under the org lock.
      if (session.kind === 'solicitation') {
        const org = await lockOrg(db, orgId);
        const bid = await findBid(db, orgId, session.bidId);
        if (!org || !bid) {
          await reopen();
          return { code: 404, body: { error: 'Bid not found' } };
        }
        if (bid.creditStatus !== 'reserved' && bid.creditStatus !== 'consumed') {
          const creditId = await reserveForBid(db, org, bid.id, new Date());
          if (!creditId) {
            await reopen();
            return { code: 402, body: apiError('out_of_credits') };
          }
        }
      }
      const targetDir = join(dataDir, orgId, 'docs');
      await mkdir(targetDir, { recursive: true });
      // The stored name is server-generated. The client's file name is kept only as a label
      // in `documents.file_name`, never as part of a path.
      const storagePath = `docs/${sessionId}${storedExtension(session.fileName)}`;
      const absolute = join(dataDir, orgId, storagePath);
      const hash = createHash('sha256');
      const output = createWriteStream(absolute);
      for (let index = 0; index < session.chunkCount; index += 1) {
        await pipeline(createReadStream(join(dir, String(index))), output, { end: false });
      }
      output.end();
      await new Promise<void>((resolve) => {
        output.on('finish', () => resolve());
      });
      const file = await readFile(absolute);
      hash.update(file);
      const digest = hash.digest('hex');
      if (digest !== session.sha256 || file.length !== session.declaredSize) {
        await reopen();
        return { code: 400, body: { error: 'The uploaded bytes do not match the declared file' } };
      }
      const [document] = await db.insert(schema.documents).values({
        orgId,
        bidId: session.bidId,
        fileName: session.fileName,
        mime: 'application/octet-stream',
        sizeBytes: file.length,
        sha256: digest,
        kind: session.kind,
        storagePath,
        scanStatus: 'pending',
        extractStatus: 'pending',
        liveStatus: 'live',
      }).returning();
      const [job] = await db.insert(schema.jobs).values({
        orgId,
        bidId: session.bidId,
        documentId: document.id,
        type: 'scan',
        status: 'pending',
      }).returning();
      return {
        code: 201,
        body: { documentId: document.id, jobId: job.id },
        queue: {
          jobId: job.id,
          enqueue: () => enqueueScan({
            orgId,
            bidId: session.bidId,
            documentId: document.id,
            jobId: job.id,
            storagePath,
            kind: session.kind,
          }),
        },
      };
    });
    await queueAfterCommit(orgId, outcome);
    return reply.code(outcome.code).send(outcome.body);
  });
}

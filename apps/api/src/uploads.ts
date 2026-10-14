import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  addMonthsClamped,
  fitsBidCap,
  freeAllowance,
  reserveCredit,
  schema,
  withOrg,
  type FileKind,
  type Plan,
} from '@pd/core';
import { requireAuth } from './context.js';
import { enqueueScan } from './queue.js';

const CHUNK_BYTES = 20 * 1024 * 1024;
const dataDir = process.env.DATA_DIR || '/data/files';

function isKind(value: string): value is FileKind {
  return value === 'solicitation' || value === 'amendment' || value === 'attachment' || value === 'resume' || value === 'draft';
}

export async function registerUploads(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/api/bids/:id/uploads', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    const body = request.body as {
      fileName?: string;
      kind?: string;
      declaredSize?: number;
      sha256?: string;
      chunkCount?: number;
    };
    const kind = body.kind ?? '';
    if (!body.fileName || !isKind(kind) || !body.declaredSize || !body.sha256 || !body.chunkCount) {
      return reply.code(400).send({ error: 'fileName, kind, declaredSize, sha256, and chunkCount are required' });
    }
    return withOrg(orgId, async (db) => {
      const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, bidId));
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
      const plan = (org?.plan ?? 'free') as Plan;
      const documents = await db.select().from(schema.documents).where(eq(schema.documents.bidId, bidId));
      const usedBytes = documents.reduce((sum, document) => sum + document.sizeBytes, 0);
      if (!fitsBidCap(plan, usedBytes, body.declaredSize!)) {
        return reply.code(413).send({ error: 'This file exceeds the bid file cap' });
      }
      if (documents.some((document) => document.sha256 === body.sha256)) {
        return reply.code(200).send({ duplicate: true });
      }
      const solicitations = documents.filter((document) => document.kind === 'solicitation');
      const now = new Date();
      let [credit] = await db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.orgId, orgId));
      if (!credit || credit.periodEnd < now) {
        const start = org?.cycleStart ?? now;
        const firstPeriod = !org?.freeFirstMonthEnds || org.freeFirstMonthEnds > now;
        const allowed = plan === 'free'
          ? freeAllowance({ isFirstPeriod: firstPeriod, returningToFree: false })
          : plan === 'starter' ? 10 : 20;
        const [created] = await db.insert(schema.rfpCredits).values({
          orgId,
          periodStart: start,
          periodEnd: addMonthsClamped(start, 1),
          allowed,
        }).returning();
        credit = created;
      }
      const decision = reserveCredit(
        { allowed: credit.allowed, used: credit.used, reserved: credit.reserved },
        {
          kind,
          sameSha256: false,
          isFirstSolicitation: kind === 'solicitation' && solicitations.length === 0,
          bidKey: bid.solicitationKey === 'PENDING' ? null : bid.solicitationKey,
          fileKey: null,
        },
      );
      if (!decision.ok) {
        const status = decision.reason === 'out_of_credits' ? 402 : 409;
        return reply.code(status).send({ error: decision.reason });
      }
      if (decision.reserved) {
        await db.update(schema.rfpCredits).set({
          reserved: decision.state.reserved,
          updatedAt: new Date(),
        }).where(eq(schema.rfpCredits.id, credit.id));
        await db.update(schema.bids).set({
          creditId: credit.id,
          creditStatus: 'reserved',
          updatedAt: new Date(),
        }).where(eq(schema.bids.id, bidId));
      }
      const [session] = await db.insert(schema.uploadSessions).values({
        orgId,
        bidId,
        userId: request.auth!.userId,
        fileName: body.fileName!,
        kind,
        declaredSize: body.declaredSize!,
        sha256: body.sha256!,
        chunkCount: body.chunkCount!,
        status: 'open',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }).returning();
      return reply.code(201).send({ id: session.id, expiresAt: session.expiresAt });
    });
  });

  app.put('/api/uploads/:id/chunks/:index', { preHandler: requireAuth, bodyLimit: CHUNK_BYTES + 1024 }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const sessionId = (request.params as { id: string }).id;
    const index = Number((request.params as { index: string }).index);
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > CHUNK_BYTES) {
      return reply.code(400).send({ error: 'Send one chunk up to 20 MB' });
    }
    return withOrg(orgId, async (db) => {
      const [session] = await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, sessionId));
      if (!session || session.expiresAt < new Date() || session.status !== 'open') {
        return reply.code(404).send({ error: 'Upload session not found' });
      }
      if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) {
        return reply.code(400).send({ error: 'Chunk index is out of range' });
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
        }).where(eq(schema.uploadSessions.id, sessionId));
      }
      return { ok: true };
    });
  });

  app.post('/api/uploads/:id/complete', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const sessionId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const [session] = await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, sessionId));
      if (!session || session.expiresAt < new Date()) {
        return reply.code(404).send({ error: 'Upload session not found' });
      }
      const dir = join(dataDir, orgId, 'chunks', sessionId);
      const names = await readdir(dir);
      if (names.length !== session.chunkCount) {
        return reply.code(400).send({ error: 'Not every chunk has arrived' });
      }
      const targetDir = join(dataDir, orgId, 'docs');
      await mkdir(targetDir, { recursive: true });
      const storagePath = join('docs', `${sessionId}-${session.fileName}`);
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
        return reply.code(400).send({ error: 'The uploaded bytes do not match the declared file' });
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
      await db.update(schema.uploadSessions).set({ status: 'complete', updatedAt: new Date() }).where(eq(schema.uploadSessions.id, sessionId));
      await enqueueScan({
        orgId,
        bidId: session.bidId,
        documentId: document.id,
        jobId: job.id,
        storagePath,
        kind: session.kind,
      });
      return reply.code(201).send({ documentId: document.id, jobId: job.id });
    });
  });
}

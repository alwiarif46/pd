import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { KEY_OVERRIDES_PER_BID, resolveOrgPath, schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { apiError } from './errors.js';
import { findBid, inOrg, findDocument, type Outcome, queueAfterCommit } from './scope.js';
import { enqueueClassify } from './queue.js';
import { newToken } from './security.js';

const dataDir = process.env.DATA_DIR || '/data/files';

const HOUR = 60 * 60 * 1000;
const viewTokens = new Map<string, { documentId: string; sessionId: string; expiresAt: number }>();

export async function registerDocuments(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/documents', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, bidId);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      return db.select().from(schema.documents).where(and(eq(schema.documents.bidId, bidId), eq(schema.documents.orgId, orgId)));
    });
  });

  app.get('/api/documents/:id/view-token', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      const token = newToken();
      viewTokens.set(token, {
        documentId,
        sessionId: request.auth!.sessionId,
        expiresAt: Date.now() + HOUR,
      });
      return { token, expiresInSeconds: 3600 };
    });
  });

  app.post('/api/documents/:id/confirm-marking', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    const outcome = await withOrg(orgId, async (db): Promise<Outcome> => {
      const document = await findDocument(db, orgId, documentId);
      if (!document || !document.storagePath) {
        return { code: 404, body: { error: 'Document not found' } };
      }
      if (document.extractStatus === 'rejected') {
        return { code: 409, body: { error: 'Classified files are not accepted' } };
      }
      if (document.markingStatus !== 'blocked') {
        return { code: 409, body: { error: 'This file is not waiting for confirmation' } };
      }
      const storagePath = document.storagePath;
      await db.update(schema.documents).set({ markingStatus: 'confirmed', updatedAt: new Date() }).where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)));
      await db.insert(schema.auditLog).values({
        orgId,
        userId: request.auth!.userId,
        action: 'confirm_marking',
        targetType: 'document',
        targetId: documentId,
      });
      const [job] = await db.insert(schema.jobs).values({
        orgId,
        bidId: document.bidId,
        documentId,
        type: 'classify',
        status: 'pending',
      }).returning();
      return {
        code: 200,
        body: { ok: true },
        queue: {
          jobId: job.id,
          enqueue: () => enqueueClassify({
            orgId,
            bidId: document.bidId,
            documentId,
            jobId: job.id,
            storagePath,
            kind: document.kind,
          }),
        },
      };
    });
    await queueAfterCommit(orgId, outcome);
    return reply.code(outcome.code).send(outcome.body);
  });

  app.post('/api/documents/:id/key-override', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    if (auth.role !== 'owner') {
      return reply.code(403).send({ error: 'Only the owner can override a solicitation key' });
    }
    const reason = ((request.body as { reason?: string }).reason ?? '').trim();
    if (!reason) {
      return reply.code(400).send({ error: 'A reason is required' });
    }
    const documentId = (request.params as { id: string }).id;
    const orgId = auth.orgId!;
    return inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      if (document.kind !== 'amendment') {
        return respond(409, apiError('not_an_amendment'));
      }
      // The amendment whose solicitation number did not match, not yet accepted. Locked until
      // COMMIT, so two overrides of one amendment cannot both pass and spend two overrides.
      const [amendment] = await db.select().from(schema.amendments).where(and(
        eq(schema.amendments.documentId, documentId),
        eq(schema.amendments.orgId, orgId),
        eq(schema.amendments.solicitationKeyFound, false),
        eq(schema.amendments.keyOverride, false),
      )).limit(1).for('update');
      if (!amendment) {
        return respond(409, apiError('override_not_needed'));
      }
      // Spend one of the bid's overrides with a conditional increment, so concurrent overrides
      // of different amendments cannot exceed the limit.
      const [bid] = await db.update(schema.bids).set({
        keyOverridesUsed: sql`${schema.bids.keyOverridesUsed} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.bids.id, document.bidId),
        eq(schema.bids.orgId, orgId),
        lt(schema.bids.keyOverridesUsed, KEY_OVERRIDES_PER_BID),
      )).returning({ keyOverridesUsed: schema.bids.keyOverridesUsed });
      if (!bid) {
        return respond(409, apiError('override_limit'));
      }
      await db.update(schema.amendments).set({
        keyOverride: true,
        overrideReason: reason,
        updatedAt: new Date(),
      }).where(and(eq(schema.amendments.id, amendment.id), eq(schema.amendments.orgId, orgId)));
      await db.insert(schema.auditLog).values({
        orgId,
        userId: auth.userId,
        action: 'key_override',
        targetType: 'document',
        targetId: documentId,
        detail: { reason, amendmentId: amendment.id },
      });
      return { ok: true, amendmentId: amendment.id, remaining: KEY_OVERRIDES_PER_BID - bid.keyOverridesUsed };
    });
  });

  app.get('/api/documents/view/:token', { preHandler: requireAuth }, async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const entry = viewTokens.get(token);
    if (!entry || entry.expiresAt < Date.now() || entry.sessionId !== request.auth!.sessionId) {
      return reply.code(404).send({ error: 'View token not found' });
    }
    return { documentId: entry.documentId };
  });

  app.get('/api/documents/:id/pages', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    const query = request.query as { from?: string; to?: string };
    const from = Number(query.from ?? 1);
    const to = Number(query.to ?? from);
    return inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      const rows = await db.select().from(schema.pages).where(and(
        eq(schema.pages.documentId, documentId),
        eq(schema.pages.orgId, orgId),
        gte(schema.pages.pageNo, from),
        lte(schema.pages.pageNo, to),
      )).orderBy(asc(schema.pages.pageNo));
      return {
        fileName: document.fileName,
        liveStatus: document.liveStatus,
        pagesEstimated: document.pagesEstimated,
        extractMethod: document.extractMethod,
        pages: rows,
      };
    });
  });

  app.get('/api/documents/:id/file', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    const found = await inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      if (document.liveStatus === 'deleted') {
        // A deleted file has no server copy; its page text and the rows it produced stay.
        return respond(410, { error: document.kind === 'resume' ? 'Resume deleted after 90 days' : 'This file was deleted' });
      }
      if (!document.storagePath) {
        return respond(404, { error: 'Document not found' });
      }
      if (document.liveStatus === 'archived') {
        return respond(409, { error: 'This file is archived. Restore it to open the full page.' });
      }
      // A stored path must stay inside this organization's folder.
      const absolute = resolveOrgPath(dataDir, orgId, document.viewerPath || document.storagePath);
      if (!absolute) {
        return respond(404, { error: 'Document not found' });
      }
      try {
        await stat(absolute);
      } catch {
        return respond(404, { error: 'The viewer copy is not on this server' });
      }
      return { file: absolute };
    });
    if (!('file' in found)) {
      return reply;
    }
    // Stream after COMMIT; the stream does not need the transaction.
    return reply.type('application/pdf').send(createReadStream((found as { file: string }).file));
  });

  app.post('/api/documents/:id/restore', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      if (document.liveStatus !== 'archived') {
        return respond(409, { error: 'This file is not archived' });
      }
      await db.update(schema.documents).set({
        liveStatus: 'restoring',
        updatedAt: new Date(),
      }).where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)));
      return { status: 'Restore requested' };
    });
  });

  /**
   * Deletes a file (05 s3.10): the server copies go and its MB is freed, but the document row,
   * its page text, and the tab rows and quotes it produced stay, so every source link still
   * opens the page text (07 s2 keeps page text until the bid is deleted). The row is marked
   * `live_status = 'deleted'`. A second delete is a no-op. Credits are not touched: a
   * reservation is settled by processing, which reads the page text, not the file.
   */
  app.delete('/api/documents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    const orgId = auth.orgId!;
    const documentId = (request.params as { id: string }).id;
    const files: string[] = [];
    const result = await inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      const [deleted] = await db.update(schema.documents).set({
        liveStatus: 'deleted',
        storagePath: null,
        viewerPath: null,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.documents.id, documentId),
        eq(schema.documents.orgId, orgId),
        sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
      )).returning({ id: schema.documents.id });
      if (!deleted) {
        return { ok: true };
      }
      for (const path of [document.storagePath, document.viewerPath]) {
        const absolute = path ? resolveOrgPath(dataDir, orgId, path) : null;
        if (absolute) {
          files.push(absolute);
        }
      }
      await db.insert(schema.auditLog).values({
        orgId,
        userId: auth.userId,
        action: 'delete_document',
        targetType: 'document',
        targetId: documentId,
        detail: { kind: document.kind },
      });
      return { ok: true };
    });
    await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => undefined)));
    return result;
  });
}

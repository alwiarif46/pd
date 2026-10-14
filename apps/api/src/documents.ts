import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { resolveOrgPath, schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { findBid, findDocument, type Outcome, queueAfterCommit } from './scope.js';
import { enqueueClassify } from './queue.js';
import { newToken } from './security.js';

const dataDir = process.env.DATA_DIR || '/data/files';

const HOUR = 60 * 60 * 1000;
const viewTokens = new Map<string, { documentId: string; sessionId: string; expiresAt: number }>();

export async function registerDocuments(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/documents', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const bid = await findBid(db, orgId, bidId);
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      return db.select().from(schema.documents).where(and(eq(schema.documents.bidId, bidId), eq(schema.documents.orgId, orgId)));
    });
  });

  app.get('/api/documents/:id/view-token', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
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
    return withOrg(orgId, async (db) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      const bid = await findBid(db, orgId, document.bidId);
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      if (bid.keyOverridesUsed >= 2) {
        return reply.code(409).send({ error: 'This bid has used its two key overrides' });
      }
      await db.update(schema.bids).set({
        keyOverridesUsed: bid.keyOverridesUsed + 1,
        updatedAt: new Date(),
      }).where(and(eq(schema.bids.id, bid.id), eq(schema.bids.orgId, orgId)));
      await db.insert(schema.auditLog).values({
        orgId: auth.orgId!,
        userId: auth.userId,
        action: 'key_override',
        targetType: 'document',
        targetId: documentId,
        detail: { reason },
      });
      return { ok: true, remaining: 2 - (bid.keyOverridesUsed + 1) };
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
    return withOrg(orgId, async (db) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
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
    return withOrg(orgId, async (db) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document?.storagePath) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (document.kind === 'resume' && document.liveStatus === 'deleted') {
        return reply.code(410).send({ error: 'Resume deleted after 90 days' });
      }
      if (document.liveStatus === 'archived' || document.liveStatus === 'deleted') {
        return reply.code(409).send({ error: 'This file is archived. Restore it to open the full page.' });
      }
      // A stored path must stay inside this organization's folder.
      const absolute = resolveOrgPath(dataDir, orgId, document.viewerPath || document.storagePath);
      if (!absolute) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      try {
        await stat(absolute);
      } catch {
        return reply.code(404).send({ error: 'The viewer copy is not on this server' });
      }
      return reply.type('application/pdf').send(createReadStream(absolute));
    });
  });

  app.post('/api/documents/:id/restore', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (document.liveStatus !== 'archived') {
        return reply.code(409).send({ error: 'This file is not archived' });
      }
      await db.update(schema.documents).set({
        liveStatus: 'restoring',
        updatedAt: new Date(),
      }).where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)));
      return { status: 'Restore requested' };
    });
  });

  app.delete('/api/documents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      await db.delete(schema.documents).where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)));
      return { ok: true };
    });
  });
}

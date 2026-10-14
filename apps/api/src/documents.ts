import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
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
      const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, bidId));
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      return db.select().from(schema.documents).where(eq(schema.documents.bidId, bidId));
    });
  });

  app.get('/api/documents/:id/view-token', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
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
    return withOrg(orgId, async (db) => {
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
      if (!document || !document.storagePath) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (document.extractStatus === 'rejected') {
        return reply.code(409).send({ error: 'Classified files are not accepted' });
      }
      if (document.markingStatus !== 'blocked') {
        return reply.code(409).send({ error: 'This file is not waiting for confirmation' });
      }
      await db.update(schema.documents).set({ markingStatus: 'confirmed', updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
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
      await enqueueClassify({
        orgId,
        bidId: document.bidId,
        documentId,
        jobId: job.id,
        storagePath: document.storagePath,
        kind: document.kind,
      });
      return { ok: true };
    });
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
    return withOrg(auth.orgId!, async (db) => {
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, document.bidId));
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      if (bid.keyOverridesUsed >= 2) {
        return reply.code(409).send({ error: 'This bid has used its two key overrides' });
      }
      await db.update(schema.bids).set({
        keyOverridesUsed: bid.keyOverridesUsed + 1,
        updatedAt: new Date(),
      }).where(eq(schema.bids.id, bid.id));
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
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      const rows = await db.select().from(schema.pages).where(and(
        eq(schema.pages.documentId, documentId),
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
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
      if (!document?.storagePath) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (document.kind === 'resume' && document.liveStatus === 'deleted') {
        return reply.code(410).send({ error: 'Resume deleted after 90 days' });
      }
      if (document.liveStatus === 'archived' || document.liveStatus === 'deleted') {
        return reply.code(409).send({ error: 'This file is archived. Restore it to open the full page.' });
      }
      const absolute = join(dataDir, orgId, document.viewerPath || document.storagePath);
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
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (document.liveStatus !== 'archived') {
        return reply.code(409).send({ error: 'This file is not archived' });
      }
      await db.update(schema.documents).set({
        liveStatus: 'restoring',
        updatedAt: new Date(),
      }).where(eq(schema.documents.id, documentId));
      return { status: 'Restore requested' };
    });
  });

  app.delete('/api/documents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      await db.delete(schema.documents).where(eq(schema.documents.id, documentId));
      return { ok: true };
    });
  });
}

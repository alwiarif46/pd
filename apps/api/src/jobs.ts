import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isUuid, schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { findBid, findDocument } from './scope.js';
import { enqueueClassify, enqueueScan } from './queue.js';

export async function registerJobs(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const bid = await findBid(db, orgId, bidId);
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const rows = await db.select().from(schema.jobs).where(and(eq(schema.jobs.bidId, bidId), eq(schema.jobs.orgId, orgId)));
      const pending = rows.filter((job) => job.status === 'pending').length;
      return rows.map((job, index) => ({
        ...job,
        queuePosition: job.status === 'pending' ? index + 1 : null,
        queueDepth: pending,
      }));
    });
  });

  app.post('/api/jobs/:id/retry', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const jobId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      if (!isUuid(jobId)) {
        return reply.code(404).send({ error: 'Job not found' });
      }
      const [job] = await db.select().from(schema.jobs).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.orgId, orgId)));
      if (!job?.documentId || !job.bidId) {
        return reply.code(404).send({ error: 'Job not found' });
      }
      if (job.status !== 'failed') {
        return reply.code(409).send({ error: 'Only a failed step can be retried' });
      }
      const document = await findDocument(db, orgId, job.documentId);
      if (!document?.storagePath) {
        return reply.code(404).send({ error: 'The file is no longer available' });
      }
      const [created] = await db.insert(schema.jobs).values({
        orgId,
        bidId: job.bidId,
        documentId: job.documentId,
        type: job.type,
        status: 'pending',
      }).returning();
      const payload = {
        orgId,
        bidId: job.bidId,
        documentId: job.documentId,
        jobId: created.id,
        storagePath: document.storagePath,
        kind: document.kind,
      };
      if (job.type === 'scan') {
        await enqueueScan(payload);
      } else {
        await enqueueClassify(payload);
      }
      return { id: created.id };
    });
  });
}

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { enqueueClassify, enqueueScan } from './queue.js';

export async function registerJobs(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, bidId));
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.bidId, bidId));
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
      const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
      if (!job?.documentId || !job.bidId) {
        return reply.code(404).send({ error: 'Job not found' });
      }
      if (job.status !== 'failed') {
        return reply.code(409).send({ error: 'Only a failed step can be retried' });
      }
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, job.documentId));
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

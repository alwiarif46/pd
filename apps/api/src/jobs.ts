import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isUuid, schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { findBid, inOrg, findDocument, type Outcome, queueAfterCommit } from './scope.js';
import { enqueueClassify, enqueueScan } from './queue.js';

export async function registerJobs(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, bidId);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
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
    if (!isUuid(jobId)) {
      return reply.code(404).send({ error: 'Job not found' });
    }
    const outcome = await withOrg(orgId, async (db): Promise<Outcome> => {
      const [job] = await db.select().from(schema.jobs).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.orgId, orgId)));
      if (!job?.documentId || !job.bidId) {
        return { code: 404, body: { error: 'Job not found' } };
      }
      if (job.status !== 'failed') {
        return { code: 409, body: { error: 'Only a failed step can be retried' } };
      }
      const document = await findDocument(db, orgId, job.documentId);
      if (!document?.storagePath) {
        return { code: 404, body: { error: 'The file is no longer available' } };
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
      return {
        code: 200,
        body: { id: created.id },
        queue: {
          jobId: created.id,
          enqueue: () => (job.type === 'scan' ? enqueueScan(payload) : enqueueClassify(payload)),
        },
      };
    });
    await queueAfterCommit(orgId, outcome);
    return reply.code(outcome.code).send(outcome.body);
  });
}

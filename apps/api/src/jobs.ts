import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isUuid, lockDocumentJobs, schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { lockBid, lockOrg, reserveForBid, shareOrg } from './credits.js';
import { apiError } from './errors.js';
import { findBid, findDocument, type Outcome, queueAfterCommit } from './scope.js';
import { queueInfo } from './queue-stats.js';
import { enqueueClassify, enqueueScan } from './queue.js';

export async function registerJobs(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    const found = await withOrg(orgId, async (db) => {
      const bid = await findBid(db, orgId, bidId);
      if (!bid) {
        return null;
      }
      const rows = await db.select().from(schema.jobs).where(and(eq(schema.jobs.bidId, bidId), eq(schema.jobs.orgId, orgId)));
      const unfinished = rows.filter((job) => job.status !== 'failed' && job.status !== 'completed');
      const documentIds = [...new Set(unfinished.flatMap((job) => (job.documentId ? [job.documentId] : [])))];
      const documents = documentIds.length === 0 ? [] : await db.select({ id: schema.documents.id, kind: schema.documents.kind }).from(schema.documents).where(and(
        inArray(schema.documents.id, documentIds),
        eq(schema.documents.orgId, orgId),
      ));
      const kinds = new Map(documents.map((document) => [document.id, document.kind as string]));
      const settings = unfinished.length === 0 ? [] : await db.select({ maxConcurrent: schema.providerSettings.maxConcurrent }).from(schema.providerSettings);
      const limits = settings.map((setting) => setting.maxConcurrent).filter((value) => value > 0);
      return { rows, unfinished, kinds, concurrency: limits.length ? Math.min(...limits) : 1 };
    });
    if (!found) {
      return reply.code(404).send({ error: 'Bid not found' });
    }
    // Redis is read after COMMIT, never inside the transaction.
    const info = await queueInfo(
      found.unfinished.map((job) => ({ id: job.id, documentKind: job.documentId ? found.kinds.get(job.documentId) ?? null : null })),
      found.concurrency,
    );
    return reply.send(found.rows.map((job) => {
      const stats = info.get(job.id);
      return {
        ...job,
        stage: stats?.stage ?? null,
        queuePosition: stats?.queuePosition ?? null,
        queueDepth: stats?.queueDepth ?? 0,
        etaSeconds: stats?.etaSeconds ?? null,
      };
    }));
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
      // The document's job lock (an advisory lock held until COMMIT, taken before any row lock)
      // serialises retries of one file with each other and with the worker's kick of a held file,
      // which takes it too: only a retry of the document's newest unfinished or failed step runs,
      // so a double click, or a retry racing the kick, never runs one file twice. It is not a row
      // lock, so it adds nothing to the row lock order (credits.ts).
      await lockDocumentJobs(db, document.id);
      // Lock order: organization (FOR UPDATE when a credit may be reserved, else the key share the
      // job insert needs), bid, credit (credits.ts).
      const org = document.kind === 'solicitation' ? await lockOrg(db, orgId) : null;
      if (document.kind !== 'solicitation') {
        await shareOrg(db, orgId);
      }
      // A newer completed step does not count: there would be nothing left to retry.
      const [newer] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(
        eq(schema.jobs.documentId, document.id),
        eq(schema.jobs.orgId, orgId),
        ne(schema.jobs.status, 'completed'),
        // Compared in the database: created_at has microseconds, a JS Date only milliseconds.
        sql`${schema.jobs.createdAt} > (select created_at from jobs where id = ${job.id})`,
      )).limit(1);
      if (newer) {
        return { code: 409, body: apiError('retry_superseded') };
      }
      // A failed run released the solicitation's credit (06 s4). Rerunning it builds the matrix
      // again, so it needs a credit again: reserve one before queueing, or refuse with 402.
      let reserved = false;
      if (document.kind === 'solicitation') {
        const [bid] = await lockBid(db, orgId, job.bidId);
        if (!org || !bid) {
          return { code: 404, body: { error: 'Job not found' } };
        }
        if (bid.creditStatus !== 'reserved' && bid.creditStatus !== 'consumed') {
          const creditId = await reserveForBid(db, org, bid.id, new Date());
          if (!creditId) {
            return { code: 402, body: apiError('out_of_credits') };
          }
          reserved = true;
        }
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
        queue: [{
          jobId: created.id,
          enqueue: () => (job.type === 'scan' ? enqueueScan(payload) : enqueueClassify(payload)),
          // The credit this retry reserved goes back if its job never reaches the queue.
          release: reserved ? { bidId: job.bidId, documentId: job.documentId } : undefined,
        }],
      };
    });
    await queueAfterCommit(orgId, outcome);
    return reply.code(outcome.code).send(outcome.body);
  });
}

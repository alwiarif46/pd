import { and, eq } from 'drizzle-orm';
import { isUuid, schema, withOrg } from '@pd/core';

export type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

/**
 * The bid, if it belongs to `orgId`. Row-level security already hides other
 * organizations' bids; the explicit `org_id` condition is defense in depth.
 * A malformed id is treated as not found, so callers answer 404 the same way.
 */
export async function findBid(db: Db, orgId: string, bidId: string) {
  if (!isUuid(bidId)) {
    return null;
  }
  const [bid] = await db.select().from(schema.bids).where(and(
    eq(schema.bids.id, bidId),
    eq(schema.bids.orgId, orgId),
  ));
  return bid ?? null;
}

/**
 * What a route decided inside its transaction. The reply goes out, and any queue work
 * runs, only after `withOrg` has committed: a worker never picks up a job whose rows are
 * not visible yet, and the client never hears 201 for a transaction that rolled back.
 */
export interface Outcome {
  code: number;
  body: unknown;
  /** A job row created in the transaction, and the call that queues it. */
  queue?: { jobId: string; enqueue: () => Promise<void> };
}

/**
 * Runs the queue call of a committed outcome. If queueing fails, the job row is marked
 * failed so the user can retry it, and the error propagates (500).
 */
export async function queueAfterCommit(orgId: string, outcome: Outcome): Promise<void> {
  if (!outcome.queue) {
    return;
  }
  const { jobId, enqueue } = outcome.queue;
  try {
    await enqueue();
  } catch (error) {
    await withOrg(orgId, async (db) => {
      await db.update(schema.jobs).set({
        status: 'failed',
        error: 'The step could not be queued. Retry it.',
        updatedAt: new Date(),
      }).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.orgId, orgId)));
    });
    throw error;
  }
}

export async function findDocument(db: Db, orgId: string, documentId: string) {
  if (!isUuid(documentId)) {
    return null;
  }
  const [document] = await db.select().from(schema.documents).where(and(
    eq(schema.documents.id, documentId),
    eq(schema.documents.orgId, orgId),
  ));
  return document ?? null;
}

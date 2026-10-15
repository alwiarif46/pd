import { and, eq, inArray } from 'drizzle-orm';
import { schema, withOrg } from '@pd/core';
import type { JobPayload } from './redis.js';

/**
 * Fails the job when an update by id did not change exactly one row: the row was deleted,
 * belongs to another organization, or the payload is wrong. Without this the update would
 * be lost silently.
 */
export function expectOneRow(what: string, rows: readonly unknown[]): void {
  if (rows.length !== 1) {
    const message = `Expected to update one ${what}, updated ${rows.length}`;
    console.error(message);
    throw new Error(message);
  }
}

/**
 * Marks the job row failed in its own transaction, so it is recorded even when the
 * transaction that failed rolled back. Errors here are logged, not thrown: the caller is
 * already failing the job with the original error.
 */
export async function markJobFailed(payload: JobPayload, error: string): Promise<void> {
  try {
    await withOrg(payload.orgId, async (db) => {
      await db.update(schema.jobs).set({
        status: 'failed',
        error,
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(schema.jobs.id, payload.jobId), eq(schema.jobs.orgId, payload.orgId)));
    });
  } catch (markError) {
    console.error(`Could not mark job ${payload.jobId} failed`, markError);
  }
}

type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

/**
 * The error of the failed classify row that marks an attachment or amendment held because the
 * bid's solicitation holds no credit (06 s4). kickHeldDocuments (kick.ts) looks for it when the
 * solicitation's matrix consumes the credit, and reruns classify for each held file. The user can
 * also retry it from the Processing panel; classify checks the credit again.
 */
export const HELD_FOR_CREDIT = 'Waiting for the solicitation to be processed.';

/**
 * The error of the failed classify row a solicitation's matrix run writes, instead of rows, when
 * the bid's credit was released while it ran (a sibling solicitation failed, for example). The
 * retry reserves a credit again (POST /api/jobs/:id/retry).
 */
export const SOLICITATION_CREDIT_RELEASED = 'The RFP credit for this bid was released before the matrix was built. Retry it.';

/**
 * Records a failed `type` step for the payload's document, inside the caller's transaction. The
 * payload's own job row is failed when it is an unfinished row of that type (a retry, a marking
 * confirm, a kick); a row of that type that already failed keeps its error (the scan step fails
 * its own row first); otherwise a new failed row is inserted, so the Processing panel always shows
 * a step the user can retry.
 *
 * Inserting a job takes FOR KEY SHARE on the organization, the document and the bid (foreign
 * keys): a caller that holds a bid lock must have taken `shareOrg` before it (credits.ts).
 */
export async function failStepIn(db: Db, payload: JobPayload, type: 'scan' | 'classify', error: string): Promise<void> {
  const [own] = await db.select({ status: schema.jobs.status }).from(schema.jobs).where(and(
    eq(schema.jobs.id, payload.jobId),
    eq(schema.jobs.orgId, payload.orgId),
    eq(schema.jobs.type, type),
  ));
  if (own?.status === 'failed') {
    return;
  }
  if (own && own.status !== 'completed') {
    await db.update(schema.jobs).set({
      status: 'failed',
      error,
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(schema.jobs.id, payload.jobId), eq(schema.jobs.orgId, payload.orgId)));
    return;
  }
  await db.insert(schema.jobs).values({
    orgId: payload.orgId,
    bidId: payload.bidId,
    documentId: payload.documentId,
    type,
    status: 'failed',
    error,
    finishedAt: new Date(),
  });
}

/**
 * Marks the classify row this run came from completed, when there is one (a retry, a marking
 * confirm or a kick creates one; an upload's run comes from its scan row, which the scan step
 * closed). Called once classify has queued the AI steps.
 */
export async function completeClassifyJob(payload: JobPayload): Promise<void> {
  await withOrg(payload.orgId, async (db) => {
    await db.update(schema.jobs).set({ status: 'completed', finishedAt: new Date(), updatedAt: new Date() }).where(and(
      eq(schema.jobs.id, payload.jobId),
      eq(schema.jobs.orgId, payload.orgId),
      eq(schema.jobs.type, 'classify'),
      inArray(schema.jobs.status, ['pending', 'running']),
    ));
  });
}

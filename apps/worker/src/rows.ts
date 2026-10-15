import { and, eq } from 'drizzle-orm';
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

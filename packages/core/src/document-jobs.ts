import { sql } from 'drizzle-orm';
import type { AppDatabase } from './db';

/**
 * Takes a document's job lock until the transaction ends: a transaction-scoped advisory lock keyed
 * by the document id. The retry route and the worker's kick of held files take it before any row
 * lock and before they read the document's newest job, so they never both add a job for one file.
 * It is not a row lock: it adds no edge to the row lock order (services/gateway/src/credits.ts). A
 * caller that needs several takes them in document id order.
 */
export async function lockDocumentJobs(db: Pick<AppDatabase, 'execute'>, documentId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`document-jobs:${documentId}`}, 0))`);
}

/**
 * Takes a bid's schedule lock until the transaction ends (an advisory lock keyed by the bid id).
 * The schedule seed and adjust routes and the worker's amendment tabs write (step 8) take it
 * first, before any row lock, so they never interleave: adjust plans its moves from one read of
 * the activities and of the amendment's date change. Not a row lock: it adds no edge to the row
 * lock order (services/gateway/src/credits.ts), as long as every taker takes it before its row locks.
 */
export async function lockBidSchedule(db: Pick<AppDatabase, 'execute'>, bidId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`schedule:${bidId}`}, 0))`);
}

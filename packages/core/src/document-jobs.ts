import { sql } from 'drizzle-orm';
import type { AppDatabase } from './db';

/**
 * Takes a document's job lock until the transaction ends: a transaction-scoped advisory lock keyed
 * by the document id. The retry route and the worker's kick of held files take it before any row
 * lock and before they read the document's newest job, so they never both add a job for one file.
 * It is not a row lock: it adds no edge to the row lock order (apps/api/src/credits.ts). A
 * caller that needs several takes them in document id order.
 */
export async function lockDocumentJobs(db: Pick<AppDatabase, 'execute'>, documentId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`document-jobs:${documentId}`}, 0))`);
}

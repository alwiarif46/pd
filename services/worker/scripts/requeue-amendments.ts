/**
 * One-off for the amendment key check cut-over (01 s6, migration 0008).
 *
 * Before 0008, classify queued `ai:amendment` directly. An amendment whose classify finished
 * before the deploy, but whose `ai:amendment` job had not run, has no `amendments` row: the new
 * `ai:amendment` step skips it (it runs only for a row the key check let through). For each
 * organization given, this finds every amendment document that is not deleted, finished text
 * extraction, is not waiting on a marking confirmation, and has no `amendments` row, and (with
 * --apply) inserts a classify job row and queues it, so the key check runs on it.
 *
 * Dry run by default. Run with the worker's environment (DATABASE_URL as pd_app, REDIS_*):
 *   npx tsx services/worker/scripts/requeue-amendments.ts --org <uuid> [--org <uuid> ...] [--apply]
 * Row-level security shows pd_app one organization at a time, so organizations are named.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { closeDb, schema, withOrg } from '@pd/core';
import { enqueue, getQueue } from '../src/enqueue.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const orgIds = args.flatMap((arg, index) => (arg === '--org' && args[index + 1] ? [args[index + 1]] : []));
if (orgIds.length === 0) {
  console.error('Usage: requeue-amendments.ts --org <uuid> [--org <uuid> ...] [--apply]');
  process.exit(2);
}

let total = 0;
for (const orgId of orgIds) {
  const queued = await withOrg(orgId, async (db) => {
    const documents = await db.select({
      id: schema.documents.id,
      bidId: schema.documents.bidId,
      storagePath: schema.documents.storagePath,
    }).from(schema.documents)
      .leftJoin(schema.amendments, eq(schema.amendments.documentId, schema.documents.id))
      .where(and(
        eq(schema.documents.orgId, orgId),
        eq(schema.documents.kind, 'amendment'),
        eq(schema.documents.extractStatus, 'ready'),
        inArray(schema.documents.markingStatus, ['none', 'confirmed']),
        sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
        isNull(schema.amendments.id),
      ));
    if (!apply) {
      return documents.map((document) => ({ ...document, jobId: null as string | null }));
    }
    const out: { id: string; bidId: string; storagePath: string | null; jobId: string | null }[] = [];
    for (const document of documents) {
      const [job] = await db.insert(schema.jobs).values({
        orgId,
        bidId: document.bidId,
        documentId: document.id,
        type: 'classify',
        status: 'pending',
      }).returning({ id: schema.jobs.id });
      out.push({ ...document, jobId: job.id });
    }
    return out;
  });
  for (const document of queued) {
    total += 1;
    if (!document.jobId) {
      console.log(`[dry run] org ${orgId}: amendment ${document.id} would be rechecked`);
      continue;
    }
    // Queued after COMMIT, so the worker sees the job row.
    await enqueue('classify', {
      orgId,
      bidId: document.bidId,
      documentId: document.id,
      jobId: document.jobId,
      storagePath: document.storagePath ?? '',
      kind: 'amendment',
    });
    console.log(`org ${orgId}: amendment ${document.id} queued (classify job ${document.jobId})`);
  }
}
console.log(`${total} amendment${total === 1 ? '' : 's'} ${apply ? 'queued' : 'found (dry run; add --apply to queue)'}`);
if (apply) {
  await getQueue('classify').close();
}
await closeDb();

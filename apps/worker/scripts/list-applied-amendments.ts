/**
 * One-off for the amendment run cut-over (migration 0009, 04 s3.1).
 *
 * Before 0009 the amendment step wrote links but never inserted the rows an amendment added, so
 * an amendment applied then may be missing its added requirements. This lists, for each
 * organization given, every amendment in `applied` or `needs_confirmation` with its number, its
 * document, whether that document is deleted, how many links it has, and how many compliance
 * rows its document produced (0 for every amendment applied before 0009). It changes nothing;
 * backfill-amendments.ts supplies the missing rows, link rows and quotes (01 s6).
 *
 * Dry run (read-only). Run with the worker's environment (DATABASE_URL as pd_app):
 *   npx tsx apps/worker/scripts/list-applied-amendments.ts --org <uuid> [--org <uuid> ...]
 * Row-level security shows pd_app one organization at a time, so organizations are named.
 */
import { and, count, eq, inArray } from 'drizzle-orm';
import { closeDb, schema, withOrg } from '@pd/core';

const args = process.argv.slice(2);
const orgIds = args.flatMap((arg, index) => (arg === '--org' && args[index + 1] ? [args[index + 1]] : []));
if (orgIds.length === 0) {
  console.error('Usage: list-applied-amendments.ts --org <uuid> [--org <uuid> ...]');
  process.exit(2);
}

let total = 0;
for (const orgId of orgIds) {
  const found = await withOrg(orgId, async (db) => {
    const amendments = await db.select({
      id: schema.amendments.id,
      bidId: schema.amendments.bidId,
      documentId: schema.amendments.documentId,
      amendmentNo: schema.amendments.amendmentNo,
      status: schema.amendments.status,
      liveStatus: schema.documents.liveStatus,
      fileName: schema.documents.fileName,
    }).from(schema.amendments)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.amendments.documentId))
      .where(and(
        eq(schema.amendments.orgId, orgId),
        inArray(schema.amendments.status, ['applied', 'needs_confirmation']),
      ));
    const out = [];
    for (const amendment of amendments) {
      const [links] = await db.select({ n: count() }).from(schema.amendmentLinks).where(and(
        eq(schema.amendmentLinks.amendmentId, amendment.id),
        eq(schema.amendmentLinks.orgId, orgId),
      ));
      const [rows] = await db.select({ n: count() }).from(schema.complianceRows).where(and(
        eq(schema.complianceRows.documentId, amendment.documentId),
        eq(schema.complianceRows.orgId, orgId),
      ));
      out.push({ ...amendment, links: links?.n ?? 0, rows: rows?.n ?? 0 });
    }
    return out;
  });
  for (const item of found) {
    total += 1;
    console.log(`[dry run] org ${orgId} bid ${item.bidId}: Amd ${item.amendmentNo ?? '?'} (${item.fileName}, document ${item.documentId}`
      + `${item.liveStatus === 'deleted' ? ', deleted' : ''}) ${item.status}, ${item.links} link(s), ${item.rows} row(s) from its text`);
  }
}
console.log(`${total} applied amendment${total === 1 ? '' : 's'} listed (dry run; nothing changed, nothing re-run)`);
await closeDb();

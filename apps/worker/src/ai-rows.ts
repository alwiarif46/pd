import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, withOrg } from '@pd/core';
import { shareOrg } from './key-check.js';
import type { JobPayload } from './redis.js';

type Db = Parameters<Parameters<typeof withOrg>[1]>[0];
type FactRow = typeof schema.bidFacts.$inferInsert;
type DateRow = typeof schema.scheduleActivities.$inferInsert;

/**
 * An AI row nobody has touched: not edited (no row_history entry), not superseded, withdrawn or
 * changed by an amendment. Only these are replaced when a document's step runs again.
 */
function untouched(table: typeof schema.bidFacts | typeof schema.scheduleActivities, name: 'bid_facts' | 'schedule_activities') {
  return and(
    eq(table.origin, 'ai'),
    or(isNull(table.supersedeStatus), eq(table.supersedeStatus, 'active')),
    isNull(table.changedByAmendment),
    isNull(table.supersededByRowId),
    sql`not exists (select 1 from row_history h where h.row_table = ${name} and h.row_id = ${table.id})`,
  );
}

/**
 * Locks the document (after the organization key share the inserts need, credits.ts lock order)
 * so two runs of one document's step write one after the other. False when it is gone or deleted:
 * nothing is written for it.
 */
async function lockLiveDocument(db: Db, payload: JobPayload): Promise<boolean> {
  await shareOrg(db, payload.orgId);
  const [document] = await db.select({ liveStatus: schema.documents.liveStatus }).from(schema.documents).where(and(
    eq(schema.documents.id, payload.documentId),
    eq(schema.documents.orgId, payload.orgId),
  )).for('update');
  return Boolean(document) && document.liveStatus !== 'deleted';
}

/** Keeps the first row of each key that no kept row already has. */
function fresh<T>(rows: T[], kept: Set<string>, key: (row: T) => string): T[] {
  const seen = new Set(kept);
  return rows.filter((row) => {
    const k = key(row);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

const factKey = (row: { field: string; sourceQuote?: string | null }) => `${row.field}\u0000${row.sourceQuote ?? ''}`;
const dateKey = (row: { sourcePage?: number | null; sourceQuote?: string | null }) => `${row.sourcePage ?? ''}\u0000${row.sourceQuote ?? ''}`;

/**
 * Writes the overview step's bid facts for a document so a rerun (a retry, a kick of a held file)
 * does not add them twice: the document's untouched AI facts (not confirmed, see untouched) are
 * replaced; a fact a user confirmed, edited, or an amendment changed stays, and a new fact with
 * the same field and quote as a kept one is not added again. User rows are never touched.
 */
export async function replaceDocumentFacts(payload: JobPayload, facts: FactRow[]): Promise<void> {
  await withOrg(payload.orgId, async (db) => {
    if (!await lockLiveDocument(db, payload)) {
      return;
    }
    const mine = and(eq(schema.bidFacts.documentId, payload.documentId), eq(schema.bidFacts.orgId, payload.orgId));
    await db.delete(schema.bidFacts).where(and(mine, eq(schema.bidFacts.confirmed, false), untouched(schema.bidFacts, 'bid_facts')));
    const kept = await db.select({ field: schema.bidFacts.field, sourceQuote: schema.bidFacts.sourceQuote }).from(schema.bidFacts).where(mine);
    const rows = fresh(facts, new Set(kept.map(factKey)), factKey);
    if (rows.length > 0) {
      await db.insert(schema.bidFacts).values(rows);
    }
  });
}

/** The dates step's schedule rows for a document, replaced the same way (key: page and quote). */
export async function replaceDocumentDates(payload: JobPayload, dates: DateRow[]): Promise<void> {
  await withOrg(payload.orgId, async (db) => {
    if (!await lockLiveDocument(db, payload)) {
      return;
    }
    const mine = and(eq(schema.scheduleActivities.documentId, payload.documentId), eq(schema.scheduleActivities.orgId, payload.orgId));
    await db.delete(schema.scheduleActivities).where(and(mine, untouched(schema.scheduleActivities, 'schedule_activities')));
    const kept = await db.select({ sourcePage: schema.scheduleActivities.sourcePage, sourceQuote: schema.scheduleActivities.sourceQuote })
      .from(schema.scheduleActivities).where(mine);
    const rows = fresh(dates, new Set(kept.map(dateKey)), dateKey);
    if (rows.length > 0) {
      await db.insert(schema.scheduleActivities).values(rows);
    }
  });
}

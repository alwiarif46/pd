import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { schema, withOrg } from '@pd/core';
import { shareOrg } from './key-check.js';
import type { JobPayload } from './redis.js';

type Db = Parameters<Parameters<typeof withOrg>[1]>[0];
type FactRow = typeof schema.bidFacts.$inferInsert;
type DateRow = typeof schema.scheduleActivities.$inferInsert;

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

/**
 * The bid's lock, after the document (credits.ts order). Step 8 of an amendment holds it while it
 * writes, so a late solicitation-set row is written before or after it, never in between.
 */
async function lockBid(db: Db, payload: JobPayload): Promise<void> {
  await db.select({ id: schema.bids.id }).from(schema.bids).where(and(
    eq(schema.bids.id, payload.bidId),
    eq(schema.bids.orgId, payload.orgId),
  )).for('update');
}

/** The highest-numbered of `rows` on `key`, or undefined. */
function highestOn(rows: { id: string; key: string; amendmentNo: number }[], key: string | undefined) {
  return rows.filter((row) => row.key === key)
    .sort((a, b) => b.amendmentNo - a.amendmentNo || a.id.localeCompare(b.id))[0];
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
 * does not add them twice. Insert-only: a fact whose field and quote the document already has is
 * not added again, and no existing row is ever deleted or changed, since users edit, confirm and
 * lock these rows and not every edit path records row history. Under the document lock, so two
 * runs of one document write one after the other.
 */
export async function writeDocumentFacts(payload: JobPayload, facts: FactRow[]): Promise<void> {
  await withOrg(payload.orgId, async (db) => {
    if (!await lockLiveDocument(db, payload)) {
      return;
    }
    const kept = await db.select({ field: schema.bidFacts.field, sourceQuote: schema.bidFacts.sourceQuote }).from(schema.bidFacts)
      .where(and(eq(schema.bidFacts.documentId, payload.documentId), eq(schema.bidFacts.orgId, payload.orgId)));
    const rows = fresh(facts, new Set(kept.map(factKey)), factKey);
    // A file of the solicitation set that ran late (after an amendment's step 8 wrote the key):
    // its fact is inserted already superseded by the amendment's, as step 8 does for an amendment
    // that finishes out of order (packages/core amendment-tabs.ts).
    const keys = [...new Set(rows.flatMap((row) => (row.factKey && row.factKey !== 'other' ? [row.factKey] : [])))];
    if (keys.length > 0) {
      await lockBid(db, payload);
      const t = schema.bidFacts;
      const amended = await db.select({ id: t.id, key: t.factKey, amendmentNo: t.amendmentNo }).from(t).where(and(
        eq(t.bidId, payload.bidId),
        eq(t.orgId, payload.orgId),
        inArray(t.factKey, keys),
        gt(t.amendmentNo, 0),
        or(isNull(t.supersedeStatus), eq(t.supersedeStatus, 'active')),
      )).orderBy(asc(t.id));
      for (const row of rows) {
        const top = highestOn(amended, row.factKey);
        if (top && (row.amendmentNo ?? 0) < top.amendmentNo) {
          Object.assign(row, { supersedeStatus: 'superseded', supersededByRowId: top.id, changedByAmendment: top.amendmentNo });
        }
      }
    }
    if (rows.length > 0) {
      await db.insert(schema.bidFacts).values(rows);
    }
  });
}

/** The dates step's schedule rows for a document, written the same way (key: page and quote). */
export async function writeDocumentDates(payload: JobPayload, dates: DateRow[]): Promise<void> {
  await withOrg(payload.orgId, async (db) => {
    if (!await lockLiveDocument(db, payload)) {
      return;
    }
    const kept = await db.select({ sourcePage: schema.scheduleActivities.sourcePage, sourceQuote: schema.scheduleActivities.sourceQuote })
      .from(schema.scheduleActivities)
      .where(and(eq(schema.scheduleActivities.documentId, payload.documentId), eq(schema.scheduleActivities.orgId, payload.orgId)));
    const rows = fresh(dates, new Set(kept.map(dateKey)), dateKey);
    // A late file's keyed date, after an amendment's step 8 wrote the key: inserted superseded.
    const keys = [...new Set(rows.flatMap((row) => (row.dateKey && row.dateKey !== 'other' ? [row.dateKey] : [])))];
    if (keys.length > 0) {
      await lockBid(db, payload);
      const t = schema.scheduleActivities;
      const amended = await db.select({ id: t.id, key: t.dateKey, amendmentNo: t.amendmentNo }).from(t).where(and(
        eq(t.bidId, payload.bidId),
        eq(t.orgId, payload.orgId),
        inArray(t.dateKey, keys),
        gt(t.amendmentNo, 0),
        or(isNull(t.supersedeStatus), eq(t.supersedeStatus, 'active')),
      )).orderBy(asc(t.id));
      for (const row of rows) {
        const top = highestOn(amended, row.dateKey);
        if (top && (row.amendmentNo ?? 0) < top.amendmentNo) {
          Object.assign(row, { supersedeStatus: 'superseded', supersededByRowId: top.id, changedByAmendment: top.amendmentNo });
        }
      }
    }
    if (rows.length > 0) {
      await db.insert(schema.scheduleActivities).values(rows);
    }
  });
}

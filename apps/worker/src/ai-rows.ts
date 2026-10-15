import { and, eq } from 'drizzle-orm';
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
    if (rows.length > 0) {
      await db.insert(schema.scheduleActivities).values(rows);
    }
  });
}

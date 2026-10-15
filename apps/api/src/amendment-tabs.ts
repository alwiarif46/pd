import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { PROPOSED, readDateChange, schema, toIsoDate } from '@pd/core';
import type { Db } from './scope.js';

/*
 * Amendment step 8 in the api (PR5): the proposals an amendment made on the bid facts and the
 * schedule (rows with supersede_status 'proposed', each behind a proposed supersede link), the
 * pending date change of the schedule tab, and the row removal and confirm rules for those tabs.
 * The worker writes them (apps/worker/src/amendment-tabs-job.ts); packages/core amendment-tabs.ts
 * has the rules.
 */

/** The row tables step 8 writes. */
export type TabRowTable = 'bid_facts' | 'schedule_activities';

export function isTabRowTable(value: string): value is TabRowTable {
  return value === 'bid_facts' || value === 'schedule_activities';
}

type FactRow = typeof schema.bidFacts.$inferSelect;
type ActivityRow = typeof schema.scheduleActivities.$inferSelect;

/**
 * An open proposal: the replacement an amendment proposes for a row a user touched. `row` is the
 * proposed row (not in the tab's list until inserted); "Insert" confirms the link
 * (POST /api/amendment-links/:linkId/confirm), "Dismiss" rejects it.
 */
export interface TabProposal<T> {
  linkId: string;
  amendmentId: string;
  amendmentNo: number | null;
  /** The row it would replace (null when that row was removed meanwhile). */
  oldRowId: string | null;
  sourcePage: number | null;
  sourceQuote: string | null;
  row: T;
}

/** The open proposals on one of the bid's tab tables, oldest amendment first. */
export async function tabProposals(db: Db, orgId: string, bidId: string, table: 'bid_facts'): Promise<TabProposal<FactRow>[]>;
export async function tabProposals(db: Db, orgId: string, bidId: string, table: 'schedule_activities'): Promise<TabProposal<ActivityRow>[]>;
export async function tabProposals(db: Db, orgId: string, bidId: string, table: TabRowTable): Promise<TabProposal<FactRow | ActivityRow>[]> {
  const links = await db.select({
    linkId: schema.amendmentLinks.id,
    amendmentId: schema.amendmentLinks.amendmentId,
    amendmentNo: schema.amendments.amendmentNo,
    oldRowId: schema.amendmentLinks.oldRowId,
    newRowId: schema.amendmentLinks.newRowId,
    sourcePage: schema.amendmentLinks.sourcePage,
    sourceQuote: schema.amendmentLinks.sourceQuote,
  }).from(schema.amendmentLinks)
    .innerJoin(schema.amendments, eq(schema.amendments.id, schema.amendmentLinks.amendmentId))
    .where(and(
      eq(schema.amendmentLinks.orgId, orgId),
      eq(schema.amendments.orgId, orgId),
      eq(schema.amendments.bidId, bidId),
      eq(schema.amendmentLinks.rowTable, table),
      eq(schema.amendmentLinks.status, 'proposed'),
      isNotNull(schema.amendmentLinks.newRowId),
    ))
    .orderBy(asc(schema.amendments.amendmentNo), asc(schema.amendmentLinks.createdAt), asc(schema.amendmentLinks.id));
  const ids = [...new Set(links.map((link) => link.newRowId!))];
  if (ids.length === 0) {
    return [];
  }
  const rows: (FactRow | ActivityRow)[] = table === 'bid_facts'
    ? await db.select().from(schema.bidFacts).where(and(
      inArray(schema.bidFacts.id, ids), eq(schema.bidFacts.bidId, bidId), eq(schema.bidFacts.orgId, orgId),
    ))
    : await db.select().from(schema.scheduleActivities).where(and(
      inArray(schema.scheduleActivities.id, ids), eq(schema.scheduleActivities.bidId, bidId), eq(schema.scheduleActivities.orgId, orgId),
    ));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return links.flatMap((link) => {
    const row = byId.get(link.newRowId!);
    // A row inserted by a sibling link's confirm is in the tab already; only proposed rows are offered.
    if (!row || row.supersedeStatus !== PROPOSED) {
      return [];
    }
    return [{
      linkId: link.linkId,
      amendmentId: link.amendmentId,
      amendmentNo: link.amendmentNo,
      oldRowId: link.oldRowId,
      sourcePage: link.sourcePage,
      sourceQuote: link.sourceQuote,
      row,
    }];
  });
}

/** The schedule tab's pending date change (09 s5.11): an amendment moved the proposal due date. */
export interface PendingDateChange {
  amendmentId: string;
  amendmentNo: number | null;
  /**
   * The bid's due date in force now, the one the schedule moves from (the amendment's previousDue
   * when the bid has none); null when neither has one (then only keep applies).
   */
  previousDue: string | null;
  nextDue: string;
  sourcePage: number | null;
  sourceQuote: string | null;
}

/**
 * The unresolved date change of the bid's highest-numbered amendment whose document is not
 * deleted, or null; null too when the bid's due date is already its nextDue (set in Bid settings).
 * Answering it (POST /schedule/adjust with its amendmentId) resolves it and every lower one.
 */
export async function pendingDateChange(db: Db, orgId: string, bid: { id: string; dueDate: Date | null }): Promise<PendingDateChange | null> {
  const bidId = bid.id;
  const currentDue = bid.dueDate ? toIsoDate(bid.dueDate) : null;
  const rows = await db.select({
    id: schema.amendments.id,
    amendmentNo: schema.amendments.amendmentNo,
    datesChanged: schema.amendments.datesChanged,
  }).from(schema.amendments)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.amendments.documentId))
    .where(and(
      eq(schema.amendments.orgId, orgId),
      eq(schema.amendments.bidId, bidId),
      eq(schema.documents.orgId, orgId),
      isNotNull(schema.amendments.datesChanged),
      sql`${schema.amendments.datesChanged}->>'resolvedAt' is null`,
      sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
    ))
    .orderBy(sql`${schema.amendments.amendmentNo} desc nulls last`, desc(schema.amendments.createdAt));
  for (const row of rows) {
    const change = readDateChange(row.datesChanged);
    if (change && change.resolvedAt === null) {
      if (change.nextDue === currentDue) {
        return null;
      }
      return {
        amendmentId: row.id,
        amendmentNo: row.amendmentNo,
        previousDue: currentDue ?? change.previousDue,
        nextDue: change.nextDue,
        sourcePage: change.sourcePage,
        sourceQuote: change.sourceQuote,
      };
    }
  }
  return null;
}

/**
 * Before fact or activity rows are removed (row delete, a schedule template replace): a proposal
 * that would bring a removed row in can no longer be inserted, so it becomes 'rejected' (and an
 * amendment left with no proposal is applied); a row the removed row replaced stays 'superseded'
 * with no pointer. The caller holds the bid. Lock order: amendments (by id), their links, rows.
 */
export async function detachTabRows(db: Db, orgId: string, table: TabRowTable, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) {
    return;
  }
  const proposed = await db.select({ amendmentId: schema.amendmentLinks.amendmentId }).from(schema.amendmentLinks).where(and(
    inArray(schema.amendmentLinks.newRowId, rowIds),
    eq(schema.amendmentLinks.orgId, orgId),
    eq(schema.amendmentLinks.rowTable, table),
    eq(schema.amendmentLinks.status, 'proposed'),
  ));
  const amendmentIds = [...new Set(proposed.map((link) => link.amendmentId))].sort();
  const now = new Date();
  if (amendmentIds.length > 0) {
    await db.select({ id: schema.amendments.id }).from(schema.amendments).where(and(
      inArray(schema.amendments.id, amendmentIds),
      eq(schema.amendments.orgId, orgId),
    )).orderBy(asc(schema.amendments.id)).for('update');
    await db.update(schema.amendmentLinks).set({ status: 'rejected', updatedAt: now }).where(and(
      inArray(schema.amendmentLinks.newRowId, rowIds),
      eq(schema.amendmentLinks.orgId, orgId),
      eq(schema.amendmentLinks.rowTable, table),
      eq(schema.amendmentLinks.status, 'proposed'),
    ));
    for (const amendmentId of amendmentIds) {
      const [open] = await db.select({ id: schema.amendmentLinks.id }).from(schema.amendmentLinks).where(and(
        eq(schema.amendmentLinks.amendmentId, amendmentId),
        eq(schema.amendmentLinks.orgId, orgId),
        eq(schema.amendmentLinks.status, 'proposed'),
      )).limit(1);
      if (!open) {
        await db.update(schema.amendments).set({ status: 'applied', updatedAt: now }).where(and(
          eq(schema.amendments.id, amendmentId),
          eq(schema.amendments.orgId, orgId),
          eq(schema.amendments.status, 'needs_confirmation'),
        ));
      }
    }
  }
  if (table === 'bid_facts') {
    await db.update(schema.bidFacts).set({ supersededByRowId: null, updatedAt: now }).where(and(
      inArray(schema.bidFacts.supersededByRowId, rowIds),
      eq(schema.bidFacts.orgId, orgId),
    ));
  } else {
    await db.update(schema.scheduleActivities).set({ supersededByRowId: null, updatedAt: now }).where(and(
      inArray(schema.scheduleActivities.supersededByRowId, rowIds),
      eq(schema.scheduleActivities.orgId, orgId),
    ));
  }
}

type SupersedeState = { id: string; supersedeStatus: string | null; supersededByRowId: string | null; changedByAmendment: number | null };

/** The rows by id, FOR UPDATE in id order (the caller holds the bid, the amendment, and the link). */
async function lockRows(db: Db, orgId: string, bidId: string, table: TabRowTable, ids: string[]): Promise<SupersedeState[]> {
  const t = table === 'bid_facts' ? schema.bidFacts : schema.scheduleActivities;
  return db.select({
    id: t.id,
    supersedeStatus: t.supersedeStatus,
    supersededByRowId: t.supersededByRowId,
    changedByAmendment: t.changedByAmendment,
  }).from(t).where(and(inArray(t.id, ids), eq(t.bidId, bidId), eq(t.orgId, orgId))).orderBy(asc(t.id)).for('update');
}

async function setSupersede(db: Db, orgId: string, table: TabRowTable, id: string, next: Omit<SupersedeState, 'id'>, now: Date): Promise<void> {
  const set = { ...next, supersedeStatus: next.supersedeStatus as 'active' | 'superseded', updatedAt: now };
  if (table === 'bid_facts') {
    await db.update(schema.bidFacts).set(set).where(and(eq(schema.bidFacts.id, id), eq(schema.bidFacts.orgId, orgId)));
  } else {
    await db.update(schema.scheduleActivities).set(set).where(and(eq(schema.scheduleActivities.id, id), eq(schema.scheduleActivities.orgId, orgId)));
  }
}

/**
 * Confirm ("Insert") of a proposed supersede link on a tab table, under the caller's locks
 * (organization key share, bid, amendment, link). The proposed row joins the tab (active) and the
 * row it replaces becomes superseded by it (changed_by_amendment N); both changes go to row
 * history. 'new_row_missing' when the proposed row is gone; 'row_already_closed' when the old row
 * is still there but no longer active (another change replaced it first). An old row the user
 * removed meanwhile does not block the insert.
 */
export async function confirmTabLink(
  db: Db,
  orgId: string,
  userId: string,
  bidId: string,
  table: TabRowTable,
  link: { oldRowId: string | null; newRowId: string | null },
  amendmentNo: number | null,
): Promise<'ok' | 'new_row_missing' | 'row_already_closed'> {
  if (!link.newRowId) {
    return 'new_row_missing';
  }
  const ids = [link.newRowId, ...(link.oldRowId ? [link.oldRowId] : [])];
  const rows = await lockRows(db, orgId, bidId, table, ids);
  const fresh = rows.find((row) => row.id === link.newRowId);
  const old = link.oldRowId ? rows.find((row) => row.id === link.oldRowId) : undefined;
  if (!fresh || (fresh.supersedeStatus !== PROPOSED && fresh.supersedeStatus !== 'active' && fresh.supersedeStatus !== null)) {
    return 'new_row_missing';
  }
  if (old && old.supersedeStatus !== null && old.supersedeStatus !== 'active') {
    return 'row_already_closed';
  }
  const now = new Date();
  const changes: { rowId: string; field: string; oldValue: string | null; newValue: string | null }[] = [];
  if (fresh.supersedeStatus === PROPOSED) {
    await setSupersede(db, orgId, table, fresh.id, { supersedeStatus: 'active', supersededByRowId: null, changedByAmendment: null }, now);
    changes.push({ rowId: fresh.id, field: 'supersede_status', oldValue: PROPOSED, newValue: 'active' });
  }
  if (old) {
    const next = { supersedeStatus: 'superseded', supersededByRowId: fresh.id, changedByAmendment: amendmentNo };
    await setSupersede(db, orgId, table, old.id, next, now);
    const history = ([
      ['supersede_status', old.supersedeStatus ?? 'active', next.supersedeStatus],
      ['superseded_by_row_id', old.supersededByRowId, next.supersededByRowId],
      ['changed_by_amendment', old.changedByAmendment === null ? null : String(old.changedByAmendment),
        next.changedByAmendment === null ? null : String(next.changedByAmendment)],
    ] as const).filter(([, before, after]) => before !== after);
    changes.push(...history.map(([field, oldValue, newValue]) => ({ rowId: old.id, field, oldValue, newValue })));
  }
  if (changes.length > 0) {
    await db.insert(schema.rowHistory).values(changes.map((change) => ({
      orgId, rowTable: table, userId, changedAt: now, ...change,
    })));
  }
  return 'ok';
}

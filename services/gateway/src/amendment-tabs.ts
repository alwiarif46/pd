import { and, asc, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { PROPOSED, readDateChange, schema, toIsoDate } from '@pd/core';
import type { Db } from './scope.js';

/*
 * Amendment step 8 in the api (PR5): the proposals an amendment made on the bid facts and the
 * schedule (rows with supersede_status 'proposed', each behind a proposed supersede link), the
 * pending date change of the schedule tab, and the row removal and confirm rules for those tabs.
 * The worker writes them (services/worker/src/amendment-tabs-job.ts); packages/core amendment-tabs.ts
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
 * An open proposal: the replacement an amendment proposes on a key where a user touched a row.
 * `row` is the proposed row (not in the tab's list until inserted). It has one proposed link per
 * row it would replace; "Insert" (POST /api/amendment-links/:linkId/confirm, any of `linkIds`)
 * and "Dismiss" (/reject) decide them all at once.
 */
export interface TabProposal<T> {
  /** The link to confirm or reject (the first of `linkIds`). */
  linkId: string;
  linkIds: string[];
  amendmentId: string;
  amendmentNo: number | null;
  /** The active rows it would replace, touched or not (one removed meanwhile is left out). */
  oldRowIds: string[];
  sourcePage: number | null;
  sourceQuote: string | null;
  row: T;
}

/**
 * The open proposals on one of the bid's tab tables, oldest amendment first: one per proposed row,
 * leaving out rows whose amendment's document was deleted (as pendingDateChange does).
 */
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
    .innerJoin(schema.documents, eq(schema.documents.id, schema.amendments.documentId))
    .where(and(
      eq(schema.amendmentLinks.orgId, orgId),
      eq(schema.amendments.orgId, orgId),
      eq(schema.documents.orgId, orgId),
      eq(schema.amendments.bidId, bidId),
      eq(schema.amendmentLinks.rowTable, table),
      eq(schema.amendmentLinks.status, 'proposed'),
      isNotNull(schema.amendmentLinks.newRowId),
      sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
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
  const oldIds = [...new Set(links.flatMap((link) => (link.oldRowId ? [link.oldRowId] : [])))];
  const present = new Set(oldIds.length === 0 ? [] : (table === 'bid_facts'
    ? await db.select({ id: schema.bidFacts.id }).from(schema.bidFacts).where(and(inArray(schema.bidFacts.id, oldIds), eq(schema.bidFacts.orgId, orgId)))
    : await db.select({ id: schema.scheduleActivities.id }).from(schema.scheduleActivities)
      .where(and(inArray(schema.scheduleActivities.id, oldIds), eq(schema.scheduleActivities.orgId, orgId)))).map((row) => row.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const proposals = new Map<string, TabProposal<FactRow | ActivityRow>>();
  for (const link of links) {
    const row = byId.get(link.newRowId!);
    if (!row || row.supersedeStatus !== PROPOSED) {
      continue;
    }
    const proposal = proposals.get(row.id) ?? {
      linkId: link.linkId,
      linkIds: [],
      amendmentId: link.amendmentId,
      amendmentNo: link.amendmentNo,
      oldRowIds: [],
      sourcePage: link.sourcePage,
      sourceQuote: link.sourceQuote,
      row,
    };
    proposal.linkIds.push(link.linkId);
    if (link.oldRowId && present.has(link.oldRowId)) {
      proposal.oldRowIds.push(link.oldRowId);
    }
    proposals.set(row.id, proposal);
  }
  return [...proposals.values()];
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
 * The decision on a proposed supersede link of a tab table, under the caller's locks
 * (organization key share, bid, amendment, the clicked link). A proposed row is one proposal with
 * a link per row it would replace, so the decision covers all of them: the row's other proposed
 * links are locked (by id) and decided the same way.
 * - Confirm ("Insert"): the proposed row joins the tab (active) and every row it replaces that is
 *   still there becomes superseded by it (changed_by_amendment N), with row history.
 *   'new_row_missing' when the proposed row is gone; 'row_already_closed' when one of the old rows
 *   is still there but no longer active (another change replaced it first); nothing changes then.
 *   An old row the user removed meanwhile does not block the insert.
 * - Reject ("Dismiss"): the links are rejected; the rows stay as they are (the proposed row stays
 *   'proposed' and is never listed).
 * The caller updates the clicked link and the amendment's status.
 */
export async function decideTabLink(
  db: Db,
  orgId: string,
  userId: string,
  bidId: string,
  table: TabRowTable,
  link: { id: string; newRowId: string | null },
  status: 'confirmed' | 'rejected',
  amendmentNo: number | null,
): Promise<'ok' | 'new_row_missing' | 'row_already_closed'> {
  if (!link.newRowId) {
    return status === 'rejected' ? 'ok' : 'new_row_missing';
  }
  const siblings = await db.select({ id: schema.amendmentLinks.id, oldRowId: schema.amendmentLinks.oldRowId })
    .from(schema.amendmentLinks).where(and(
      eq(schema.amendmentLinks.newRowId, link.newRowId),
      eq(schema.amendmentLinks.orgId, orgId),
      eq(schema.amendmentLinks.rowTable, table),
      eq(schema.amendmentLinks.status, 'proposed'),
    )).orderBy(asc(schema.amendmentLinks.id)).for('update');
  const now = new Date();
  if (status === 'confirmed') {
    const oldIds = [...new Set(siblings.flatMap((sibling) => (sibling.oldRowId ? [sibling.oldRowId] : [])))];
    const rows = await lockRows(db, orgId, bidId, table, [link.newRowId, ...oldIds]);
    const fresh = rows.find((row) => row.id === link.newRowId);
    if (!fresh || (fresh.supersedeStatus !== PROPOSED && fresh.supersedeStatus !== 'active' && fresh.supersedeStatus !== null)) {
      return 'new_row_missing';
    }
    const olds = rows.filter((row) => row.id !== fresh.id);
    if (olds.some((old) => old.supersedeStatus !== null && old.supersedeStatus !== 'active')) {
      return 'row_already_closed';
    }
    const changes: { rowId: string; field: string; oldValue: string | null; newValue: string | null }[] = [];
    if (fresh.supersedeStatus === PROPOSED) {
      await setSupersede(db, orgId, table, fresh.id, { supersedeStatus: 'active', supersededByRowId: null, changedByAmendment: null }, now);
      changes.push({ rowId: fresh.id, field: 'supersede_status', oldValue: PROPOSED, newValue: 'active' });
    }
    for (const old of olds) {
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
  }
  const others = siblings.filter((sibling) => sibling.id !== link.id).map((sibling) => sibling.id);
  if (others.length > 0) {
    await db.update(schema.amendmentLinks).set({ status, decidedBy: userId, updatedAt: now })
      .where(and(inArray(schema.amendmentLinks.id, others), eq(schema.amendmentLinks.orgId, orgId)));
  }
  return 'ok';
}

/**
 * PATCH of an amendment's number, for the tab rows step 8 wrote (inside the caller's
 * transaction, after its compliance rows; it holds the document, the bid, and the amendment):
 * amendment_no of the fact and activity rows the amendment added (document = the amendment), and
 * changed_by_amendment of the rows they replace (superseded_by_row_id one of them), each with a
 * row_history entry. Rows are locked by id, facts first. The supersede choices step 8 made are
 * kept: a number moved past another amendment's does not re-decide which row is in force.
 * updated_at is left alone: step 8 reads a moved updated_at as a user's edit (a touched row), and
 * a new number is not an edit of the row.
 */
export async function renumberTabRows(
  db: Db,
  orgId: string,
  userId: string,
  bidId: string,
  documentId: string,
  amendmentNo: number,
  now: Date,
): Promise<void> {
  for (const table of ['bid_facts', 'schedule_activities'] as const) {
    const t = table === 'bid_facts' ? schema.bidFacts : schema.scheduleActivities;
    const added = await db.select({ id: t.id }).from(t).where(and(
      eq(t.bidId, bidId),
      eq(t.orgId, orgId),
      eq(t.documentId, documentId),
    ));
    const addedIds = added.map((row) => row.id);
    if (addedIds.length === 0) {
      continue;
    }
    const rows = await db.select({
      id: t.id,
      documentId: t.documentId,
      amendmentNo: t.amendmentNo,
      changedByAmendment: t.changedByAmendment,
      supersededByRowId: t.supersededByRowId,
    }).from(t).where(and(
      eq(t.bidId, bidId),
      eq(t.orgId, orgId),
      or(inArray(t.id, addedIds), inArray(t.supersededByRowId, addedIds)),
    )).orderBy(asc(t.id)).for('update');
    const history: (typeof schema.rowHistory.$inferInsert)[] = [];
    const addedSet = new Set(addedIds);
    for (const row of rows) {
      const change: { amendmentNo?: number; changedByAmendment?: number } = {};
      if (addedSet.has(row.id) && row.amendmentNo > 0 && row.amendmentNo !== amendmentNo) {
        change.amendmentNo = amendmentNo;
        history.push({ orgId, rowTable: table, rowId: row.id, userId, field: 'amendment_no', oldValue: String(row.amendmentNo), newValue: String(amendmentNo), changedAt: now });
      }
      if (row.supersededByRowId && addedSet.has(row.supersededByRowId) && row.changedByAmendment !== amendmentNo) {
        change.changedByAmendment = amendmentNo;
        history.push({
          orgId, rowTable: table, rowId: row.id, userId, field: 'changed_by_amendment',
          oldValue: row.changedByAmendment === null ? null : String(row.changedByAmendment), newValue: String(amendmentNo), changedAt: now,
        });
      }
      if (Object.keys(change).length === 0) {
        continue;
      }
      if (table === 'bid_facts') {
        await db.update(schema.bidFacts).set(change).where(and(eq(schema.bidFacts.id, row.id), eq(schema.bidFacts.orgId, orgId)));
      } else {
        await db.update(schema.scheduleActivities).set(change)
          .where(and(eq(schema.scheduleActivities.id, row.id), eq(schema.scheduleActivities.orgId, orgId)));
      }
    }
    if (history.length > 0) {
      await db.insert(schema.rowHistory).values(history);
    }
  }
}

/**
 * Bid settings set the due date to `due` (PATCH /api/bids/:id, under its bid lock): an open
 * amendment date change whose nextDue is that date is answered by it, and so is every lower
 * amendment's open change (outdated by it), so none of them resurfaces later and moves the due
 * date back. resolvedMode 'settings'. A date no change names resolves nothing.
 */
export async function resolveDateChangesForDue(db: Db, orgId: string, bidId: string, due: string, now: Date): Promise<void> {
  const open = await db.select({ id: schema.amendments.id, amendmentNo: schema.amendments.amendmentNo, datesChanged: schema.amendments.datesChanged })
    .from(schema.amendments).where(and(
      eq(schema.amendments.bidId, bidId),
      eq(schema.amendments.orgId, orgId),
      isNotNull(schema.amendments.datesChanged),
      sql`${schema.amendments.datesChanged}->>'resolvedAt' is null`,
    ));
  const matching = open.filter((row) => readDateChange(row.datesChanged)?.nextDue === due);
  if (matching.length === 0) {
    return;
  }
  const top = Math.max(...matching.map((row) => row.amendmentNo ?? 0));
  const ids = open.filter((row) => matching.includes(row) || (row.amendmentNo ?? 0) < top).map((row) => row.id);
  const resolved = JSON.stringify({ resolvedAt: now.toISOString(), resolvedMode: 'settings' });
  await db.update(schema.amendments).set({
    datesChanged: sql`${schema.amendments.datesChanged} || ${resolved}::jsonb`,
    updatedAt: now,
  }).where(and(inArray(schema.amendments.id, ids), eq(schema.amendments.orgId, orgId)));
}

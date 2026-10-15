import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { costOf, preScan, type DateHit } from '@pd/ai';
import {
  factKeyOf,
  lockBidSchedule,
  planTabSupersede,
  queueJobId,
  schema,
  toIsoDate,
  withOrg,
  type DateChange,
  type TabPlan,
} from '@pd/core';
import { aiDateRow, chunks, type Db, extractBidFacts, loadPages, recordRun } from './ai-jobs.js';
import { enqueue } from './enqueue.js';
import { shareOrg } from './key-check.js';
import type { JobPayload } from './redis.js';

/** The queue of amendment step 8: the bid facts and dates an amendment changes (04 s3.1). */
export const AMENDMENT_TABS_QUEUE = 'ai:amendment-tabs';

type DocumentRow = Pick<typeof schema.documents.$inferSelect, 'liveStatus'>;
type BidRow = Pick<typeof schema.bids.$inferSelect, 'creditStatus' | 'dueDate'>;
type AmendmentRow = typeof schema.amendments.$inferSelect;
type Gate = 'run' | 'no_credit' | 'stopped';
type FactInsert = typeof schema.bidFacts.$inferInsert;
type DateInsert = typeof schema.scheduleActivities.$inferInsert;
type LinkInsert = typeof schema.amendmentLinks.$inferInsert;

const STEP_FAILED = "The amendment's bid facts and dates could not be updated. Retry it.";
const QUEUE_FAILED = "The amendment's bid facts and dates could not be queued. Retry it.";
const NO_CREDIT = "The solicitation has no RFP credit, so the amendment's bid facts and dates cannot be updated. Process the solicitation again, then retry.";

/**
 * Whether step 8 may write now: the document is live, the amendment's compliance apply is done
 * (applied or needs_confirmation), it has a number, and step 8 is still pending (the exactly-once
 * gate: retries, duplicate jobs and reruns find it applied). The bid's credit must be consumed;
 * one released meanwhile fails step 8 visibly (no_credit).
 */
function gate(document: DocumentRow | undefined, bid: BidRow | undefined, amendment: AmendmentRow | undefined): Gate {
  if (!document || document.liveStatus === 'deleted' || !bid || !amendment) {
    return 'stopped';
  }
  if (amendment.tabsStatus !== 'pending' || amendment.amendmentNo === null
    || (amendment.status !== 'applied' && amendment.status !== 'needs_confirmation')) {
    return 'stopped';
  }
  return bid.creditStatus === 'consumed' ? 'run' : 'no_credit';
}

/** Reads (with `lock`: locks, in the order document, bid, amendment) what the gate needs. */
async function readGate(db: Db, payload: JobPayload, lock: boolean): Promise<{ gate: Gate; bid?: BidRow; amendment?: AmendmentRow }> {
  const documentQuery = db.select({ liveStatus: schema.documents.liveStatus }).from(schema.documents).where(and(
    eq(schema.documents.id, payload.documentId),
    eq(schema.documents.orgId, payload.orgId),
  ));
  const [document] = lock ? await documentQuery.for('update') : await documentQuery;
  if (!document || document.liveStatus === 'deleted') {
    return { gate: 'stopped' };
  }
  const bidQuery = db.select({ creditStatus: schema.bids.creditStatus, dueDate: schema.bids.dueDate }).from(schema.bids)
    .where(and(eq(schema.bids.id, payload.bidId), eq(schema.bids.orgId, payload.orgId)));
  const [bid] = lock ? await bidQuery.for('update') : await bidQuery;
  const amendmentQuery = db.select().from(schema.amendments).where(and(
    eq(schema.amendments.documentId, payload.documentId),
    eq(schema.amendments.orgId, payload.orgId),
    eq(schema.amendments.bidId, payload.bidId),
  ));
  const [amendment] = lock ? await amendmentQuery.for('update') : await amendmentQuery;
  return { gate: gate(document, bid, amendment), bid, amendment };
}

/** One hit per page and sentence (a sentence repeated on a page is one date). */
function uniqueHits(hits: DateHit[]): DateHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.pageNo}\u0000${hit.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function keysOf(keys: string[]): string[] {
  return [...new Set(keys.filter((key) => key !== 'other'))];
}

/** The supersede columns of a new row from its plan entry. */
function closedBy(plan: TabPlan): Pick<FactInsert, 'supersedeStatus' | 'supersededByRowId' | 'changedByAmendment'> {
  if (plan.status === 'superseded') {
    return { supersedeStatus: 'superseded', supersededByRowId: plan.supersededBy!.id, changedByAmendment: plan.supersededBy!.amendmentNo };
  }
  return { supersedeStatus: plan.status === 'proposed' ? 'proposed' : 'active', supersededByRowId: null, changedByAmendment: null };
}

/**
 * The links of one new row: an auto supersede per row it closes, a proposed supersede per touched
 * row it would replace, and an always-auto add when it replaces nothing (03 s3.3). Supersede links
 * carry the new row's quote, the amendment text behind the change.
 */
function linksOf(amendmentId: string, orgId: string, rowTable: string, plan: TabPlan, newRowId: string, source: { sourcePage: number | null; sourceQuote: string | null }): LinkInsert[] {
  const supersede = (oldRowId: string, status: 'auto' | 'proposed'): LinkInsert => ({
    orgId, amendmentId, rowTable, oldRowId, newRowId, action: 'supersede', confidence: null, status,
    sourcePage: source.sourcePage, sourceQuote: source.sourceQuote,
  });
  const links = [...plan.closes.map((id) => supersede(id, 'auto')), ...plan.proposes.map((id) => supersede(id, 'proposed'))];
  if (links.length === 0) {
    links.push({ orgId, amendmentId, rowTable, oldRowId: null, newRowId, action: 'add', confidence: null, status: 'auto', sourcePage: null, sourceQuote: null });
  }
  return links;
}

export type TabsOutcome = 'applied' | 'stopped';

/**
 * Amendment step 8 (04 s3.1, PR5): the bid facts and schedule dates of an amendment whose
 * compliance apply is done. The paid tabs have no AI skills yet, so only these two run.
 *
 * A. Pre-check, no locks: anything but `run` returns with nothing spent.
 * B. AI work outside any transaction: the bid-summary skill on the amendment's pages, keeping the
 *    facts whose quote is found on them; the date sentences of the pre-scan, each keyed and dated
 *    in code (classifyDateHit).
 * C. One write transaction. Lock order: the bid's schedule lock (advisory, first, as seed and
 *    adjust take it), organization (key share), document, bid, amendment, then the bid's active
 *    facts and activities on the keys found (by id, facts first). Everything in A is checked again
 *    under the locks and N is read from the locked amendment. planTabSupersede decides each row:
 *    untouched AI rows on its key are superseded (changed_by_amendment N, an auto link), a row a
 *    user touched gets a proposed replacement (supersede_status 'proposed', a proposed link: the
 *    user inserts it), a higher amendment's row makes the new row superseded on insert, 'other'
 *    rows and rows replacing nothing are added (an auto add link), and a restatement is skipped.
 *    A new proposal due date that differs from the bid's due date is recorded in dates_changed
 *    (the date-change prompt applies it; the bid's due date is never changed here). tabs_status
 *    becomes applied, and the amendment needs_confirmation when a proposal was written.
 * D. On a failure in B or C, tabs_status pending -> failed with a failed classify job row; the
 *    retry reruns classify, whose key check queues step 8 again (key-check.ts).
 */
export async function processAmendmentTabsJob(payload: JobPayload): Promise<TabsOutcome> {
  const started = Date.now();
  const ready = await withOrg(payload.orgId, (db) => readGate(db, payload, false));
  if (ready.gate === 'no_credit') {
    await failTabs(payload, NO_CREDIT);
    return 'stopped';
  }
  if (ready.gate !== 'run') {
    return 'stopped';
  }
  let outcome: TabsOutcome | 'no_credit';
  try {
    const pages = await loadPages(payload.orgId, payload.documentId);
    const summary = await extractBidFacts(pages);
    const facts = summary.facts.filter((fact) => fact.quoteVerified);
    const dates = uniqueHits(preScan(pages).dates).map((hit) => aiDateRow(payload, hit, 'amendment'));

    outcome = await withOrg(payload.orgId, async (db): Promise<TabsOutcome | 'no_credit'> => {
      await lockBidSchedule(db, payload.bidId);
      await shareOrg(db, payload.orgId);
      const { gate: current, bid, amendment } = await readGate(db, payload, true);
      if (current !== 'run' || !bid || !amendment || amendment.amendmentNo === null) {
        return current === 'no_credit' ? current : 'stopped';
      }
      const amendmentNo = amendment.amendmentNo;
      const factKeys = facts.map((fact) => factKeyOf(fact.field));
      const lockedFacts = await lockActiveFacts(db, payload, keysOf(factKeys));
      const lockedDates = await lockActiveDates(db, payload, keysOf(dates.map((row) => row.dateKey)));

      const factPlan = planTabSupersede(lockedFacts, facts.map((fact, index) => ({ key: factKeys[index], value: fact.value })), amendmentNo);
      const datePlan = planTabSupersede(lockedDates, dates.map((row) => ({
        key: row.dateKey,
        value: row.startDate ? toIsoDate(row.startDate) : '',
      })), amendmentNo);

      const links: LinkInsert[] = [];
      const factRows: FactInsert[] = [];
      const dateRows: DateInsert[] = [];
      const closes: { table: 'bid_facts' | 'schedule_activities'; rowId: string; newRowId: string }[] = [];
      for (const plan of factPlan) {
        if (plan.status === 'skip') continue;
        const fact = facts[plan.index];
        const id = randomUUID();
        factRows.push({
          id,
          orgId: payload.orgId,
          bidId: payload.bidId,
          field: fact.field,
          value: fact.value,
          factKey: plan.key as FactInsert['factKey'],
          documentId: payload.documentId,
          sourcePage: fact.sourcePage,
          sourceQuote: fact.sourceQuote,
          quoteVerified: true,
          amendmentNo,
          origin: 'ai',
          ...closedBy(plan),
        });
        links.push(...linksOf(amendment.id, payload.orgId, 'bid_facts', plan, id, fact));
        closes.push(...plan.closes.map((rowId) => ({ table: 'bid_facts' as const, rowId, newRowId: id })));
      }
      let dateChange: DateChange | null = null;
      for (const plan of datePlan) {
        if (plan.status === 'skip') continue;
        const row = dates[plan.index];
        const id = randomUUID();
        dateRows.push({ ...row, id, amendmentNo, dateKey: plan.key as DateInsert['dateKey'], ...closedBy(plan) });
        links.push(...linksOf(amendment.id, payload.orgId, 'schedule_activities', plan, id, {
          sourcePage: row.sourcePage ?? null,
          sourceQuote: row.sourceQuote ?? null,
        }));
        closes.push(...plan.closes.map((rowId) => ({ table: 'schedule_activities' as const, rowId, newRowId: id })));
        // The first proposal due date this amendment puts in force (not one a higher amendment
        // already replaced) moves the bid's due date, through the prompt.
        if (plan.key === 'proposal_due' && plan.status !== 'superseded' && row.startDate && !dateChange) {
          const previousDue = bid.dueDate ? toIsoDate(bid.dueDate) : null;
          const nextDue = toIsoDate(row.startDate);
          if (previousDue !== nextDue) {
            dateChange = { previousDue, nextDue, sourcePage: row.sourcePage ?? null, sourceQuote: row.sourceQuote ?? null, resolvedAt: null };
          }
        }
      }

      for (const chunk of chunks(factRows)) {
        await db.insert(schema.bidFacts).values(chunk);
      }
      for (const chunk of chunks(dateRows)) {
        await db.insert(schema.scheduleActivities).values(chunk);
      }
      const now = new Date();
      for (const close of closes) {
        const set = { supersedeStatus: 'superseded' as const, supersededByRowId: close.newRowId, changedByAmendment: amendmentNo, updatedAt: now };
        if (close.table === 'bid_facts') {
          const t = schema.bidFacts;
          await db.update(t).set(set).where(and(eq(t.id, close.rowId), eq(t.bidId, payload.bidId), eq(t.orgId, payload.orgId),
            or(isNull(t.supersedeStatus), eq(t.supersedeStatus, 'active'))));
        } else {
          const t = schema.scheduleActivities;
          await db.update(t).set(set).where(and(eq(t.id, close.rowId), eq(t.bidId, payload.bidId), eq(t.orgId, payload.orgId),
            or(isNull(t.supersedeStatus), eq(t.supersedeStatus, 'active'))));
        }
      }
      for (const chunk of chunks(links)) {
        await db.insert(schema.amendmentLinks).values(chunk);
      }
      await recordRun({
        orgId: payload.orgId,
        bidId: payload.bidId,
        task: 'amendment-tabs',
        provider: summary.provider,
        model: summary.model,
        skillName: summary.skillName,
        skillVersion: summary.skillVersion,
        tokens: summary.tokens,
        costUsd: costOf(summary.provider, summary.tokens),
        durationMs: Date.now() - started,
        status: 'completed',
      }, db);
      const proposed = links.some((link) => link.status === 'proposed');
      await db.update(schema.amendments).set({
        tabsStatus: 'applied',
        // Open tab proposals keep the amendment in needs_confirmation (owner decision, 16 Oct 2026).
        status: proposed ? 'needs_confirmation' : amendment.status,
        ...(dateChange ? { datesChanged: dateChange } : {}),
        updatedAt: now,
      }).where(and(eq(schema.amendments.id, amendment.id), eq(schema.amendments.orgId, payload.orgId)));
      return 'applied';
    });
  } catch (error) {
    await failTabs(payload, STEP_FAILED);
    throw error;
  }
  if (outcome === 'no_credit') {
    await failTabs(payload, NO_CREDIT);
    return 'stopped';
  }
  return outcome;
}

/**
 * The bid's active facts on `keys`, locked by id. touched: a user added it, confirmed it, or
 * edited it (every PATCH writes updated_at, so it no longer equals created_at, which an insert sets
 * to the same now(); compared for equality, not order, since the api writes updated_at from the
 * app clock and created_at comes from the database clock). Nothing but a user changes an active AI fact.
 */
async function lockActiveFacts(db: Db, payload: JobPayload, keys: string[]) {
  if (keys.length === 0) {
    return [];
  }
  const t = schema.bidFacts;
  const rows = await db.select({
    id: t.id,
    key: t.factKey,
    amendmentNo: t.amendmentNo,
    value: t.value,
    touched: sql<boolean>`(${t.origin} is distinct from 'ai' or ${t.confirmed} or ${t.updatedAt} is distinct from ${t.createdAt})`,
  }).from(t).where(and(
    eq(t.bidId, payload.bidId),
    eq(t.orgId, payload.orgId),
    inArray(t.factKey, keys as (typeof t.factKey._.data)[]),
    or(isNull(t.supersedeStatus), eq(t.supersedeStatus, 'active')),
  )).orderBy(asc(t.id)).for('update');
  return rows.map((row) => ({ ...row, touched: Boolean(row.touched) }));
}

/**
 * The bid's active activities on `keys`, locked by id; the value compared is the start day.
 * touched: a user added it or changed it (a PATCH or a schedule adjust moves updated_at).
 */
async function lockActiveDates(db: Db, payload: JobPayload, keys: string[]) {
  if (keys.length === 0) {
    return [];
  }
  const t = schema.scheduleActivities;
  const rows = await db.select({
    id: t.id,
    key: t.dateKey,
    amendmentNo: t.amendmentNo,
    startDate: t.startDate,
    touched: sql<boolean>`(${t.origin} is distinct from 'ai' or ${t.updatedAt} is distinct from ${t.createdAt})`,
  }).from(t).where(and(
    eq(t.bidId, payload.bidId),
    eq(t.orgId, payload.orgId),
    inArray(t.dateKey, keys as (typeof t.dateKey._.data)[]),
    or(isNull(t.supersedeStatus), eq(t.supersedeStatus, 'active')),
  )).orderBy(asc(t.id)).for('update');
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    amendmentNo: row.amendmentNo,
    value: row.startDate ? toIsoDate(row.startDate) : '',
    touched: Boolean(row.touched),
  }));
}

/**
 * Queues step 8 after COMMIT under a fresh BullMQ id (an id BullMQ has seen is ignored; the
 * tabs_status gate makes duplicates harmless). A failed queue call fails step 8 visibly instead
 * of leaving it pending; nothing here throws.
 */
export async function queueAmendmentTabs(payload: JobPayload): Promise<void> {
  try {
    await enqueue(AMENDMENT_TABS_QUEUE, payload, { jobId: queueJobId(AMENDMENT_TABS_QUEUE, randomUUID()) });
  } catch (error) {
    console.error(`Could not queue the bid facts and dates of amendment ${payload.documentId}`, error);
    await failTabs(payload, QUEUE_FAILED);
  }
}

/**
 * Step 8 failed: tabs_status pending -> failed (only from pending, so a run that applied is never
 * marked failed), with a failed classify job row carrying `error` that the user can retry (the
 * retry queues classify; the key check sets tabs_status back to pending and queues step 8). Lock
 * order organization (key share, for the job insert), document, bid, amendment. Logged, never
 * thrown.
 */
export async function failTabs(payload: JobPayload, error: string): Promise<void> {
  try {
    await withOrg(payload.orgId, async (db) => {
      await shareOrg(db, payload.orgId);
      await db.select({ id: schema.documents.id }).from(schema.documents).where(and(
        eq(schema.documents.id, payload.documentId),
        eq(schema.documents.orgId, payload.orgId),
      )).for('update');
      await db.select({ id: schema.bids.id }).from(schema.bids).where(and(
        eq(schema.bids.id, payload.bidId),
        eq(schema.bids.orgId, payload.orgId),
      )).for('update');
      const [failed] = await db.update(schema.amendments).set({ tabsStatus: 'failed', updatedAt: new Date() }).where(and(
        eq(schema.amendments.documentId, payload.documentId),
        eq(schema.amendments.orgId, payload.orgId),
        eq(schema.amendments.tabsStatus, 'pending'),
      )).returning({ id: schema.amendments.id });
      if (!failed) {
        return;
      }
      await db.insert(schema.jobs).values({
        orgId: payload.orgId,
        bidId: payload.bidId,
        documentId: payload.documentId,
        type: 'classify',
        status: 'failed',
        error,
        finishedAt: new Date(),
      });
    });
  } catch (failError) {
    console.error(`Could not mark the bid facts and dates of amendment ${payload.documentId} failed`, failError);
  }
}

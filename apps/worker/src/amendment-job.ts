import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  costOf,
  coverage,
  diffAmendment,
  extractRows,
  mapRows,
  planAmendmentApply,
  type ComplianceRequirement,
  type DiffLink,
  type ExistingRow,
  type PageRole,
  type PageText,
} from '@pd/ai';
import {
  amendmentLinkConfidence,
  normalizeSolicitationKey,
  schema,
  SETTING_AMENDMENT_LINK_CONFIDENCE,
  withOrg,
} from '@pd/core';
import { chunks, type Db, loadPages, providerForJob, recordRun, replaceCheckThese } from './ai-jobs.js';
import { shareOrg } from './key-check.js';
import { kickAmendments } from './kick.js';
import type { JobPayload } from './redis.js';
import { allocateReqIds } from './req-ids.js';

type DocumentRow = Pick<typeof schema.documents.$inferSelect, 'liveStatus'>;
type BidRow = Pick<typeof schema.bids.$inferSelect, 'creditStatus' | 'solicitationKey'>;
type AmendmentRow = typeof schema.amendments.$inferSelect;
type Gate = 'run' | 'deferred' | 'stopped';

/** Rows of the bid that are not superseded or withdrawn (null counts as active). */
function activeRow() {
  return or(isNull(schema.complianceRows.supersedeStatus), eq(schema.complianceRows.supersedeStatus, 'active'));
}

/**
 * Whether the amendment step may run now (04 s3.1):
 * - stopped: the document is deleted; the amendment is not processing, not matched or overridden,
 *   or has no number; or the bid key moved off the key it matched (unless overridden);
 * - deferred: the solicitation's matrix has not consumed the bid's credit yet (matrix first), or
 *   an amendment of the bid with a lower number is still processing (number order). A kick queues
 *   the step again once that changes.
 */
function gate(document: DocumentRow | undefined, bid: BidRow | undefined, amendment: AmendmentRow | undefined, lowerRunning: boolean): Gate {
  if (!document || document.liveStatus === 'deleted' || !bid || !amendment) {
    return 'stopped';
  }
  if (amendment.status !== 'processing' || !(amendment.solicitationKeyFound || amendment.keyOverride) || amendment.amendmentNo === null) {
    return 'stopped';
  }
  if (!amendment.keyOverride && normalizeSolicitationKey(bid.solicitationKey) !== amendment.matchedKey) {
    return 'stopped';
  }
  if (bid.creditStatus !== 'consumed' || lowerRunning) {
    return 'deferred';
  }
  return 'run';
}

/** True when another amendment of the bid with a lower number is processing on a live document. */
async function lowerRunning(db: Db, payload: JobPayload, amendmentNo: number | null): Promise<boolean> {
  if (amendmentNo === null) {
    return false;
  }
  const [row] = await db.select({ id: schema.amendments.id }).from(schema.amendments)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.amendments.documentId))
    .where(and(
      eq(schema.amendments.orgId, payload.orgId),
      eq(schema.amendments.bidId, payload.bidId),
      ne(schema.amendments.documentId, payload.documentId),
      eq(schema.amendments.status, 'processing'),
      lt(schema.amendments.amendmentNo, amendmentNo),
      sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
    )).limit(1);
  return Boolean(row);
}

async function readGate(db: Db, payload: JobPayload, lock: boolean): Promise<{ gate: Gate; amendment?: AmendmentRow }> {
  const documentQuery = db.select({ liveStatus: schema.documents.liveStatus }).from(schema.documents).where(and(
    eq(schema.documents.id, payload.documentId),
    eq(schema.documents.orgId, payload.orgId),
  ));
  const [document] = lock ? await documentQuery.for('update') : await documentQuery;
  if (!document || document.liveStatus === 'deleted') {
    return { gate: 'stopped' };
  }
  if (lock) {
    // Lock order: document, check_these, bid, amendment, rows (apps/api/src/credits.ts).
    await db.select({ id: schema.checkThese.id }).from(schema.checkThese).where(and(
      eq(schema.checkThese.documentId, payload.documentId),
      eq(schema.checkThese.orgId, payload.orgId),
    )).orderBy(asc(schema.checkThese.id)).for('update');
  }
  const bidQuery = db.select({ creditStatus: schema.bids.creditStatus, solicitationKey: schema.bids.solicitationKey })
    .from(schema.bids).where(and(eq(schema.bids.id, payload.bidId), eq(schema.bids.orgId, payload.orgId)));
  const [bid] = lock ? await bidQuery.for('update') : await bidQuery;
  const amendmentQuery = db.select().from(schema.amendments).where(and(
    eq(schema.amendments.documentId, payload.documentId),
    eq(schema.amendments.orgId, payload.orgId),
    eq(schema.amendments.bidId, payload.bidId),
  ));
  const [amendment] = lock ? await amendmentQuery.for('update') : await amendmentQuery;
  return { gate: gate(document, bid, amendment, await lowerRunning(db, payload, amendment?.amendmentNo ?? null)), amendment };
}

/** app_settings amendment_link_confidence (default 0.80). */
async function readLinkConfidence(orgId: string): Promise<number> {
  const [row] = await withOrg(orgId, (db) => db.select({ value: schema.appSettings.value }).from(schema.appSettings)
    .where(eq(schema.appSettings.key, SETTING_AMENDMENT_LINK_CONFIDENCE)));
  return amendmentLinkConfidence(row?.value);
}

type ActiveRow = ExistingRow & Pick<ComplianceRequirement, 'instrRef' | 'evalRef' | 'responseSection'>;

async function activeRows(payload: JobPayload): Promise<ActiveRow[]> {
  const rows = await withOrg(payload.orgId, (db) => db.select().from(schema.complianceRows).where(and(
    eq(schema.complianceRows.bidId, payload.bidId),
    eq(schema.complianceRows.orgId, payload.orgId),
    activeRow(),
  )));
  return rows.map((row) => ({
    id: row.id,
    reqId: row.reqId,
    sectionRef: row.sectionRef,
    requirementText: row.requirementText,
    sourceQuote: row.sourceQuote,
    instrRef: row.instrRef ?? undefined,
    evalRef: row.evalRef ?? undefined,
    responseSection: row.responseSection ?? undefined,
  }));
}

/**
 * Pass 5 input for an amendment: the `instructions` and `evaluation` pages of the bid's
 * solicitation set that is not deleted (solicitation, amendments, attachments), plus this
 * amendment's own pages. A page classify has not tagged is classified by mapRows.
 */
async function setPages(payload: JobPayload): Promise<(PageText & { role: PageRole | null })[]> {
  const rows = await withOrg(payload.orgId, (db) => db.select({
    documentId: schema.pages.documentId,
    pageNo: schema.pages.pageNo,
    text: schema.pages.text,
    ocrUsed: schema.pages.ocrUsed,
    role: schema.pages.sectionTag,
  }).from(schema.pages)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.pages.documentId))
    .where(and(
      eq(schema.pages.orgId, payload.orgId),
      eq(schema.documents.orgId, payload.orgId),
      eq(schema.documents.bidId, payload.bidId),
      or(
        eq(schema.documents.id, payload.documentId),
        and(
          inArray(schema.documents.kind, ['solicitation', 'amendment', 'attachment']),
          sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
          or(isNull(schema.pages.sectionTag), inArray(schema.pages.sectionTag, ['instructions', 'evaluation'])),
        ),
      ),
    ))
    .orderBy(asc(schema.documents.createdAt), asc(schema.pages.pageNo)));
  return rows.map((row) => ({ pageNo: row.pageNo, text: row.text, ocrUsed: row.ocrUsed, role: row.role }));
}

/**
 * Where the map left a reference empty, a new row takes it from the row it supersedes with the
 * highest confidence at or above the threshold (the row it will replace automatically).
 */
function inheritReferences(rows: ComplianceRequirement[], links: DiffLink[], existing: ActiveRow[], threshold: number): void {
  const byId = new Map(existing.map((row) => [row.id, row]));
  rows.forEach((row, index) => {
    const best = links
      .filter((link) => link.action === 'supersede' && link.newIndex === index && (link.confidence ?? 0) >= threshold)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    const old = best?.oldRowId ? byId.get(best.oldRowId) : undefined;
    if (!old) {
      return;
    }
    row.instrRef ??= old.instrRef;
    row.evalRef ??= old.evalRef;
    row.responseSection ??= old.responseSection;
  });
}

export type AmendmentOutcome = 'applied' | 'needs_confirmation' | 'deferred' | 'stopped';

/**
 * The amendment run (04 s3.1 steps 3 to 6) for an amendment the key check let through.
 *
 * A. Pre-check, no locks: anything but `run` returns with nothing spent (gate above).
 * B. AI work outside any transaction: passes 1 to 4 on the amendment's pages, the diff against the
 *    bid's active rows, pass 5 on the solicitation set's instruction and evaluation pages (a new
 *    row inherits empty references from the row it auto-supersedes), and pass 6 on its pre-scan.
 * C. One write transaction, lock order organization (key share), document, check_these, bid,
 *    amendment, the linked old rows by id. Everything in A is checked again under the locks, and
 *    the number is read from the locked amendments row. New rows get code-generated ids,
 *    amendment_no N, req ids that continue the bid's, and the amendment as their document; auto
 *    links close rows (changed_by_amendment N); a link whose old row is gone or closed is dropped
 *    and logged; every link, the document's "check these" and an ai_runs row are written; the
 *    status becomes needs_confirmation when a link is proposed, else applied. The status gate makes
 *    this exactly-once across retries, reruns and duplicate jobs. Credits are never settled here:
 *    an amendment needs the bid's credit consumed.
 * D. After COMMIT, the bid's next amendment is kicked.
 * E. On a failure in B or C the amendment moves from processing to failed with a failed classify
 *    job row the user can retry, the next amendment is kicked, and the error is rethrown.
 */
export async function processAmendmentJob(payload: JobPayload): Promise<AmendmentOutcome> {
  const started = Date.now();
  const ready = await withOrg(payload.orgId, (db) => readGate(db, payload, false));
  if (ready.gate !== 'run' || !ready.amendment) {
    return ready.gate === 'run' ? 'stopped' : ready.gate;
  }
  let outcome: AmendmentOutcome;
  try {
    const threshold = await readLinkConfidence(payload.orgId);
    const { provider, config } = providerForJob();
    const amendmentPages = await loadPages(payload.orgId, payload.documentId);
    const extracted = await extractRows({ pages: amendmentPages, provider, config, amendmentNo: ready.amendment.amendmentNo ?? 0 });
    const existing = await activeRows(payload);
    const diff = await diffAmendment({ newRows: extracted.requirements, existing, amendmentPages, provider, config });
    if (diff.dropped > 0) {
      console.warn(`Amendment ${payload.documentId}: ${diff.dropped} link(s) from the model dropped (invalid or unquoted)`);
    }
    const map = await mapRows({ rows: extracted.requirements, pages: await setPages(payload), provider, config });
    inheritReferences(extracted.requirements, diff.links, existing, threshold);
    const checkThese = coverage(extracted.hits, extracted.requirements);
    const tokens = extracted.tokensUsed + diff.tokensUsed + map.tokensUsed;

    outcome = await withOrg(payload.orgId, async (db): Promise<AmendmentOutcome> => {
      // The rows, links, hits and run inserted below take FOR KEY SHARE on the organization.
      await shareOrg(db, payload.orgId);
      const { gate: now, amendment } = await readGate(db, payload, true);
      if (now !== 'run' || !amendment || amendment.amendmentNo === null) {
        return now === 'run' ? 'stopped' : now;
      }
      const amendmentNo = amendment.amendmentNo;
      const oldIds = [...new Set(diff.links.flatMap((link) => (link.oldRowId ? [link.oldRowId] : [])))];
      const locked = oldIds.length === 0 ? [] : await db.select({ id: schema.complianceRows.id, supersedeStatus: schema.complianceRows.supersedeStatus })
        .from(schema.complianceRows).where(and(
          inArray(schema.complianceRows.id, oldIds),
          eq(schema.complianceRows.bidId, payload.bidId),
          eq(schema.complianceRows.orgId, payload.orgId),
        )).orderBy(asc(schema.complianceRows.id)).for('update');
      const active = locked.filter((row) => row.supersedeStatus === null || row.supersedeStatus === 'active');
      const plan = planAmendmentApply(active, extracted.requirements, diff.links, threshold);
      if (plan.dropped > 0) {
        console.warn(`Amendment ${payload.documentId}: ${plan.dropped} link(s) dropped at write (old row gone or closed)`);
      }
      const reqIds = await allocateReqIds(db, payload.orgId, payload.bidId, plan.inserts);
      const inserts = plan.inserts.map((row, index) => ({ row, reqId: reqIds[index] }));
      for (const chunk of chunks(inserts)) {
        await db.insert(schema.complianceRows).values(chunk.map(({ row, reqId }) => ({
          id: row.id,
          orgId: payload.orgId,
          bidId: payload.bidId,
          reqId,
          sectionRef: row.sectionRef,
          requirementText: row.requirementText,
          documentId: payload.documentId,
          sourcePage: row.sourcePage,
          sourcePageEnd: row.sourcePageEnd,
          sourceQuote: row.sourceQuote,
          quoteVerified: true,
          amendmentNo,
          origin: 'ai' as const,
          confidence: row.confidence.toFixed(2),
          flags: row.flags,
          reqType: row.reqType,
          instrRef: row.instrRef,
          evalRef: row.evalRef,
          responseSection: row.responseSection,
          supersedeStatus: 'active' as const,
        })));
      }
      for (const close of plan.closes) {
        await db.update(schema.complianceRows).set({
          supersedeStatus: close.status,
          supersededByRowId: close.supersededByRowId,
          changedByAmendment: amendmentNo,
          updatedAt: new Date(),
        }).where(and(
          eq(schema.complianceRows.id, close.rowId),
          eq(schema.complianceRows.bidId, payload.bidId),
          eq(schema.complianceRows.orgId, payload.orgId),
          activeRow(),
        ));
      }
      for (const chunk of chunks(plan.links)) {
        await db.insert(schema.amendmentLinks).values(chunk.map((link) => ({
          orgId: payload.orgId,
          amendmentId: amendment.id,
          rowTable: 'compliance_rows',
          oldRowId: link.oldRowId,
          newRowId: link.newRowId,
          action: link.action,
          confidence: link.confidence === null ? null : link.confidence.toFixed(2),
          status: link.status,
          sourcePage: link.sourcePage,
          sourceQuote: link.sourceQuote,
        })));
      }
      await replaceCheckThese(db, payload, checkThese);
      await recordRun({
        orgId: payload.orgId,
        bidId: payload.bidId,
        task: 'amendment',
        provider: config.providerName,
        model: config.model,
        skillName: extracted.skillName,
        skillVersion: extracted.skillVersion,
        tokens,
        costUsd: costOf(config.providerName, tokens),
        durationMs: Date.now() - started,
        status: 'completed',
      }, db);
      const status = plan.links.some((link) => link.status === 'proposed') ? 'needs_confirmation' : 'applied';
      await db.update(schema.amendments).set({ status, updatedAt: new Date() }).where(and(
        eq(schema.amendments.id, amendment.id),
        eq(schema.amendments.orgId, payload.orgId),
      ));
      return status;
    });
  } catch (error) {
    await failAmendment(payload);
    await kickAmendments(payload.orgId, payload.bidId);
    throw error;
  }
  if (outcome === 'applied' || outcome === 'needs_confirmation') {
    await kickAmendments(payload.orgId, payload.bidId);
  }
  return outcome;
}

/**
 * The amendment step failed: processing -> failed (only from processing, so a run that already
 * applied is never marked failed), with a failed classify job row the user can retry (the retry
 * queues classify; the key check returns a failed amendment to processing). Lock order document,
 * bid, amendment. Logged, never thrown: the caller rethrows the original error.
 */
async function failAmendment(payload: JobPayload): Promise<void> {
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
      const [failed] = await db.update(schema.amendments).set({ status: 'failed', updatedAt: new Date() }).where(and(
        eq(schema.amendments.documentId, payload.documentId),
        eq(schema.amendments.orgId, payload.orgId),
        eq(schema.amendments.status, 'processing'),
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
        error: 'The amendment step failed. Retry it.',
        finishedAt: new Date(),
      });
    });
  } catch (error) {
    console.error(`Could not mark amendment ${payload.documentId} failed`, error);
  }
}

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  extractAmendmentNumber,
  extractSolicitationNumbers,
  matchBidKey,
  type AmendmentNumberResult,
  type KeyCandidate,
  type PageText,
} from '@pd/ai';
import { amendmentNoTaken, nextAmendmentNo, normalizeSolicitationKey, schema, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
import type { JobPayload } from './redis.js';

type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

/**
 * What the key check decided: run the amendment step, hold the amendment, wait for the user to set
 * the amendment number (the key passed but the number is not settled), or nothing to do.
 */
export type KeyCheckOutcome = 'proceed' | 'held' | 'needs_number' | 'stopped';

const PENDING = 'PENDING';

/**
 * The amendment solicitation-number check (04 s3.1 step 1, 06 s4), run after text extraction and
 * classify and before any AI step. Decision table:
 * - document missing or deleted, or the bid's credit not reserved or consumed: no write, stop;
 * - amendment already applied or needs_confirmation (a rerun): unchanged, stop (never re-diff);
 * - owner override: status processing, key_status overridden, queue ai:amendment;
 * - bid key PENDING: held, key_status bid_key_pending (rechecked when PATCH sets the key);
 * - the bid key appears in the text: processing, key_status match, queue ai:amendment;
 * - another labelled number: held, key_status mismatch; no number: held, key_status not_found.
 * On a match or an override the amendment number is settled next (settleNumber); when it cannot
 * be, the amendment goes to needs_number instead of processing and nothing is queued. A held
 * amendment settles no number: that waits until the key matches or the owner overrides.
 * live_status and extract_status are never changed here. A held amendment has no ai:amendment
 * job, so it spends no AI and writes no rows.
 *
 * Pages are read and indexed outside any transaction. One transaction then locks documents ->
 * bids -> amendments (credits.ts), the same order as the override route, document delete and the
 * amendment write, and upserts the one amendments row of the document. ai:amendment is queued
 * only after COMMIT; if that fails the job fails, and a rerun is idempotent.
 */
export async function runKeyCheck(payload: JobPayload): Promise<KeyCheckOutcome> {
  const pages = await withOrg(payload.orgId, async (db) => {
    const rows = await db.select().from(schema.pages).where(and(
      eq(schema.pages.documentId, payload.documentId),
      eq(schema.pages.orgId, payload.orgId),
    ));
    return rows
      .sort((a, b) => a.pageNo - b.pageNo)
      .map((page): PageText => ({ pageNo: page.pageNo, text: page.text, ocrUsed: page.ocrUsed }));
  });
  const candidates = extractSolicitationNumbers(pages);
  const numberFound = extractAmendmentNumber(pages);

  const outcome = await withOrg(payload.orgId, async (db): Promise<KeyCheckOutcome> => {
    const decided = await decide(db, payload, pages, candidates, numberFound);
    await closeClassifyJob(db, payload);
    return decided;
  });
  if (outcome === 'proceed') {
    try {
      await enqueue('ai:amendment', payload);
    } catch (error) {
      // The classify row (if any) is already closed: record a failed classify step the user can
      // retry from the Processing panel (the retry queues classify, and the rerun is idempotent).
      await recordQueueFailure(payload);
      throw error;
    }
  }
  return outcome;
}

/**
 * FOR KEY SHARE on the organization row, taken first: the amendments insert below takes it for its
 * foreign key, and taking it after the bid would wait in a cycle with an upload start that holds
 * the organization row and waits on the bid (lock order organizations -> bids, credits.ts).
 */
export async function shareOrg(db: Db, orgId: string): Promise<void> {
  await db.select({ id: schema.organizations.id }).from(schema.organizations)
    .where(eq(schema.organizations.id, orgId)).for('key share');
}

async function decide(
  db: Db,
  payload: JobPayload,
  pages: PageText[],
  candidates: KeyCandidate[],
  numberFound: AmendmentNumberResult,
): Promise<KeyCheckOutcome> {
  await shareOrg(db, payload.orgId);
  const [document] = await db.select().from(schema.documents).where(and(
    eq(schema.documents.id, payload.documentId),
    eq(schema.documents.orgId, payload.orgId),
  )).for('update');
  if (!document || document.liveStatus === 'deleted' || document.kind !== 'amendment') {
    return 'stopped';
  }
  // The same lock PATCH /api/bids/:id takes, so the key read here is the one in force.
  const [bid] = await db.select().from(schema.bids).where(and(
    eq(schema.bids.id, document.bidId),
    eq(schema.bids.orgId, payload.orgId),
  )).for('update');
  if (!bid || (bid.creditStatus !== 'reserved' && bid.creditStatus !== 'consumed')) {
    return 'stopped';
  }
  const [existing] = await db.select().from(schema.amendments).where(and(
    eq(schema.amendments.documentId, document.id),
    eq(schema.amendments.orgId, payload.orgId),
  )).for('update');
  if (existing && !RECHECKED.includes(existing.status)) {
    return 'stopped';
  }
  if (existing?.keyOverride) {
    const number = await settleNumber(db, payload, document, numberFound);
    await db.update(schema.amendments).set({
      status: number === null ? 'needs_number' : 'processing',
      amendmentNo: number,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.amendments.id, existing.id),
      eq(schema.amendments.orgId, payload.orgId),
    ));
    await setDocumentKey(db, payload, 'overridden', document.keyFound);
    return number === null ? 'needs_number' : 'proceed';
  }

  const bidKey = normalizeSolicitationKey(bid.solicitationKey);
  let keyStatus: 'match' | 'mismatch' | 'not_found' | 'bid_key_pending';
  let keyFound: string | null;
  if (!bidKey || bidKey === PENDING) {
    keyStatus = 'bid_key_pending';
    keyFound = candidates[0]?.raw ?? null;
  } else {
    const match = matchBidKey(pages, bidKey);
    keyStatus = match ? 'match' : candidates.length > 0 ? 'mismatch' : 'not_found';
    keyFound = match ? match.raw : candidates[0]?.raw ?? null;
  }
  const found = keyStatus === 'match';
  // The key check comes first: a held amendment keeps whatever number it has and settles none.
  const number = found ? await settleNumber(db, payload, document, numberFound) : document.amendmentNo;
  const status = !found ? 'held' : number === null ? 'needs_number' : 'processing';
  const now = new Date();
  // Never clears an override, and never touches an amendment past processing (the rows it wrote
  // stay). Held, processing and needs_number can change either way on a rerun.
  await db.insert(schema.amendments).values({
    orgId: payload.orgId,
    bidId: document.bidId,
    documentId: document.id,
    amendmentNo: number,
    solicitationKeyFound: found,
    status,
    matchedKey: bidKey,
  }).onConflictDoUpdate({
    target: schema.amendments.documentId,
    set: { solicitationKeyFound: found, status, matchedKey: bidKey, amendmentNo: number, updatedAt: now },
    setWhere: and(
      eq(schema.amendments.keyOverride, false),
      inArray(schema.amendments.status, RECHECKED),
    ),
  });
  await setDocumentKey(db, payload, keyStatus, keyFound);
  return !found ? 'held' : status === 'needs_number' ? 'needs_number' : 'proceed';
}

/**
 * Statuses the key check may change on a rerun; anything past them is never re-diffed. A failed
 * amendment step is treated like processing: the retry route queues classify, and the check
 * returns it to processing and queues the step again.
 */
const RECHECKED: schema.AmendmentStatus[] = ['held', 'processing', 'needs_number', 'failed'];

/**
 * The amendment's number, settled under the bid lock the caller holds (04 s3.1 numbering rules).
 * A number already on the document (typed at upload, set by PATCH, or settled by an earlier run)
 * is kept and never recomputed; the number read from the file is still recorded in
 * amendment_no_found. Otherwise: the number in the file when it is free (source 'document'); the
 * next number in sequence when the file names none (source 'sequence', shown as assumed); null
 * (the caller sets needs_number) when the file's number is taken, page 1 names two numbers, or
 * the sequence is past 999.
 */
async function settleNumber(
  db: Db,
  payload: JobPayload,
  document: typeof schema.documents.$inferSelect,
  numberFound: AmendmentNumberResult,
): Promise<number | null> {
  const fromFile = numberFound.result === 'found' ? numberFound.number : null;
  const scope = { orgId: payload.orgId, bidId: document.bidId, documentId: document.id };
  let number = document.amendmentNo;
  let source = document.amendmentNoSource;
  if (number === null) {
    if (numberFound.result === 'found') {
      if (!await amendmentNoTaken(db, scope, numberFound.number)) {
        number = numberFound.number;
        source = 'document';
      }
    } else if (numberFound.result === 'none') {
      number = await nextAmendmentNo(db, scope);
      source = number === null ? null : 'sequence';
    }
  }
  await db.update(schema.documents).set({
    amendmentNo: number,
    amendmentNoSource: number === null ? null : source,
    amendmentNoFound: fromFile ?? document.amendmentNoFound,
    updatedAt: new Date(),
  }).where(and(eq(schema.documents.id, document.id), eq(schema.documents.orgId, payload.orgId)));
  return number;
}

async function setDocumentKey(db: Db, payload: JobPayload, keyStatus: NonNullable<schema.KeyStatus>, keyFound: string | null): Promise<void> {
  await db.update(schema.documents).set({ keyStatus, keyFound, updatedAt: new Date() }).where(and(
    eq(schema.documents.id, payload.documentId),
    eq(schema.documents.orgId, payload.orgId),
  ));
}

/** Inserts a failed classify job row for the document; logged, never thrown (the caller throws). */
export async function recordQueueFailure(payload: JobPayload): Promise<void> {
  try {
    await withOrg(payload.orgId, async (db) => {
      await db.insert(schema.jobs).values({
        orgId: payload.orgId,
        bidId: payload.bidId,
        documentId: payload.documentId,
        type: 'classify',
        status: 'failed',
        error: 'The amendment step could not be queued. Retry it.',
        finishedAt: new Date(),
      });
    });
  } catch (error) {
    console.error(`Could not record the failed amendment queue for document ${payload.documentId}`, error);
  }
}

/**
 * Marks the classify job row this run came from completed (an override, a retry, or a recheck
 * creates one). The upload's own row is the scan row, which the scan step closes; it is left alone.
 */
async function closeClassifyJob(db: Db, payload: JobPayload): Promise<void> {
  await db.update(schema.jobs).set({ status: 'completed', finishedAt: new Date(), updatedAt: new Date() }).where(and(
    eq(schema.jobs.id, payload.jobId),
    eq(schema.jobs.orgId, payload.orgId),
    eq(schema.jobs.type, 'classify'),
    sql`${schema.jobs.status} not in ('completed', 'failed')`,
  ));
}

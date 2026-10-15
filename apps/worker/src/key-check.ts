import { and, eq, inArray, sql } from 'drizzle-orm';
import { extractSolicitationNumbers, matchBidKey, type KeyCandidate, type PageText } from '@pd/ai';
import { normalizeSolicitationKey, schema, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
import type { JobPayload } from './redis.js';

type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

/** What the key check decided: run the amendment step, hold the amendment, or nothing to do. */
export type KeyCheckOutcome = 'proceed' | 'held' | 'stopped';

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

  const outcome = await withOrg(payload.orgId, async (db): Promise<KeyCheckOutcome> => {
    const decided = await decide(db, payload, pages, candidates);
    await closeClassifyJob(db, payload);
    return decided;
  });
  if (outcome === 'proceed') {
    await enqueue('ai:amendment', payload);
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

async function decide(db: Db, payload: JobPayload, pages: PageText[], candidates: KeyCandidate[]): Promise<KeyCheckOutcome> {
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
  if (existing && existing.status !== 'held' && existing.status !== 'processing') {
    return 'stopped';
  }
  if (existing?.keyOverride) {
    await db.update(schema.amendments).set({ status: 'processing', updatedAt: new Date() }).where(and(
      eq(schema.amendments.id, existing.id),
      eq(schema.amendments.orgId, payload.orgId),
    ));
    await setDocumentKey(db, payload, 'overridden', document.keyFound);
    return 'proceed';
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
  const status = found ? 'processing' : 'held';
  const now = new Date();
  // Never clears an override, and never touches an amendment past processing (the rows it wrote
  // stay). Held and processing can flip either way on a rerun.
  await db.insert(schema.amendments).values({
    orgId: payload.orgId,
    bidId: document.bidId,
    documentId: document.id,
    amendmentNo: document.amendmentNo ?? 1,
    solicitationKeyFound: found,
    status,
    matchedKey: bidKey,
  }).onConflictDoUpdate({
    target: schema.amendments.documentId,
    set: { solicitationKeyFound: found, status, matchedKey: bidKey, updatedAt: now },
    setWhere: and(
      eq(schema.amendments.keyOverride, false),
      inArray(schema.amendments.status, ['held', 'processing']),
    ),
  });
  await setDocumentKey(db, payload, keyStatus, keyFound);
  return found ? 'proceed' : 'held';
}

async function setDocumentKey(db: Db, payload: JobPayload, keyStatus: NonNullable<schema.KeyStatus>, keyFound: string | null): Promise<void> {
  await db.update(schema.documents).set({ keyStatus, keyFound, updatedAt: new Date() }).where(and(
    eq(schema.documents.id, payload.documentId),
    eq(schema.documents.orgId, payload.orgId),
  ));
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

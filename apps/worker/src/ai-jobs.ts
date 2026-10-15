import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import {
  buildSystemPrompt,
  extractComplianceMatrix,
  getProvider,
  loadSkill,
  preScan,
  processAmendment,
  type ComplianceRequirement,
  type PageText,
  type PreScanHit,
} from '@pd/ai';
import { normalizeSolicitationKey, schema, withOrg } from '@pd/core';
import { shareOrg } from './key-check.js';
import type { JobPayload } from './redis.js';

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function providerForJob() {
  const name = process.env.AI_PROVIDER || 'deepinfra';
  return {
    provider: getProvider(name),
    config: {
      providerName: name,
      model: process.env.AI_MODEL || process.env.DEEPINFRA_MODEL || 'Qwen/Qwen2.5-72B-Instruct',
      maxOutputTokens: 4000,
    },
  };
}

async function loadPages(orgId: string, documentId: string): Promise<PageText[]> {
  return withOrg(orgId, async (db) => {
    const rows = await db.select().from(schema.pages).where(eq(schema.pages.documentId, documentId));
    return rows
      .sort((a, b) => a.pageNo - b.pageNo)
      .map((page) => ({ pageNo: page.pageNo, text: page.text, ocrUsed: page.ocrUsed }));
  });
}

async function recordRun(input: {
  orgId: string;
  bidId: string;
  task: string;
  provider: string;
  model: string;
  skillName?: string;
  skillVersion?: string;
  tokens: number;
  costUsd: number;
  durationMs: number;
  status: string;
}, db?: Db): Promise<void> {
  const write = (tx: Db) => tx.insert(schema.aiRuns).values({
    orgId: input.orgId,
    bidId: input.bidId,
    task: input.task,
    provider: input.provider,
    model: input.model,
    skillName: input.skillName,
    skillVersion: input.skillVersion,
    status: input.status,
    inputTokens: input.tokens,
    outputTokens: 0,
    costUsd: input.costUsd.toFixed(6),
    durationMs: input.durationMs,
  });
  if (db) {
    await write(db);
    return;
  }
  await withOrg(input.orgId, async (tx) => {
    await write(tx);
  });
}

type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

async function settleCredit(orgId: string, bidId: string, action: 'consume' | 'release'): Promise<void> {
  await withOrg(orgId, (db) => settleCreditIn(db, orgId, bidId, action));
}

/** settleCredit inside the caller's transaction. Takes the bid row, then the credit row. */
async function settleCreditIn(db: Db, orgId: string, bidId: string, action: 'consume' | 'release'): Promise<void> {
  {
    // Claim the reservation with a conditional update: only one settler (this job, a retry, the
    // api releasing an abandoned upload, or a bid delete) flips it, and only that one touches
    // the counters. Counters change by increments, never by writing back values read earlier.
    const [bid] = await db.update(schema.bids).set({
      creditStatus: action === 'consume' ? 'consumed' : 'released',
      updatedAt: new Date(),
    }).where(and(
      eq(schema.bids.id, bidId),
      eq(schema.bids.orgId, orgId),
      eq(schema.bids.creditStatus, 'reserved'),
      isNotNull(schema.bids.creditId),
    )).returning({ creditId: schema.bids.creditId });
    if (!bid?.creditId) {
      return;
    }
    await db.update(schema.rfpCredits).set(action === 'consume'
      ? {
        reserved: sql`${schema.rfpCredits.reserved} - 1`,
        used: sql`${schema.rfpCredits.used} + 1`,
        updatedAt: new Date(),
      }
      : {
        reserved: sql`${schema.rfpCredits.reserved} - 1`,
        updatedAt: new Date(),
      }).where(and(
      eq(schema.rfpCredits.id, bid.creditId),
      eq(schema.rfpCredits.orgId, orgId),
      gt(schema.rfpCredits.reserved, 0),
    ));
  }
}

/**
 * Replaces the document's open "check these" hits with this run's requirement-kind hits, inside
 * the caller's transaction (which holds the document row: lock order document, check_these,
 * bid, credit). Deleting the open hits first makes a retry idempotent; a sentence the user
 * already promoted or dismissed on this document is not offered again.
 */
async function replaceCheckThese(db: Db, payload: JobPayload, hits: PreScanHit[]): Promise<void> {
  await db.delete(schema.checkThese).where(and(
    eq(schema.checkThese.documentId, payload.documentId),
    eq(schema.checkThese.orgId, payload.orgId),
    eq(schema.checkThese.status, 'open'),
  ));
  const decided = new Set((await db.select({ sentence: schema.checkThese.sentence, pageNo: schema.checkThese.pageNo })
    .from(schema.checkThese)
    .where(and(eq(schema.checkThese.documentId, payload.documentId), eq(schema.checkThese.orgId, payload.orgId))))
    .map((hit) => `${hit.pageNo}\u0000${hit.sentence}`));
  const rows = new Map<string, { pageNo: number; sentence: string }>();
  for (const hit of hits) {
    const key = `${hit.pageNo}\u0000${hit.text}`;
    if (hit.kind === 'requirement' && hit.text.trim() && !decided.has(key) && !rows.has(key)) {
      rows.set(key, { pageNo: hit.pageNo, sentence: hit.text });
    }
  }
  for (const chunk of chunks([...rows.values()])) {
    await db.insert(schema.checkThese).values(chunk.map((hit) => ({
      orgId: payload.orgId,
      bidId: payload.bidId,
      documentId: payload.documentId,
      sentence: hit.sentence,
      pageNo: hit.pageNo,
    })));
  }
}

/**
 * Splits a multi-row insert so one statement stays well below Postgres's 65,535 bind
 * parameters (a compliance row binds about 20).
 */
function chunks<T>(items: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

export async function processCompliance(payload: JobPayload): Promise<void> {
  const started = Date.now();
  const { provider, config } = providerForJob();
  // Only the solicitation's own matrix run settles the bid's credit (06 s4). An attachment's run
  // merges rows into the matrix and must not consume or release the solicitation's reservation.
  const settlesCredit = payload.kind === 'solicitation';
  try {
    // A solicitation the user deleted before its matrix was built is not processed: the api
    // released its credit, so building the matrix now would give it away for free. The credit
    // is left alone here: if another solicitation of the bid is still live, its own run settles
    // it; if not, the api already released it.
    const [document] = await withOrg(payload.orgId, (db) => db.select({ liveStatus: schema.documents.liveStatus })
      .from(schema.documents)
      .where(and(eq(schema.documents.id, payload.documentId), eq(schema.documents.orgId, payload.orgId))));
    if (!document || document.liveStatus === 'deleted') {
      return;
    }
    const pages = await loadPages(payload.orgId, payload.documentId);
    const result = await extractComplianceMatrix({ pages, provider, config });
    // Rows, "check these" hits, the run record, and the credit consume commit together, so a
    // crash between them cannot leave rows without a consumed credit or a credit still reserved
    // for a built matrix. The document is re-checked under a row lock in the same transaction
    // (lock order: document, check_these, bid, credit): a delete that committed meanwhile wins,
    // and nothing is written.
    await withOrg(payload.orgId, async (db) => {
      const [current] = await db.select({ liveStatus: schema.documents.liveStatus })
        .from(schema.documents)
        .where(and(eq(schema.documents.id, payload.documentId), eq(schema.documents.orgId, payload.orgId)))
        .for('update');
      if (!current || current.liveStatus === 'deleted') {
        return;
      }
      if (!settlesCredit) {
        // An attachment's rows join the matrix only while the bid's solicitation holds a credit.
        const [bid] = await db.select({ creditStatus: schema.bids.creditStatus }).from(schema.bids)
          .where(and(eq(schema.bids.id, payload.bidId), eq(schema.bids.orgId, payload.orgId)));
        if (bid?.creditStatus !== 'reserved' && bid?.creditStatus !== 'consumed') {
          return;
        }
      }
      await replaceCheckThese(db, payload, result.checkThese ?? []);
      for (const chunk of chunks(result.requirements)) {
        await db.insert(schema.complianceRows).values(chunk.map((row) => ({
          orgId: payload.orgId,
          bidId: payload.bidId,
          reqId: row.id,
          sectionRef: row.sectionRef,
          requirementText: row.requirementText,
          documentId: payload.documentId,
          sourcePage: row.sourcePage,
          sourcePageEnd: row.sourcePageEnd,
          sourceQuote: row.sourceQuote,
          quoteVerified: true,
          amendmentNo: row.amendmentNo,
          origin: row.origin,
          confidence: row.confidence.toFixed(2),
          flags: row.flags,
          reqType: row.reqType,
          instrRef: row.instrRef,
          evalRef: row.evalRef,
          responseSection: row.responseSection,
          supersedeStatus: row.supersedeStatus,
        })));
      }
      await recordRun({
        orgId: payload.orgId,
        bidId: payload.bidId,
        task: 'compliance',
        provider: config.providerName,
        model: config.model,
        skillName: result.metadata.skillName,
        skillVersion: result.metadata.skillVersion,
        tokens: result.metadata.tokensUsed,
        costUsd: result.metadata.costUsd,
        durationMs: Date.now() - started,
        status: 'completed',
      }, db);
      if (settlesCredit) {
        await settleCreditIn(db, payload.orgId, payload.bidId, 'consume');
      }
    });
  } catch (error) {
    if (settlesCredit) {
      await settleCredit(payload.orgId, payload.bidId, 'release');
    }
    throw error;
  }
}

export async function processOverview(payload: JobPayload): Promise<void> {
  const started = Date.now();
  const { provider, config } = providerForJob();
  const skill = loadSkill('bid-summary');
  const pages = await loadPages(payload.orgId, payload.documentId);
  const response = await provider.complete({
    system: buildSystemPrompt(skill, 'Extract bid facts.'),
    messages: [{ role: 'user', content: pages.map((page) => `[page ${page.pageNo}]\n${page.text}`).join('\n\n') }],
    jsonSchema: { type: 'object', properties: { facts: { type: 'array' } }, required: ['facts'] },
    maxOutputTokens: config.maxOutputTokens,
  });
  if (!response.json || typeof response.json !== 'object' || !('facts' in response.json) || !Array.isArray(response.json.facts)) {
    throw new Error('Bid summary JSON is missing facts');
  }
  const facts = response.json.facts.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const fact = item as Record<string, unknown>;
    if (typeof fact.field !== 'string' || typeof fact.value !== 'string' || typeof fact.sourceQuote !== 'string') {
      return [];
    }
    return [{
      orgId: payload.orgId,
      bidId: payload.bidId,
      field: fact.field,
      value: fact.value,
      documentId: payload.documentId,
      sourcePage: typeof fact.sourcePage === 'number' ? fact.sourcePage : null,
      sourceQuote: fact.sourceQuote,
      quoteVerified: false,
      origin: 'ai' as const,
    }];
  });
  await withOrg(payload.orgId, async (db) => {
    if (facts.length > 0) {
      await db.insert(schema.bidFacts).values(facts);
    }
  });
  await recordRun({
    orgId: payload.orgId,
    bidId: payload.bidId,
    task: 'overview',
    provider: config.providerName,
    model: config.model,
    skillName: skill.name,
    skillVersion: skill.version,
    tokens: response.usage.totalTokens,
    costUsd: 0,
    durationMs: Date.now() - started,
    status: 'completed',
  });
}

export async function processDates(payload: JobPayload): Promise<void> {
  const pages = await loadPages(payload.orgId, payload.documentId);
  const hits = preScan(pages).dates;
  if (hits.length === 0) {
    return;
  }
  await withOrg(payload.orgId, async (db) => {
    await db.insert(schema.scheduleActivities).values(hits.map((hit) => ({
      orgId: payload.orgId,
      bidId: payload.bidId,
      label: 'Date from solicitation',
      locked: true,
      documentId: payload.documentId,
      sourcePage: hit.pageNo,
      sourceQuote: hit.text,
      quoteVerified: true,
      origin: 'ai' as const,
      note: hit.text,
    })));
  });
}

/** True when an amendments row may run its AI step: processing, and matched or overridden. */
function amendmentMayRun(row: { status: string; solicitationKeyFound: boolean; keyOverride: boolean } | undefined): boolean {
  return Boolean(row && row.status === 'processing' && (row.solicitationKeyFound || row.keyOverride));
}

/**
 * The amendment diff (04 s3.1 steps 3 to 5) for an amendment the key check let through. Only the
 * key check queues this step; it still re-checks everything, because a held or stale job must
 * neither spend tokens nor write rows:
 * - before the AI call (no lock): the amendments row is processing and matched or overridden, and
 *   the document is not deleted;
 * - in the write transaction, lock order documents -> bids -> amendments (credits.ts): the
 *   document is still live, the bid's credit is still reserved or consumed, the bid key is still
 *   the one the check matched (unless overridden), and the row is still processing. The existing
 *   row's status is updated (never a second row), so a second run finds it past processing and
 *   writes nothing. Two runs can both pay for the AI call (an original job and an override's);
 *   only one writes.
 */
export async function processAmendmentJob(payload: JobPayload): Promise<void> {
  const ready = await withOrg(payload.orgId, async (db) => {
    const [document] = await db.select({ liveStatus: schema.documents.liveStatus }).from(schema.documents).where(and(
      eq(schema.documents.id, payload.documentId),
      eq(schema.documents.orgId, payload.orgId),
    ));
    const [amendment] = await db.select().from(schema.amendments).where(and(
      eq(schema.amendments.documentId, payload.documentId),
      eq(schema.amendments.orgId, payload.orgId),
    ));
    // The number is settled by the key check (or the user) before the step runs.
    if (!document || document.liveStatus === 'deleted' || !amendmentMayRun(amendment) || amendment.amendmentNo === null) {
      return null;
    }
    return { ...amendment, amendmentNo: amendment.amendmentNo };
  });
  if (!ready) {
    return;
  }
  const { provider, config } = providerForJob();
  const amendmentPages = await loadPages(payload.orgId, payload.documentId);
  const original = await withOrg(payload.orgId, async (db) => {
    const rows = await db.select().from(schema.complianceRows).where(and(
      eq(schema.complianceRows.bidId, payload.bidId),
      eq(schema.complianceRows.orgId, payload.orgId),
    ));
    return rows.map((row): ComplianceRequirement => ({
      id: row.id,
      sectionRef: row.sectionRef ?? undefined,
      requirementText: row.requirementText,
      instrRef: row.instrRef ?? undefined,
      evalRef: row.evalRef ?? undefined,
      responseSection: row.responseSection ?? undefined,
      sourcePage: row.sourcePage ?? 0,
      sourcePageEnd: row.sourcePageEnd ?? undefined,
      sourceQuote: row.sourceQuote ?? '',
      reqType: row.reqType ?? 'other',
      confidence: Number(row.confidence ?? 0),
      amendmentNo: row.amendmentNo,
      origin: row.origin ?? 'ai',
      flags: row.flags ?? [],
      supersedeStatus: row.supersedeStatus ?? 'active',
      supersededByRowId: row.supersededByRowId ?? undefined,
    }));
  });
  const amendmentNo = ready.amendmentNo;
  const diff = await processAmendment({
    original,
    amendmentPages,
    provider,
    config,
    amendmentNo,
  });
  await withOrg(payload.orgId, async (db) => {
    // The links inserted below take FOR KEY SHARE on the organization: take it before the bid.
    await shareOrg(db, payload.orgId);
    const [document] = await db.select({ liveStatus: schema.documents.liveStatus, bidId: schema.documents.bidId }).from(schema.documents).where(and(
      eq(schema.documents.id, payload.documentId),
      eq(schema.documents.orgId, payload.orgId),
    )).for('update');
    if (!document || document.liveStatus === 'deleted') {
      return;
    }
    const [bid] = await db.select().from(schema.bids).where(and(
      eq(schema.bids.id, document.bidId),
      eq(schema.bids.orgId, payload.orgId),
    )).for('update');
    if (!bid || (bid.creditStatus !== 'reserved' && bid.creditStatus !== 'consumed')) {
      return;
    }
    const [amendment] = await db.select().from(schema.amendments).where(and(
      eq(schema.amendments.documentId, payload.documentId),
      eq(schema.amendments.orgId, payload.orgId),
    )).for('update');
    if (!amendment || !amendmentMayRun(amendment)) {
      return;
    }
    if (!amendment.keyOverride && normalizeSolicitationKey(bid.solicitationKey) !== amendment.matchedKey) {
      return;
    }
    // Row ids from the model are trusted only when they name a compliance row of this bid.
    const bidRows = new Set((await db.select({ id: schema.complianceRows.id }).from(schema.complianceRows).where(and(
      eq(schema.complianceRows.bidId, document.bidId),
      eq(schema.complianceRows.orgId, payload.orgId),
    ))).map((row) => row.id));
    const onBid = (id: string | null | undefined): id is string => typeof id === 'string' && isUuid(id) && bidRows.has(id);
    await db.update(schema.amendments).set({
      status: diff.links.some((link) => link.status === 'proposed') ? 'needs_confirmation' : 'applied',
      updatedAt: new Date(),
    }).where(and(eq(schema.amendments.id, amendment.id), eq(schema.amendments.orgId, payload.orgId)));
    const uuidLinks = diff.links.filter((link) => link.oldRowId === null || onBid(link.oldRowId));
    if (uuidLinks.length > 0) {
      await db.insert(schema.amendmentLinks).values(uuidLinks.map((link) => ({
        orgId: payload.orgId,
        amendmentId: amendment.id,
        rowTable: 'compliance_rows',
        oldRowId: onBid(link.oldRowId) ? link.oldRowId : null,
        newRowId: onBid(link.newRowId) ? link.newRowId : null,
        action: link.action,
        confidence: link.confidence.toFixed(2),
        status: link.status,
      })));
    }
    for (const row of diff.requirements) {
      if (!onBid(row.id)) {
        continue;
      }
      if (row.supersedeStatus === 'superseded' || row.supersedeStatus === 'withdrawn') {
        await db.update(schema.complianceRows).set({
          supersedeStatus: row.supersedeStatus,
          supersededByRowId: onBid(row.supersededByRowId) ? row.supersededByRowId : null,
          updatedAt: new Date(),
        }).where(and(
          eq(schema.complianceRows.id, row.id),
          eq(schema.complianceRows.bidId, document.bidId),
          eq(schema.complianceRows.orgId, payload.orgId),
        ));
      }
    }
  });
}

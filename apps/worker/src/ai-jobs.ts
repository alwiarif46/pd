import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import {
  buildSystemPrompt,
  extractComplianceMatrix,
  getProvider,
  loadSkill,
  preScan,
  type PageText,
  type PreScanHit,
} from '@pd/ai';
import { schema, withOrg } from '@pd/core';
import { kickAmendments } from './kick.js';
import { allocateReqIds } from './req-ids.js';
import type { JobPayload } from './redis.js';

export function providerForJob() {
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

export async function loadPages(orgId: string, documentId: string): Promise<PageText[]> {
  return withOrg(orgId, async (db) => {
    const rows = await db.select().from(schema.pages).where(eq(schema.pages.documentId, documentId));
    return rows
      .sort((a, b) => a.pageNo - b.pageNo)
      .map((page) => ({ pageNo: page.pageNo, text: page.text, ocrUsed: page.ocrUsed }));
  });
}

export async function recordRun(input: {
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

export type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

async function settleCredit(orgId: string, bidId: string, action: 'consume' | 'release'): Promise<void> {
  await withOrg(orgId, (db) => settleCreditIn(db, orgId, bidId, action));
}

/**
 * settleCredit inside the caller's transaction. Takes the bid row, then the credit row. True when
 * this call settled the reservation.
 */
async function settleCreditIn(db: Db, orgId: string, bidId: string, action: 'consume' | 'release'): Promise<boolean> {
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
      return false;
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
    return true;
  }
}

/**
 * Replaces the document's open "check these" hits with this run's requirement-kind hits, inside
 * the caller's transaction (which holds the document row: lock order document, check_these,
 * bid, credit). Deleting the open hits first makes a retry idempotent; a sentence the user
 * already promoted or dismissed on this document is not offered again.
 */
export async function replaceCheckThese(db: Db, payload: JobPayload, hits: PreScanHit[]): Promise<void> {
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
export function chunks<T>(items: T[], size = 500): T[][] {
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
  let consumed = false;
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
    // and nothing is written. The bid is locked so req ids continue the bid's existing ones
    // without colliding with an amendment run or another attachment's run.
    consumed = await withOrg(payload.orgId, async (db): Promise<boolean> => {
      const [current] = await db.select({ liveStatus: schema.documents.liveStatus })
        .from(schema.documents)
        .where(and(eq(schema.documents.id, payload.documentId), eq(schema.documents.orgId, payload.orgId)))
        .for('update');
      if (!current || current.liveStatus === 'deleted') {
        return false;
      }
      await db.select({ id: schema.checkThese.id }).from(schema.checkThese).where(and(
        eq(schema.checkThese.documentId, payload.documentId),
        eq(schema.checkThese.orgId, payload.orgId),
      )).orderBy(asc(schema.checkThese.id)).for('update');
      const [bid] = await db.select({ creditStatus: schema.bids.creditStatus }).from(schema.bids)
        .where(and(eq(schema.bids.id, payload.bidId), eq(schema.bids.orgId, payload.orgId)))
        .for('update');
      // An attachment's rows join the matrix only while the bid's solicitation holds a credit.
      if (!bid || (!settlesCredit && bid.creditStatus !== 'reserved' && bid.creditStatus !== 'consumed')) {
        return false;
      }
      await replaceCheckThese(db, payload, result.checkThese ?? []);
      const reqIds = await allocateReqIds(db, payload.orgId, payload.bidId, result.requirements);
      const rows = result.requirements.map((row, index) => ({ row, reqId: reqIds[index] }));
      for (const chunk of chunks(rows)) {
        await db.insert(schema.complianceRows).values(chunk.map(({ row, reqId }) => ({
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
      return settlesCredit ? settleCreditIn(db, payload.orgId, payload.bidId, 'consume') : false;
    });
  } catch (error) {
    if (settlesCredit) {
      await settleCredit(payload.orgId, payload.bidId, 'release');
    }
    throw error;
  }
  // The matrix is built: amendments that waited for it (04 s3.1, matrix first) may run now.
  if (consumed) {
    await kickAmendments(payload.orgId, payload.bidId);
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

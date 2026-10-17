import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import {
  activeModel,
  buildSystemPrompt,
  extractComplianceMatrix,
  getProvider,
  loadSkill,
  locateQuote,
  preScan,
  type PageText,
  type PreScanHit,
} from '@pd/ai';
import { classifyDateHit, dateLabel, factKeyOf, fromIsoDate, inferActivityKind, schema, withOrg } from '@pd/core';
import { checkCredit, heldUnlessCredited } from './credit-gate.js';
import { shareOrg } from './key-check.js';
import { kickAmendments, kickHeldDocuments } from './kick.js';
import { writeDocumentDates, writeDocumentFacts } from './ai-rows.js';
import { allocateReqIds } from './req-ids.js';
import type { JobPayload } from './redis.js';

export function providerForJob() {
  const name = process.env.AI_PROVIDER || 'deepinfra';
  return {
    provider: getProvider(name),
    config: {
      providerName: name,
      model: activeModel(),
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

/**
 * Consumes or releases the bid's reservation in its own transaction (see settleCreditIn). True
 * when this call settled it; false when the bid holds no reservation (already settled).
 */
export async function settleCredit(orgId: string, bidId: string, action: 'consume' | 'release'): Promise<boolean> {
  return withOrg(orgId, (db) => settleCreditIn(db, orgId, bidId, action));
}

/**
 * settleCredit inside the caller's transaction. Takes the bid row, then the credit row. True when
 * this call settled the reservation.
 */
export async function settleCreditIn(db: Db, orgId: string, bidId: string, action: 'consume' | 'release'): Promise<boolean> {
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
    // Checked before any AI is spent, and again under the locks below. A solicitation the user
    // deleted before its matrix was built is not processed: the api released its credit, so
    // building the matrix now would give it away for free. The credit is left alone here: if
    // another solicitation of the bid is still live, its own run settles it; if not, the api
    // already released it. A file whose bid holds no credit is stopped with a failed classify row
    // (credit-gate.ts): a solicitation whose credit a failed sibling file released is retried by
    // the user (the retry reserves again); an attachment waits for the solicitation's matrix.
    if (await checkCredit(payload) !== 'go') {
      return;
    }
    const pages = await loadPages(payload.orgId, payload.documentId);
    const result = await extractComplianceMatrix({ pages, provider, config });
    // Rows, "check these" hits, the run record, and the credit consume commit together, so a
    // crash between them cannot leave rows without a consumed credit or a credit still reserved
    // for a built matrix. The document is re-checked under a row lock in the same transaction
    // (lock order: organization key share, document, check_these, bid, credit): a delete that
    // committed meanwhile wins, and nothing is written. The bid is locked so req ids continue the
    // bid's existing ones without colliding with an amendment run or another attachment's run.
    // The organization is key-shared first because the rows, the run record and a held job row
    // inserted after the bid lock take that lock for their foreign key (credits.ts shareOrg).
    consumed = await withOrg(payload.orgId, async (db): Promise<boolean> => {
      await shareOrg(db, payload.orgId);
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
      // Rows join the matrix only while the bid's solicitation holds a credit. For an attachment
      // that is the set's credit; for a solicitation it guards against a sibling solicitation file
      // that failed and released the bid's reservation while this run was building: writing the
      // matrix now would give it away for free. Either way a failed classify row is left instead.
      if (!bid || await heldUnlessCredited(db, payload, bid.creditStatus) !== 'go') {
        return false;
      }
      await replaceCheckThese(db, payload, result.checkThese ?? []);
      // A second run of a document whose matrix rows are already written (a duplicate job, a
      // retry of a file that went through) adds no rows: they would duplicate its requirements.
      // The existing rows are kept, not replaced: users edit them, promote hits to them, and
      // amendments link to and supersede them. Checked under the document lock taken above.
      const [written] = await db.select({ id: schema.complianceRows.id }).from(schema.complianceRows).where(and(
        eq(schema.complianceRows.documentId, payload.documentId),
        eq(schema.complianceRows.orgId, payload.orgId),
        eq(schema.complianceRows.origin, 'ai'),
      )).limit(1);
      const requirements = written ? [] : result.requirements;
      const reqIds = await allocateReqIds(db, payload.orgId, payload.bidId, requirements);
      const rows = requirements.map((row, index) => ({ row, reqId: reqIds[index] }));
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
  // The matrix is built: amendments that waited for it (04 s3.1, matrix first) may run now, and
  // attachments and amendments held while the bid had no credit go through classify again.
  if (consumed) {
    await kickHeldDocuments(payload.orgId, payload.bidId);
    await kickAmendments(payload.orgId, payload.bidId);
  }
}

/** A bid fact the bid-summary skill returned, with its quote checked against the pages. */
export interface ExtractedFact {
  field: string;
  value: string;
  sourcePage: number | null;
  sourceQuote: string;
  /** The quote was found on the pages (sourcePage is then the page it is on). */
  quoteVerified: boolean;
}

/**
 * Runs the bid-summary skill on `pages` and checks each fact's quote against them (locateQuote:
 * the cited page, that page and the next, then any page; a hit elsewhere corrects the page).
 * Facts with a missing field, value, or quote are dropped; an unverified one is returned with
 * quoteVerified false and its cited page.
 */
export async function extractBidFacts(pages: PageText[]): Promise<{
  facts: ExtractedFact[];
  tokens: number;
  provider: string;
  model: string;
  skillName: string;
  skillVersion: string;
}> {
  const { provider, config } = providerForJob();
  const skill = loadSkill('bid-summary');
  const response = await provider.complete({
    system: buildSystemPrompt(skill, 'Extract bid facts.'),
    messages: [{ role: 'user', content: pages.map((page) => `[page ${page.pageNo}]\n${page.text}`).join('\n\n') }],
    jsonSchema: { type: 'object', properties: { facts: { type: 'array' } }, required: ['facts'] },
    maxOutputTokens: config.maxOutputTokens,
  });
  if (!response.json || typeof response.json !== 'object' || !('facts' in response.json) || !Array.isArray(response.json.facts)) {
    throw new Error('Bid summary JSON is missing facts');
  }
  const facts = response.json.facts.flatMap((item): ExtractedFact[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const fact = item as Record<string, unknown>;
    if (typeof fact.field !== 'string' || typeof fact.value !== 'string' || typeof fact.sourceQuote !== 'string') {
      return [];
    }
    if (!fact.field.trim() || !fact.value.trim() || !fact.sourceQuote.trim()) {
      return [];
    }
    const cited = typeof fact.sourcePage === 'number' ? fact.sourcePage : null;
    const found = locateQuote(fact.sourceQuote, pages, cited ?? undefined);
    return [{
      field: fact.field,
      value: fact.value,
      sourcePage: found.found ? found.page : cited,
      sourceQuote: fact.sourceQuote,
      quoteVerified: found.found,
    }];
  });
  return {
    facts,
    tokens: response.usage.totalTokens,
    provider: config.providerName,
    model: config.model,
    skillName: skill.name,
    skillVersion: skill.version,
  };
}

export async function processOverview(payload: JobPayload): Promise<void> {
  const started = Date.now();
  const pages = await loadPages(payload.orgId, payload.documentId);
  const result = await extractBidFacts(pages);
  // A rerun (retry, or a kick of a held file) adds only facts the document does not have yet.
  await writeDocumentFacts(payload, result.facts.map((fact) => ({
    orgId: payload.orgId,
    bidId: payload.bidId,
    field: fact.field,
    value: fact.value,
    factKey: factKeyOf(fact.field),
    documentId: payload.documentId,
    sourcePage: fact.sourcePage,
    sourceQuote: fact.sourceQuote,
    quoteVerified: fact.quoteVerified,
    origin: 'ai' as const,
  })));
  await recordRun({
    orgId: payload.orgId,
    bidId: payload.bidId,
    task: 'overview',
    provider: result.provider,
    model: result.model,
    skillName: result.skillName,
    skillVersion: result.skillVersion,
    tokens: result.tokens,
    costUsd: 0,
    durationMs: Date.now() - started,
    status: 'completed',
  });
}

/**
 * An AI date row from a date sentence (preScan hit): keyed and dated by classifyDateHit, labelled
 * by its key, and of the label's kind (a label with no kind of its own is a milestone, as
 * migration 0010 backfilled AI dates). Locked, with the sentence as its quote and note.
 */
export function aiDateRow(payload: JobPayload, hit: { text: string; pageNo: number }, source: 'solicitation' | 'amendment') {
  const { dateKey, day } = classifyDateHit(hit.text);
  const label = dateLabel(dateKey, source);
  const inferred = inferActivityKind(label);
  return {
    orgId: payload.orgId,
    bidId: payload.bidId,
    label,
    kind: inferred.kind === 'custom' ? 'milestone' as const : inferred.kind,
    reviewColor: inferred.reviewColor,
    dateKey,
    startDate: day === null ? null : fromIsoDate(day),
    endDate: day === null ? null : fromIsoDate(day),
    locked: true,
    documentId: payload.documentId,
    sourcePage: hit.pageNo,
    sourceQuote: hit.text,
    quoteVerified: true,
    origin: 'ai' as const,
    note: hit.text,
  };
}

export async function processDates(payload: JobPayload): Promise<void> {
  const pages = await loadPages(payload.orgId, payload.documentId);
  const hits = preScan(pages).dates;
  if (hits.length === 0) {
    return;
  }
  // A rerun adds only dates the document does not have yet, and never changes existing rows.
  await writeDocumentDates(payload, hits.map((hit) => aiDateRow(payload, hit, 'solicitation')));
}

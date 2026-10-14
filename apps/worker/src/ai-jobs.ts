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
} from '@pd/ai';
import { schema, withOrg } from '@pd/core';
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
    // Rows, the run record, and the credit consume commit together, so a crash between them
    // cannot leave rows without a consumed credit or a credit still reserved for a built matrix.
    // The document is re-checked under a row lock in the same transaction (lock order: document,
    // bid, credit): a delete that committed meanwhile wins, and nothing is written.
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
      if (result.requirements.length > 0) {
        await db.insert(schema.complianceRows).values(result.requirements.map((row) => ({
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

export async function processAmendmentJob(payload: JobPayload): Promise<void> {
  const { provider, config } = providerForJob();
  const amendmentPages = await loadPages(payload.orgId, payload.documentId);
  const original = await withOrg(payload.orgId, async (db) => {
    const rows = await db.select().from(schema.complianceRows).where(eq(schema.complianceRows.bidId, payload.bidId));
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
  const [document] = await withOrg(payload.orgId, async (db) => {
    return db.select().from(schema.documents).where(eq(schema.documents.id, payload.documentId));
  });
  const amendmentNo = document?.amendmentNo ?? 1;
  const diff = await processAmendment({
    original,
    amendmentPages,
    provider,
    config,
    amendmentNo,
  });
  await withOrg(payload.orgId, async (db) => {
    // Row ids from the model are trusted only when they name a compliance row of this bid.
    const bidRows = new Set((await db.select({ id: schema.complianceRows.id }).from(schema.complianceRows).where(and(
      eq(schema.complianceRows.bidId, payload.bidId),
      eq(schema.complianceRows.orgId, payload.orgId),
    ))).map((row) => row.id));
    const onBid = (id: string | null | undefined): id is string => typeof id === 'string' && isUuid(id) && bidRows.has(id);
    const [amendment] = await db.insert(schema.amendments).values({
      orgId: payload.orgId,
      bidId: payload.bidId,
      documentId: payload.documentId,
      amendmentNo,
      solicitationKeyFound: true,
      status: diff.links.some((link) => link.status === 'proposed') ? 'needs_confirmation' : 'applied',
    }).returning();
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
          eq(schema.complianceRows.bidId, payload.bidId),
          eq(schema.complianceRows.orgId, payload.orgId),
        ));
      }
    }
  });
}

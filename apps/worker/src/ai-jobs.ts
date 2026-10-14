import { eq } from 'drizzle-orm';
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
import { consumeCredit, releaseCredit, schema, withOrg } from '@pd/core';
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
}): Promise<void> {
  await withOrg(input.orgId, async (db) => {
    await db.insert(schema.aiRuns).values({
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
  });
}

async function settleCredit(orgId: string, bidId: string, action: 'consume' | 'release'): Promise<void> {
  await withOrg(orgId, async (db) => {
    const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, bidId));
    if (!bid?.creditId || bid.creditStatus !== 'reserved') {
      return;
    }
    const [credit] = await db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.id, bid.creditId));
    if (!credit || credit.reserved < 1) {
      return;
    }
    const state = { allowed: credit.allowed, used: credit.used, reserved: credit.reserved };
    const next = action === 'consume' ? consumeCredit(state) : releaseCredit(state);
    await db.update(schema.rfpCredits).set({
      used: next.used,
      reserved: next.reserved,
      updatedAt: new Date(),
    }).where(eq(schema.rfpCredits.id, credit.id));
    await db.update(schema.bids).set({
      creditStatus: action === 'consume' ? 'consumed' : 'released',
      updatedAt: new Date(),
    }).where(eq(schema.bids.id, bidId));
  });
}

export async function processCompliance(payload: JobPayload): Promise<void> {
  const started = Date.now();
  const { provider, config } = providerForJob();
  try {
    const pages = await loadPages(payload.orgId, payload.documentId);
    const result = await extractComplianceMatrix({ pages, provider, config });
    await withOrg(payload.orgId, async (db) => {
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
    });
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
    });
    await settleCredit(payload.orgId, payload.bidId, 'consume');
  } catch (error) {
    await settleCredit(payload.orgId, payload.bidId, 'release');
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
    const [amendment] = await db.insert(schema.amendments).values({
      orgId: payload.orgId,
      bidId: payload.bidId,
      documentId: payload.documentId,
      amendmentNo,
      solicitationKeyFound: true,
      status: diff.links.some((link) => link.status === 'proposed') ? 'needs_confirmation' : 'applied',
    }).returning();
    const uuidLinks = diff.links.filter((link) => link.oldRowId === null || isUuid(link.oldRowId));
    if (uuidLinks.length > 0) {
      await db.insert(schema.amendmentLinks).values(uuidLinks.map((link) => ({
        orgId: payload.orgId,
        amendmentId: amendment.id,
        rowTable: 'compliance_rows',
        oldRowId: link.oldRowId && isUuid(link.oldRowId) ? link.oldRowId : null,
        newRowId: link.newRowId && isUuid(link.newRowId) ? link.newRowId : null,
        action: link.action,
        confidence: link.confidence.toFixed(2),
        status: link.status,
      })));
    }
    for (const row of diff.requirements) {
      if (!isUuid(row.id)) {
        continue;
      }
      if (row.supersedeStatus === 'superseded' || row.supersedeStatus === 'withdrawn') {
        await db.update(schema.complianceRows).set({
          supersedeStatus: row.supersedeStatus,
          supersededByRowId: row.supersededByRowId && isUuid(row.supersededByRowId) ? row.supersededByRowId : null,
          updatedAt: new Date(),
        }).where(eq(schema.complianceRows.id, row.id));
      }
    }
  });
}

import { checkDocumentForMarkings } from './marking-checker';
import {
  chunkPages,
  classifyPages,
  preScan,
  type PageText,
  type PreScanHit,
  type TextChunk,
} from './document-processor';
import { locateQuote, normalizeQuote, quoteCoverage } from './quote-normalizer';
import type { ModelProvider, ModelResponse } from './providers';
import { buildSystemPrompt, loadSkill } from './skill-loader';

export interface ComplianceRequirement {
  id: string;
  sectionRef?: string;
  requirementText: string;
  instrRef?: string;
  evalRef?: string;
  responseSection?: string;
  sourcePage: number;
  sourcePageEnd?: number;
  sourceQuote: string;
  reqType: 'shall' | 'must' | 'will' | 'should' | 'other';
  confidence: number;
  amendmentNo: number;
  origin: 'ai' | 'user';
  flags: string[];
  supersedeStatus?: 'active' | 'superseded' | 'withdrawn';
  supersededByRowId?: string;
  changedByAmendment?: number;
}

export interface PipelineConfig {
  providerName: string;
  model: string;
  chunkTokens?: number;
  maxOutputTokens: number;
  concurrency?: number;
}

export interface PipelineResult {
  requirements: ComplianceRequirement[];
  checkThese: PreScanHit[];
  dueDate?: string;
  dueTime?: string;
  timeZone?: string;
  metadata: {
    processingTimeMs: number;
    tokensUsed: number;
    costUsd: number;
    chunksProcessed: number;
    quoteCheckFailures: number;
    quoteCheckFailureRate: number;
    droppedRows: number;
    skillName: string;
    skillVersion: string;
  };
}

const REQ_TYPES = ['shall', 'must', 'will', 'should', 'other'] as const;
type ReqType = (typeof REQ_TYPES)[number];

interface DraftRow {
  sectionRef: string | null;
  requirementText: string;
  sourceQuote: string;
  sourcePage: number | null;
  reqType: ReqType;
  confidence: number;
  flags: string[];
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    requirements: { type: 'array' },
    dueDate: { type: ['string', 'null'] },
    dueTime: { type: ['string', 'null'] },
    timeZone: { type: ['string', 'null'] },
  },
  required: ['requirements'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('Expected a string or null');
  }
  return value;
}

function readDraftRow(value: unknown): DraftRow {
  if (!isRecord(value)) {
    throw new Error('Requirement is not an object');
  }
  if (typeof value.requirementText !== 'string' || typeof value.sourceQuote !== 'string') {
    throw new Error('Requirement is missing requirementText or sourceQuote');
  }
  if (typeof value.confidence !== 'number') {
    throw new Error('Requirement is missing confidence');
  }
  const reqType = value.reqType;
  if (typeof reqType !== 'string' || !REQ_TYPES.includes(reqType as ReqType)) {
    throw new Error('Requirement has an invalid reqType');
  }
  const flags = Array.isArray(value.flags) ? value.flags.filter((flag): flag is string => typeof flag === 'string') : [];
  return {
    sectionRef: readNullableString(value.sectionRef),
    requirementText: value.requirementText,
    sourceQuote: value.sourceQuote,
    sourcePage: typeof value.sourcePage === 'number' ? value.sourcePage : null,
    reqType: reqType as ReqType,
    confidence: value.confidence,
    flags,
  };
}

function readExtractPayload(json: unknown): { rows: DraftRow[]; dueDate: string | null; dueTime: string | null; timeZone: string | null } {
  if (!isRecord(json) || !Array.isArray(json.requirements)) {
    throw new Error('Extraction JSON is missing requirements');
  }
  return {
    rows: json.requirements.map(readDraftRow),
    dueDate: readNullableString(json.dueDate),
    dueTime: readNullableString(json.dueTime),
    timeZone: readNullableString(json.timeZone),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function pricePerMillion(providerName: string): { input: number; output: number } {
  switch (providerName) {
    case 'deepinfra':
      return { input: 0.1, output: 0.1 };
    case 'anthropic':
      return { input: 3, output: 15 };
    case 'ollama':
      return { input: 0, output: 0 };
    default:
      return { input: 1, output: 1 };
  }
}

function assignIds(rows: ComplianceRequirement[]): void {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const prefix = row.sectionRef && row.sectionRef.length > 0 ? row.sectionRef : 'REQ';
    const count = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, count);
    row.id = `${prefix}-${String(count).padStart(2, '0')}`;
  }
}

function toRequirement(draft: DraftRow, chunk: TextChunk, amendmentNo: number): ComplianceRequirement {
  return {
    id: '',
    sectionRef: draft.sectionRef ?? undefined,
    requirementText: draft.requirementText,
    sourcePage: draft.sourcePage ?? chunk.pageStart,
    sourceQuote: draft.sourceQuote,
    reqType: draft.reqType,
    confidence: draft.confidence,
    amendmentNo,
    origin: 'ai',
    flags: draft.flags,
    supersedeStatus: 'active',
  };
}

async function completeJson(provider: ModelProvider, system: string, user: string, schema: object, maxOutputTokens: number): Promise<{ json: unknown; tokens: number }> {
  const response: ModelResponse = await provider.complete({
    system,
    messages: [{ role: 'user', content: user }],
    jsonSchema: schema,
    maxOutputTokens,
  });
  if (response.json === undefined) {
    throw new Error('Model returned no JSON');
  }
  return { json: response.json, tokens: response.usage.totalTokens };
}

export async function extractComplianceMatrix(input: {
  pages: PageText[];
  provider: ModelProvider;
  config: PipelineConfig;
  amendmentNo?: number;
  stopAfterQuoteCheck?: boolean;
}): Promise<PipelineResult> {
  const started = Date.now();
  const amendmentNo = input.amendmentNo ?? 0;
  const marking = checkDocumentForMarkings(input.pages.map((page) => ({ text: page.text, pageNo: page.pageNo })));
  if (marking.shouldReject) {
    throw new Error(`Classified marking found: ${marking.markings.map((item) => item.marking).join(', ')}`);
  }
  if (marking.shouldBlock) {
    throw new Error(`Marking confirmation required: ${marking.markings.map((item) => item.marking).join(', ')}`);
  }

  const skill = loadSkill('compliance-matrix');
  const system = buildSystemPrompt(skill, 'Follow the compliance-matrix instructions.');
  const classified = classifyPages(input.pages);
  const chunks = chunkPages(classified, input.config.chunkTokens ?? 30_000);
  const scan = preScan(input.pages);
  const concurrency = input.config.concurrency ?? 3;
  let tokensUsed = 0;
  let dueDate: string | undefined;
  let dueTime: string | undefined;
  let timeZone: string | undefined;

  const extracted = await mapLimit(chunks, concurrency, async (chunk) => {
    const result = await completeJson(
      input.provider,
      system,
      `Pass 1 extract. Return JSON with requirements (requirementText, sourceQuote, sourcePage, sectionRef, reqType, confidence) and dueDate, dueTime, timeZone.\n\n${chunk.text}`,
      EXTRACT_SCHEMA,
      input.config.maxOutputTokens,
    );
    tokensUsed += result.tokens;
    const payload = readExtractPayload(result.json);
    if (!dueDate && payload.dueDate) dueDate = payload.dueDate;
    if (!dueTime && payload.dueTime) dueTime = payload.dueTime;
    if (!timeZone && payload.timeZone) timeZone = payload.timeZone;
    return payload.rows.map((row) => toRequirement(row, chunk, amendmentNo));
  });

  const merged = dedupeRows(extracted.flat());
  assignIds(merged);

  const verified = await mapLimit(chunks, concurrency, async (chunk) => {
    const inChunk = merged.filter((row) => row.sourcePage >= chunk.pageStart && row.sourcePage <= chunk.pageEnd);
    const hits = scan.requirements.filter(
      (hit) => hit.kind === 'requirement' && hit.pageNo >= chunk.pageStart && hit.pageNo <= chunk.pageEnd,
    );
    const result = await completeJson(
      input.provider,
      system,
      `Pass 3 verify. Rows already extracted:\n${JSON.stringify(inChunk)}\nPre-scan hits:\n${JSON.stringify(hits)}\nAdd missed requirements. Flag a doubtful row with flags including maybe_not_requirement. Do not drop rows.\n\n${chunk.text}`,
      EXTRACT_SCHEMA,
      input.config.maxOutputTokens,
    );
    tokensUsed += result.tokens;
    return readExtractPayload(result.json).rows;
  });

  for (const drafts of verified) {
    for (const draft of drafts) {
      const already = merged.some((row) => normalizeQuote(row.sourceQuote) === normalizeQuote(draft.sourceQuote));
      if (already) {
        if (draft.flags.includes('maybe_not_requirement')) {
          const existing = merged.find((row) => normalizeQuote(row.sourceQuote) === normalizeQuote(draft.sourceQuote));
          if (existing && !existing.flags.includes('maybe_not_requirement')) {
            existing.flags.push('maybe_not_requirement');
          }
        }
        continue;
      }
      const chunk = chunks.find((item) => item.pageStart <= (draft.sourcePage ?? item.pageStart)) ?? chunks[0];
      if (!chunk) {
        continue;
      }
      merged.push(toRequirement(draft, chunk, amendmentNo));
    }
  }
  assignIds(merged);

  let quoteCheckFailures = 0;
  let droppedRows = 0;
  const quoted: ComplianceRequirement[] = [];
  for (const row of merged) {
    const location = locateQuote(row.sourceQuote, input.pages, row.sourcePage);
    if (!location.found) {
      quoteCheckFailures += 1;
      droppedRows += 1;
      continue;
    }
    quoted.push({
      ...row,
      sourcePage: location.page,
      sourcePageEnd: location.pageEnd,
    });
  }
  const quoteCheckFailureRate = merged.length === 0 ? 0 : quoteCheckFailures / merged.length;
  assignIds(quoted);

  if (input.stopAfterQuoteCheck) {
    const ratesEarly = pricePerMillion(input.config.providerName);
    return {
      requirements: quoted,
      checkThese: [],
      dueDate,
      dueTime,
      timeZone,
      metadata: {
        processingTimeMs: Date.now() - started,
        tokensUsed,
        costUsd: (tokensUsed / 1_000_000) * ratesEarly.input,
        chunksProcessed: chunks.length,
        quoteCheckFailures,
        quoteCheckFailureRate,
        droppedRows,
        skillName: skill.name,
        skillVersion: skill.version,
      },
    };
  }

  const instructionPages = classified.filter((page) => page.role === 'instructions' || page.role === 'evaluation');
  if (instructionPages.length > 0 && quoted.length > 0) {
    const mapped = await completeJson(
      input.provider,
      system,
      `Pass 5 map. For each row id set instrRef, evalRef, and responseSection, or null. JSON shape: {"rows":[{"id":"","instrRef":null,"evalRef":null,"responseSection":null}]}\nRows:\n${JSON.stringify(quoted)}\nPages:\n${instructionPages.map((page) => `[page ${page.pageNo}]\n${page.text}`).join('\n\n')}`,
      { type: 'object', properties: { rows: { type: 'array' } }, required: ['rows'] },
      input.config.maxOutputTokens,
    );
    tokensUsed += mapped.tokens;
    if (!isRecord(mapped.json) || !Array.isArray(mapped.json.rows)) {
      throw new Error('Map JSON is missing rows');
    }
    for (const item of mapped.json.rows) {
      if (!isRecord(item) || typeof item.id !== 'string') {
        throw new Error('Map row is missing id');
      }
      const row = quoted.find((candidate) => candidate.id === item.id);
      if (!row) {
        continue;
      }
      const instrRef = readNullableString(item.instrRef);
      const evalRef = readNullableString(item.evalRef);
      const responseSection = readNullableString(item.responseSection);
      if (instrRef) row.instrRef = instrRef;
      if (evalRef) row.evalRef = evalRef;
      if (responseSection) row.responseSection = responseSection;
    }
  }

  const checkThese = scan.requirements.filter((hit) => {
    if (hit.kind === 'informational') {
      return false;
    }
    return !quoted.some((row) => quoteCoverage(hit.text, row.sourceQuote) >= 0.8 || quoteCoverage(row.sourceQuote, hit.text) >= 0.8);
  });

  const rates = pricePerMillion(input.config.providerName);
  return {
    requirements: quoted,
    checkThese,
    dueDate,
    dueTime,
    timeZone,
    metadata: {
      processingTimeMs: Date.now() - started,
      tokensUsed,
      costUsd: (tokensUsed / 1_000_000) * rates.input,
      chunksProcessed: chunks.length,
      quoteCheckFailures,
      quoteCheckFailureRate,
      droppedRows,
      skillName: skill.name,
      skillVersion: skill.version,
    },
  };
}

function dedupeRows(rows: ComplianceRequirement[]): ComplianceRequirement[] {
  const seen = new Set<string>();
  const kept: ComplianceRequirement[] = [];
  for (const row of rows) {
    const key = normalizeQuote(row.sourceQuote);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(row);
  }
  return kept;
}

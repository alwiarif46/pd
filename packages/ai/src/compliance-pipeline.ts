import { checkDocumentForMarkings } from './marking-checker';
import {
  chunkPages,
  type ClassifiedPage,
  classifyPages,
  preScan,
  type PageRole,
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

/** Passes 1 to 4: what extractRows returns. */
export interface ExtractedRows {
  /** Quote-checked rows with req ids assigned by section prefix from 01 (C.3.1-01 style). */
  requirements: ComplianceRequirement[];
  /** The pre-scan hits of the pages (pass 6 input). */
  hits: PreScanHit[];
  /** The pages, classified by role (pass 5 input on the solicitation path). */
  classified: ClassifiedPage[];
  dueDate?: string;
  dueTime?: string;
  timeZone?: string;
  tokensUsed: number;
  chunksProcessed: number;
  quoteCheckFailures: number;
  quoteCheckFailureRate: number;
  droppedRows: number;
  skillName: string;
  skillVersion: string;
}

function complianceSystem(): { system: string; skill: ReturnType<typeof loadSkill> } {
  const skill = loadSkill('compliance-matrix');
  return { skill, system: buildSystemPrompt(skill, 'Follow the compliance-matrix instructions.') };
}

/**
 * Passes 1 to 4 (04 s3): extract per chunk, merge and dedupe, verify per chunk (missed rows added,
 * doubtful rows flagged, never dropped), quote check (rules 1 and 2: a row whose quote is on no
 * page is dropped and counted). Rows get `amendmentNo` (0 unless given).
 */
export async function extractRows(input: {
  pages: PageText[];
  provider: ModelProvider;
  config: PipelineConfig;
  amendmentNo?: number;
}): Promise<ExtractedRows> {
  const amendmentNo = input.amendmentNo ?? 0;
  const marking = checkDocumentForMarkings(input.pages.map((page) => ({ text: page.text, pageNo: page.pageNo })));
  if (marking.shouldReject) {
    throw new Error(`Classified marking found: ${marking.markings.map((item) => item.marking).join(', ')}`);
  }
  if (marking.shouldBlock) {
    throw new Error(`Marking confirmation required: ${marking.markings.map((item) => item.marking).join(', ')}`);
  }

  const { skill, system } = complianceSystem();
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
  assignIds(quoted);
  return {
    requirements: quoted,
    hits: scan.requirements,
    classified,
    dueDate,
    dueTime,
    timeZone,
    tokensUsed,
    chunksProcessed: chunks.length,
    quoteCheckFailures,
    quoteCheckFailureRate: merged.length === 0 ? 0 : quoteCheckFailures / merged.length,
    droppedRows,
    skillName: skill.name,
    skillVersion: skill.version,
  };
}

/**
 * Pass 5 (04 s3): instruction reference, evaluation factor and response section per row, from
 * the `instructions` and `evaluation` pages among `pages` (a page with no role is classified).
 * Sets the fields the model names on `rows` in place, by row id; leaves the others unset. No
 * model call when there are no such pages or no rows. Returns the tokens used.
 */
export async function mapRows(input: {
  rows: ComplianceRequirement[];
  pages: (PageText & { role?: PageRole | null })[];
  provider: ModelProvider;
  config: PipelineConfig;
}): Promise<{ tokensUsed: number }> {
  const instructionPages = input.pages
    .map((page) => (page.role ? page as ClassifiedPage : classifyPages([page])[0]))
    .filter((page) => page.role === 'instructions' || page.role === 'evaluation');
  if (instructionPages.length === 0 || input.rows.length === 0) {
    return { tokensUsed: 0 };
  }
  const { system } = complianceSystem();
  const mapped = await completeJson(
    input.provider,
    system,
    `Pass 5 map. For each row id set instrRef, evalRef, and responseSection, or null. JSON shape: {"rows":[{"id":"","instrRef":null,"evalRef":null,"responseSection":null}]}\nRows:\n${JSON.stringify(input.rows)}\nPages:\n${instructionPages.map((page) => `[page ${page.pageNo}]\n${page.text}`).join('\n\n')}`,
    { type: 'object', properties: { rows: { type: 'array' } }, required: ['rows'] },
    input.config.maxOutputTokens,
  );
  if (!isRecord(mapped.json) || !Array.isArray(mapped.json.rows)) {
    throw new Error('Map JSON is missing rows');
  }
  for (const item of mapped.json.rows) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      throw new Error('Map row is missing id');
    }
    const row = input.rows.find((candidate) => candidate.id === item.id);
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
  return { tokensUsed: mapped.tokens };
}

/**
 * Pass 6 (04 s3): the pre-scan hits no row covers (80% quote overlap either way), shown as
 * "check these". Informational hits are never listed.
 */
export function coverage(hits: PreScanHit[], rows: ComplianceRequirement[]): PreScanHit[] {
  return hits.filter((hit) => {
    if (hit.kind === 'informational') {
      return false;
    }
    return !rows.some((row) => quoteCoverage(hit.text, row.sourceQuote) >= 0.8 || quoteCoverage(row.sourceQuote, hit.text) >= 0.8);
  });
}

/** The solicitation path: passes 1 to 4 (extractRows), 5 (mapRows) and 6 (coverage) in order. */
export async function extractComplianceMatrix(input: {
  pages: PageText[];
  provider: ModelProvider;
  config: PipelineConfig;
  amendmentNo?: number;
}): Promise<PipelineResult> {
  const started = Date.now();
  const extracted = await extractRows(input);
  const quoted = extracted.requirements;
  const map = await mapRows({ rows: quoted, pages: extracted.classified, provider: input.provider, config: input.config });
  const tokensUsed = extracted.tokensUsed + map.tokensUsed;
  const rates = pricePerMillion(input.config.providerName);
  return {
    requirements: quoted,
    checkThese: coverage(extracted.hits, quoted),
    dueDate: extracted.dueDate,
    dueTime: extracted.dueTime,
    timeZone: extracted.timeZone,
    metadata: {
      processingTimeMs: Date.now() - started,
      tokensUsed,
      costUsd: (tokensUsed / 1_000_000) * rates.input,
      chunksProcessed: extracted.chunksProcessed,
      quoteCheckFailures: extracted.quoteCheckFailures,
      quoteCheckFailureRate: extracted.quoteCheckFailureRate,
      droppedRows: extracted.droppedRows,
      skillName: extracted.skillName,
      skillVersion: extracted.skillVersion,
    },
  };
}

/** Cost of `tokens` input tokens at the provider's list price (provisional, 04 s7). */
export function costOf(providerName: string, tokens: number): number {
  return (tokens / 1_000_000) * pricePerMillion(providerName).input;
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

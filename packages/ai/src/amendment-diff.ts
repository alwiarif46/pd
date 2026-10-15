import { randomUUID } from 'node:crypto';
import type { ComplianceRequirement, PipelineConfig } from './compliance-pipeline';
import type { PageText } from './document-processor';
import type { ModelProvider } from './providers';
import { locateQuote, quoteCoverage } from './quote-normalizer';

/**
 * The amendment diff (04 s3.1 steps 4 and 5) as pure code around one model call.
 *
 * `diffAmendment` names, for each new amendment row, the active row it supersedes (or none: an
 * add), and the active rows the amendment withdraws with no replacement. The model sees new rows
 * under temporary keys n1...nK and existing rows under their own ids, and must quote the
 * amendment text behind every supersede and withdraw. Code then drops, and counts, every link
 * that is malformed, names a key or an id it was not offered (a supersede's old row must be one of
 * that new row's candidates, a withdraw's one of the withdraw candidates), or quotes text that is
 * not on the amendment's pages (04 s1 rule 1).
 *
 * `planAmendmentApply` turns the links into writes: every new row is inserted with a
 * code-generated id whatever the confidence (an add link is always auto; proposals cover only
 * supersede and withdraw); auto links close the old row; proposed links leave it active until the
 * user decides (03 s3.3).
 */

/** An active compliance row of the bid, as the diff sees it. */
export interface ExistingRow {
  id: string;
  reqId: string;
  sectionRef: string | null;
  requirementText: string;
  sourceQuote: string | null;
}

export interface DiffLink {
  action: 'supersede' | 'withdraw' | 'add';
  /** Index of the new row in the rows given (n1 is 0); null on a withdraw. */
  newIndex: number | null;
  /** The existing row's id; null on an add. */
  oldRowId: string | null;
  /** 0 to 1; null when the model gave none for an add. */
  confidence: number | null;
  /** The amendment text behind a supersede or withdraw (quote-checked); null on an add. */
  sourcePage: number | null;
  sourceQuote: string | null;
}

export interface AmendmentDiff {
  links: DiffLink[];
  /** Links dropped as malformed, not offered, or with a quote not on the amendment's pages. */
  dropped: number;
  tokensUsed: number;
}

const DELETE_WORDS = /\b(?:delet\w*|strik\w*|struck|remov\w*|rescind\w*)\b/i;
/** Characters either side of a section reference searched for a delete word. */
const NEAR = 150;

/** Existing rows that may be what a new row replaces: the same section, or close quoted text. */
export function supersedeCandidates(existing: ExistingRow[], row: Pick<ComplianceRequirement, 'sectionRef' | 'sourceQuote'>): ExistingRow[] {
  return existing.filter((candidate) => {
    if (candidate.sectionRef && candidate.sectionRef === row.sectionRef) {
      return true;
    }
    const quote = candidate.sourceQuote ?? candidate.requirementText;
    return quoteCoverage(quote, row.sourceQuote) >= 0.5 || quoteCoverage(row.sourceQuote, quote) >= 0.5;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Existing rows the amendment may withdraw: those whose section reference appears in the
 * amendment text in the same sentence as "delete", "strike", "struck", "remove" or "rescind"
 * (a sentence runs to ". " or a blank line, at most 150 characters either side, so "C.3.4 Monthly
 * report" over a "DELETED" line counts). The reference must stand alone: C.3.4 does not match
 * inside C.3.41 or C.3.4.1.
 */
export function withdrawCandidates(existing: ExistingRow[], pages: PageText[]): ExistingRow[] {
  const texts = pages.map((page) => page.text);
  return existing.filter((row) => {
    const ref = row.sectionRef?.trim();
    if (!ref || ref.length < 2) {
      return false;
    }
    const pattern = new RegExp(`(?<![A-Za-z0-9.])${escapeRegExp(ref)}(?![A-Za-z0-9]|\\.\\d)`, 'gi');
    return texts.some((text) => [...text.matchAll(pattern)].some((match) => (
      DELETE_WORDS.test(sentenceAround(text, match.index, match.index + match[0].length))
    )));
  });
}

/** A sentence ends at ". ", "! ", "? " or a blank line; a dot inside "C.3.4" does not end it. */
const SENTENCE_END = /[.!?](?=\s)|\n\s*\n/g;

/** The sentence holding text[start, end), at most 150 characters either side. */
function sentenceAround(text: string, start: number, end: number): string {
  const before = text.slice(Math.max(0, start - NEAR), start);
  const ends = [...before.matchAll(SENTENCE_END)];
  const last = ends.at(-1);
  const from = last ? before.length - (last.index + last[0].length) : before.length;
  const after = text.slice(end, end + NEAR);
  const next = after.search(SENTENCE_END);
  return `${before.slice(before.length - from)}${text.slice(start, end)}${next === -1 ? after : after.slice(0, next)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DIFF_SCHEMA = { type: 'object', properties: { links: { type: 'array' } }, required: ['links'] };

const DIFF_SYSTEM = 'You compare an amendment with the existing compliance rows of a solicitation. Return only JSON. '
  + 'Do not guess a link you cannot support from the amendment text.';

function slim(row: ExistingRow) {
  return { id: row.id, reqId: row.reqId, sectionRef: row.sectionRef, requirementText: row.requirementText };
}

export async function diffAmendment(input: {
  newRows: ComplianceRequirement[];
  existing: ExistingRow[];
  amendmentPages: PageText[];
  provider: ModelProvider;
  config: PipelineConfig;
}): Promise<AmendmentDiff> {
  const keyed = input.newRows.map((row, index) => ({
    key: `n${index + 1}`,
    row,
    candidates: supersedeCandidates(input.existing, row),
  }));
  const withdrawable = withdrawCandidates(input.existing, input.amendmentPages);
  if (keyed.length === 0 && withdrawable.length === 0) {
    return { links: [], dropped: 0, tokensUsed: 0 };
  }
  const prompt = [
    'Amendment diff. For each new row, name the existing row it supersedes (action "supersede", oldRowId one of its candidates), or mark it "add".',
    'Name each withdraw candidate the amendment removes with no replacement (action "withdraw", newKey null).',
    'Every supersede and withdraw quotes the exact amendment text that shows the change, with its page.',
    'JSON shape: {"links":[{"action":"supersede","newKey":"n1","oldRowId":"<id>","confidence":0.9,"sourceQuote":"","sourcePage":1}]}',
    `New rows:\n${JSON.stringify(keyed.map((item) => ({
      key: item.key,
      sectionRef: item.row.sectionRef ?? null,
      requirementText: item.row.requirementText,
      sourceQuote: item.row.sourceQuote,
      sourcePage: item.row.sourcePage,
      candidates: item.candidates.map(slim),
    })))}`,
    `Withdraw candidates:\n${JSON.stringify(withdrawable.map(slim))}`,
    `Amendment pages:\n${input.amendmentPages.map((page) => `[page ${page.pageNo}]\n${page.text}`).join('\n\n')}`,
  ].join('\n');
  const response = await input.provider.complete({
    system: DIFF_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    jsonSchema: DIFF_SCHEMA,
    maxOutputTokens: input.config.maxOutputTokens,
  });
  if (!isRecord(response.json) || !Array.isArray(response.json.links)) {
    throw new Error('Amendment diff JSON is missing links');
  }

  const byKey = new Map(keyed.map((item, index) => [item.key, { index, candidates: new Set(item.candidates.map((row) => row.id)) }]));
  const withdrawIds = new Set(withdrawable.map((row) => row.id));
  const links: DiffLink[] = [];
  let dropped = 0;
  for (const item of response.json.links) {
    const link = readLink(item, byKey, withdrawIds, input.amendmentPages);
    if (link) {
      links.push(link);
    } else {
      dropped += 1;
    }
  }
  return { links, dropped, tokensUsed: response.usage.totalTokens };
}

function readLink(
  item: unknown,
  byKey: Map<string, { index: number; candidates: Set<string> }>,
  withdrawIds: Set<string>,
  pages: PageText[],
): DiffLink | null {
  if (!isRecord(item)) {
    return null;
  }
  const { action } = item;
  if (action !== 'supersede' && action !== 'withdraw' && action !== 'add') {
    return null;
  }
  const confidence = typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1 ? item.confidence : null;
  const target = typeof item.newKey === 'string' ? byKey.get(item.newKey) : undefined;
  const oldRowId = typeof item.oldRowId === 'string' ? item.oldRowId : null;
  if (action === 'add') {
    return target ? { action, newIndex: target.index, oldRowId: null, confidence, sourcePage: null, sourceQuote: null } : null;
  }
  if (confidence === null || !oldRowId) {
    return null;
  }
  if (action === 'supersede' && (!target || !target.candidates.has(oldRowId))) {
    return null;
  }
  if (action === 'withdraw' && !withdrawIds.has(oldRowId)) {
    return null;
  }
  const quote = typeof item.sourceQuote === 'string' ? item.sourceQuote.trim() : '';
  if (!quote) {
    return null;
  }
  const location = locateQuote(quote, pages, typeof item.sourcePage === 'number' ? item.sourcePage : undefined);
  if (!location.found) {
    return null;
  }
  return {
    action,
    newIndex: action === 'supersede' && target ? target.index : null,
    oldRowId,
    confidence,
    sourcePage: location.page,
    sourceQuote: quote,
  };
}

export interface PlannedLink {
  action: 'supersede' | 'withdraw' | 'add';
  oldRowId: string | null;
  newRowId: string | null;
  confidence: number | null;
  status: 'auto' | 'proposed';
  sourcePage: number | null;
  sourceQuote: string | null;
}

export interface PlannedClose {
  rowId: string;
  status: 'superseded' | 'withdrawn';
  /** The replacing row (the highest-confidence auto supersede); null on a withdraw. */
  supersededByRowId: string | null;
}

export interface AmendmentPlan {
  /** Every new row, with its code-generated id. */
  inserts: (ComplianceRequirement & { id: string })[];
  closes: PlannedClose[];
  links: PlannedLink[];
  /** Links dropped here: an old row that is not active, or a withdraw of a row an auto supersede closes. */
  dropped: number;
}

/**
 * The writes for an amendment run, pure. `active` are the bid's active rows at write time (the
 * caller locks them); a link to any other old row is dropped and counted. Links at or above
 * `threshold` are auto, the rest proposed; add links are always auto. Each new row that no
 * supersede link names gets an add link. When several auto supersedes close one old row, its
 * superseded_by is the highest-confidence new row and every link is kept. An auto withdraw of a
 * row an auto supersede also closes is dropped.
 */
export function planAmendmentApply(
  active: { id: string }[],
  newRows: ComplianceRequirement[],
  links: DiffLink[],
  threshold: number,
  newId: () => string = randomUUID,
): AmendmentPlan {
  const inserts = newRows.map((row) => ({ ...row, flags: [...row.flags], id: newId() }));
  const activeIds = new Set(active.map((row) => row.id));
  let dropped = 0;

  // One link per action, old row and new row: the highest confidence wins.
  const unique = new Map<string, DiffLink>();
  for (const link of links) {
    const key = `${link.action}\u0000${link.oldRowId ?? ''}\u0000${link.newIndex ?? ''}`;
    const seen = unique.get(key);
    if (!seen || (link.confidence ?? 0) > (seen.confidence ?? 0)) {
      unique.set(key, link);
    }
  }

  const planned: PlannedLink[] = [];
  for (const link of unique.values()) {
    if (link.action !== 'add' && (!link.oldRowId || !activeIds.has(link.oldRowId))) {
      dropped += 1;
      continue;
    }
    if (link.newIndex !== null && !inserts[link.newIndex]) {
      dropped += 1;
      continue;
    }
    planned.push({
      action: link.action,
      oldRowId: link.action === 'add' ? null : link.oldRowId,
      newRowId: link.newIndex === null ? null : inserts[link.newIndex].id,
      confidence: link.confidence,
      status: link.action === 'add' || (link.confidence ?? 0) >= threshold ? 'auto' : 'proposed',
      sourcePage: link.action === 'add' ? null : link.sourcePage,
      sourceQuote: link.action === 'add' ? null : link.sourceQuote,
    });
  }

  // Every new row is inserted; one that replaces nothing carries an add link.
  const superseding = new Set(planned.filter((link) => link.action === 'supersede').map((link) => link.newRowId));
  const withAdd = new Set(planned.filter((link) => link.action === 'add').map((link) => link.newRowId));
  const result = planned.filter((link) => link.action !== 'add' || !superseding.has(link.newRowId));
  for (const row of inserts) {
    if (!superseding.has(row.id) && !withAdd.has(row.id)) {
      result.push({ action: 'add', oldRowId: null, newRowId: row.id, confidence: null, status: 'auto', sourcePage: null, sourceQuote: null });
    }
  }

  const best = new Map<string, PlannedLink>();
  for (const link of result) {
    if (link.action === 'supersede' && link.status === 'auto' && link.oldRowId) {
      const seen = best.get(link.oldRowId);
      if (!seen || (link.confidence ?? 0) > (seen.confidence ?? 0)) {
        best.set(link.oldRowId, link);
      }
    }
  }
  const closes: PlannedClose[] = [...best.entries()].map(([rowId, link]) => ({
    rowId, status: 'superseded', supersededByRowId: link.newRowId,
  }));
  const kept: PlannedLink[] = [];
  for (const link of result) {
    if (link.action === 'withdraw' && link.status === 'auto' && link.oldRowId) {
      if (best.has(link.oldRowId)) {
        dropped += 1;
        continue;
      }
      if (!closes.some((close) => close.rowId === link.oldRowId)) {
        closes.push({ rowId: link.oldRowId, status: 'withdrawn', supersededByRowId: null });
      }
    }
    kept.push(link);
  }
  return { inserts, closes, links: kept, dropped };
}

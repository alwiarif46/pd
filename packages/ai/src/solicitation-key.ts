import { normalizeSolicitationKey } from '@pd/core';
import type { PageText } from './document-processor';

/**
 * The amendment solicitation-number check (04 s3.1 step 1, 06 s4). Deterministic: no model call.
 *
 * `matchBidKey` decides whether an amendment names the bid's solicitation. It verifies against the
 * bid's key rather than trusting an extracted number: every line is split into alphanumeric tokens,
 * and the amendment matches when a contiguous run of whole tokens concatenates to the bid key. So
 * `W912-24-R-0001`, `W91224R0001`, `W912 24R 0001` and `W912.24.R.0001` all match key
 * `W91224R0001`, while `W91224R00012` does not (no partial tokens).
 *
 * `extractSolicitationNumbers` finds labelled numbers. It is used for display and to tell a
 * mismatch (another number is named) from not found (no number at all), and for weak keys, never
 * to decide a strong match.
 */

export interface KeyCandidate {
  /** The value as written, trimmed. */
  raw: string;
  /** normalizeSolicitationKey(raw). */
  key: string;
  page: number;
}

export interface KeyMatch {
  /** The matched text as written on the page. */
  raw: string;
  page: number;
}

export interface SolicitationKeyResult {
  result: 'match' | 'mismatch' | 'not_found';
  /** The matched text on a match, the top-ranked candidate on a mismatch, null when not found. */
  found: string | null;
  /** Up to 5 distinct labelled numbers, ranked by label, then page, then position. */
  candidates: KeyCandidate[];
  page: number | null;
}

const MAX_CANDIDATES = 5;
const MIN_STRONG_KEY = 6;
const MIN_CANDIDATE_KEY = 4;

/** OCR confusions folded on OCR'd pages only, on both sides of the comparison. */
const OCR_FOLD: Record<string, string> = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };

function fold(value: string): string {
  return value.replace(/[OILSBZ]/g, (char) => OCR_FOLD[char] ?? char);
}

/** A key needs a label to match when it is short or has no digit (a word like "SERVICES"). */
export function isWeakKey(key: string): boolean {
  return key.length < MIN_STRONG_KEY || !/\d/.test(key);
}

interface Token { text: string; start: number; end: number }

function tokens(line: string): Token[] {
  const out: Token[] = [];
  for (const match of line.matchAll(/[A-Za-z0-9]+/g)) {
    out.push({ text: match[0].toUpperCase(), start: match.index, end: match.index + match[0].length });
  }
  return out;
}

/** The text of a run of whole tokens in `line` that concatenates to `target`, or null. */
function findRun(line: string, target: string, ocr: boolean): string | null {
  const want = ocr ? fold(target) : target;
  const parts = tokens(line);
  for (let start = 0; start < parts.length; start += 1) {
    let joined = '';
    for (let end = start; end < parts.length; end += 1) {
      joined += ocr ? fold(parts[end].text) : parts[end].text;
      if (joined.length > want.length) {
        break;
      }
      if (joined === want) {
        return line.slice(parts[start].start, parts[end].end);
      }
      if (!want.startsWith(joined)) {
        break;
      }
    }
  }
  return null;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

interface LabelRule { rank: number; pattern: RegExp }

// Ranked: the solicitation's own number first (SF-30 block 9A reads "Amendment of Solicitation
// No."), then the SLED document types, then generic bid or reference numbers. Each pattern ends
// where the value may start.
const LABELS: LabelRule[] = [
  { rank: 0, pattern: /\b(?:amendment\s+of\s+)?solicitation\s*(?:no\b\.?|number\b|#)\s*[:.\-#]?/gi },
  {
    rank: 1,
    pattern: /\b(?:RFP|RFQ|IFB|ITB|invitation\s+(?:for|to)\s+bids?|request\s+for\s+(?:proposals?|quotations?|quotes?))\b\s*(?:no\b\.?|number\b|#)?\s*[:.\-#]?/gi,
  },
  { rank: 2, pattern: /\b(?:bid|tender|reference)\s*(?:no\b\.?|number\b|#)\s*[:.\-#]?/gi },
];

const STOP_WORDS = /\b(?:dated|issued|amendment|addendum)\b/i;

/**
 * The value that follows a label: cut at a double space, the end of the line, `,;)`, or the words
 * dated, issued, amendment, addendum. Words without a digit continue the value only when they
 * are one or two capital letters (`R` in `W912 24 R 0001`), so a title after the number
 * ("for Janitorial Services") is not taken. Null when the value has no digit or normalizes to
 * fewer than 4 characters.
 */
export function readValue(rest: string): string | null {
  let value = rest.replace(/^[\s:#.\-–]+/, '');
  value = value.split(/ {2,}|\t|[,;)]/)[0];
  const stop = STOP_WORDS.exec(value);
  if (stop) {
    value = value.slice(0, stop.index);
  }
  const match = /^[A-Z0-9][A-Z0-9\-./ ]{2,40}[A-Z0-9]/i.exec(value);
  if (!match) {
    return null;
  }
  const words = match[0].split(' ');
  const kept: string[] = [];
  for (const word of words) {
    if (!word) {
      continue;
    }
    if (kept.length > 0 && !/\d/.test(word) && !/^[A-Z]{1,2}$/.test(word)) {
      break;
    }
    kept.push(word);
  }
  const raw = kept.join(' ').replace(/[\-./ ]+$/, '');
  if (!/\d/.test(raw) || normalizeSolicitationKey(raw).length < MIN_CANDIDATE_KEY) {
    return null;
  }
  return raw;
}

interface Located extends KeyCandidate { rank: number; line: number; column: number }

/** The lines searched for labels: all of pages 1 and 2, and the first and last 3 lines of every page. */
function searchedLines(page: PageText): number[] {
  const all = lines(page.text);
  if (page.pageNo <= 2 || all.length <= 6) {
    return all.map((_, index) => index);
  }
  return [0, 1, 2, all.length - 3, all.length - 2, all.length - 1];
}

function locate(pages: PageText[]): Located[] {
  const found: Located[] = [];
  for (const page of pages) {
    const all = lines(page.text);
    for (const index of searchedLines(page)) {
      const line = all[index];
      for (const rule of LABELS) {
        for (const label of line.matchAll(rule.pattern)) {
          const after = line.slice(label.index + label[0].length);
          // A form puts the value under its label (SF-30 9A): take the next non-empty line.
          let raw = readValue(after);
          if (!raw && !after.trim()) {
            const next = all.slice(index + 1).find((candidate) => candidate.trim());
            raw = next ? readValue(next) : null;
          }
          if (raw) {
            found.push({ raw, key: normalizeSolicitationKey(raw), page: page.pageNo, rank: rule.rank, line: index, column: label.index });
          }
        }
      }
    }
  }
  return found.sort((a, b) => a.rank - b.rank || a.page - b.page || a.line - b.line || a.column - b.column);
}

/** Up to 5 distinct labelled numbers, ranked by label, then page, then position. */
export function extractSolicitationNumbers(pages: PageText[]): KeyCandidate[] {
  const seen = new Set<string>();
  const out: KeyCandidate[] = [];
  for (const candidate of locate(pages)) {
    if (seen.has(candidate.key)) {
      continue;
    }
    seen.add(candidate.key);
    out.push({ raw: candidate.raw, key: candidate.key, page: candidate.page });
    if (out.length === MAX_CANDIDATES) {
      break;
    }
  }
  return out;
}

/**
 * Where the amendment names the bid key, or null. A strong key matches as a token run anywhere
 * on any page (header or body). A weak key matches only inside a labelled value. OCR'd pages also
 * compare after folding O/0, I/L/1, S/5, B/8, Z/2.
 */
export function matchBidKey(pages: PageText[], bidKey: string): KeyMatch | null {
  const target = normalizeSolicitationKey(bidKey);
  if (!target) {
    return null;
  }
  const ordered = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  if (isWeakKey(target)) {
    const ocrPages = new Set(ordered.filter((page) => page.ocrUsed).map((page) => page.pageNo));
    for (const candidate of locate(ordered)) {
      const run = findRun(candidate.raw, target, false) ?? (ocrPages.has(candidate.page) ? findRun(candidate.raw, target, true) : null);
      if (run) {
        return { raw: run, page: candidate.page };
      }
    }
    return null;
  }
  for (const page of ordered) {
    for (const line of lines(page.text)) {
      const run = findRun(line, target, false) ?? (page.ocrUsed ? findRun(line, target, true) : null);
      if (run) {
        return { raw: run.trim(), page: page.pageNo };
      }
    }
  }
  return null;
}

/** The decision 04 s3.1 step 1 needs: match, mismatch (another labelled number), or not found. */
export function checkSolicitationKey(pages: PageText[], bidKey: string): SolicitationKeyResult {
  const candidates = extractSolicitationNumbers(pages);
  const match = matchBidKey(pages, bidKey);
  if (match) {
    return { result: 'match', found: match.raw, candidates, page: match.page };
  }
  if (candidates.length > 0) {
    return { result: 'mismatch', found: candidates[0].raw, candidates, page: candidates[0].page };
  }
  return { result: 'not_found', found: null, candidates, page: null };
}

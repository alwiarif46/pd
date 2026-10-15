import type { PageText } from './document-processor';
import { linesToSearch } from './solicitation-key';

/**
 * The amendment's own number, read by code with no model call (04 s3.1). Used when the user did
 * not type a number at upload, and to show a typed number that differs from the file.
 *
 * Where a number is read, highest weight first:
 * - SF-30 block 2, "Amendment/Modification No.", with the value after the label, under it, or
 *   above it in the same column (forms put the filled value either side of the printed label).
 *   Block 9A ("Amendment of Solicitation No.") is the solicitation's number and is never read
 *   here; block 4 is the requisition number.
 * - "Amendment No./Number/#" and "Addendum No./Number/#", after the label or under it.
 * - A page-1 heading "Amendment 0003" or "Addendum 2": one of the first 10 non-blank lines, at
 *   most 40 characters, and not a sentence (body prose such as "Addendum 1 is hereby
 *   incorporated." names another addendum).
 * Labels are searched on the lines `linesToSearch` gives (all of pages 1 and 2, the first and last
 * 3 lines of later pages). A value must be digits only: P00002 (a contract modification) is not an
 * amendment number. OCR'd pages read O as 0. Leading zeros are dropped; 1 to 999 only.
 *
 * The first page that names any number decides: one number is `found`; two different numbers
 * are `ambiguous`, unless exactly one of them is in an SF-30 block 2 label, which wins.
 */
export type AmendmentNumberResult =
  | { result: 'found'; number: number; page: number }
  | { result: 'ambiguous'; numbers: number[]; page: number }
  | { result: 'none' };

interface Hit { number: number; page: number; block: boolean }

const MAX = 999;
/** SF-30 block 2. */
const BLOCK_LABEL = /\bamendment\s*\/\s*modification\s*(?:no\b\.?|number\b|#)\s*[:.\-#]?/gi;
const LABEL = /\b(?:amendment|addendum)\s*(?:no\b\.?|number\b|#)\s*[:.\-#]?/gi;
const HEADING = /^\s*(?:amendment|addendum)\s+([A-Za-z0-9]+)(?![A-Za-z0-9])/i;
/** Headings are looked for in the first 10 non-blank lines of page 1, at most 40 characters long. */
const HEADING_LINES = 10;
const HEADING_MAX = 40;
/** A line that reads as a sentence, not a title: a verb of the body, or a closing full stop. */
const SENTENCE = /\b(?:is|are|was|were|has|have|had|shall|will|hereby|incorporated)\b|\.$/i;
/** The start of the next numbered form block ("3. EFFECTIVE DATE", "9A. AMENDMENT OF"). */
const NEXT_BLOCK = /^\d{1,2}[A-Z]?\.\s+[A-Za-z]/;

/** A whole token as an amendment number, or null: digits only (O read as 0 on OCR pages), 1 to 999. */
export function amendmentNumberValue(token: string, ocr: boolean): number | null {
  const folded = ocr ? token.replace(/[Oo]/g, '0') : token;
  if (!/^\d{1,6}$/.test(folded)) {
    return null;
  }
  const value = Number(folded);
  return value >= 1 && value <= MAX ? value : null;
}

/** The first token of the text after a label, cut at a double space or a tab; null if none. */
function valueAfter(rest: string, ocr: boolean): number | null | 'empty' {
  const trimmed = rest.replace(/^[\s:#.\-–]+/, '');
  if (!trimmed || NEXT_BLOCK.test(trimmed)) {
    return 'empty';
  }
  const segment = trimmed.split(/ {2,}|\t/)[0];
  const token = /^[A-Za-z0-9]+/.exec(segment);
  return token ? amendmentNumberValue(token[0], ocr) : null;
}

/** The value in an adjacent line: the token that starts in the label's column, or a lone token. */
function valueInColumn(line: string, start: number, end: number, ocr: boolean, loneToken: boolean): number | null {
  if (NEXT_BLOCK.test(line.trim())) {
    return null;
  }
  const tokens = [...line.matchAll(/[A-Za-z0-9]+/g)];
  const aligned = tokens.find((token) => token.index >= start - 4 && token.index < end);
  if (aligned) {
    return amendmentNumberValue(aligned[0], ocr);
  }
  if (loneToken && tokens.length === 1) {
    return amendmentNumberValue(tokens[0][0], ocr);
  }
  return null;
}

function nearest(all: string[], index: number, step: 1 | -1): string | null {
  for (let at = index + step; at >= 0 && at < all.length; at += step) {
    if (all[at].trim()) {
      return all[at];
    }
  }
  return null;
}

function labelHits(page: PageText, all: string[], index: number, pattern: RegExp, block: boolean): Hit[] {
  const line = all[index];
  const hits: Hit[] = [];
  for (const label of line.matchAll(pattern)) {
    // The block number before the label ("2. ") is part of its column.
    const prefix = /\d{1,2}[A-Z]?\.\s*$/.exec(line.slice(0, label.index));
    const start = prefix ? prefix.index : label.index;
    const end = label.index + label[0].length;
    let value = valueAfter(line.slice(end), page.ocrUsed);
    if (value === 'empty') {
      const under = nearest(all, index, 1);
      value = under === null ? null : valueInColumn(under, start, end, page.ocrUsed, true);
      if (value === null && block) {
        const above = nearest(all, index, -1);
        value = above === null ? null : valueInColumn(above, start, end, page.ocrUsed, false);
      }
    }
    if (typeof value === 'number') {
      hits.push({ number: value, page: page.pageNo, block });
    }
  }
  return hits;
}

function hitsOn(page: PageText, firstPage: boolean): Hit[] {
  const all = page.text.split(/\r?\n/);
  const hits: Hit[] = [];
  for (const index of linesToSearch(page)) {
    hits.push(...labelHits(page, all, index, BLOCK_LABEL, true));
    hits.push(...labelHits(page, all, index, LABEL, false));
  }
  if (firstPage) {
    // A heading reads like a title: early on the page, short, and not a sentence.
    for (const line of all.filter((candidate) => candidate.trim()).slice(0, HEADING_LINES)) {
      const trimmed = line.trim();
      if (trimmed.length > HEADING_MAX || SENTENCE.test(trimmed)) {
        continue;
      }
      const heading = HEADING.exec(trimmed);
      const value = heading ? amendmentNumberValue(heading[1], page.ocrUsed) : null;
      if (value !== null) {
        hits.push({ number: value, page: page.pageNo, block: false });
      }
    }
  }
  return hits;
}

export function extractAmendmentNumber(pages: PageText[]): AmendmentNumberResult {
  const ordered = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  for (const page of ordered) {
    const hits = hitsOn(page, page.pageNo === 1);
    if (hits.length === 0) {
      continue;
    }
    const blocks = [...new Set(hits.filter((hit) => hit.block).map((hit) => hit.number))];
    if (blocks.length === 1) {
      return { result: 'found', number: blocks[0], page: page.pageNo };
    }
    const numbers = [...new Set(hits.map((hit) => hit.number))];
    if (numbers.length === 1) {
      return { result: 'found', number: numbers[0], page: page.pageNo };
    }
    return { result: 'ambiguous', numbers: numbers.sort((a, b) => a - b), page: page.pageNo };
  }
  return { result: 'none' };
}

const QUOTE_MATCH_THRESHOLD = 0.95;

const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
};

/**
 * Lowercase, collapse whitespace, join a hyphen that splits a word across a
 * line break, and map ligatures and smart quotes to plain characters.
 */
export function normalizeQuote(quote: string): string {
  let text = quote;
  for (const [ligature, plain] of Object.entries(LIGATURES)) {
    text = text.replaceAll(ligature, plain);
  }
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/(\w)-\s*[\r\n]+\s*(\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Fraction of `needle` found, in order, inside `haystack`.
 * A full substring scores 1. This is not a Jaccard index.
 */
export function quoteCoverage(needle: string, haystack: string): number {
  const quote = normalizeQuote(needle);
  const page = normalizeQuote(haystack);
  if (quote.length === 0) {
    return 1;
  }
  if (page.includes(quote)) {
    return 1;
  }

  const windowLength = quote.length;
  let best = 0;
  for (const start of candidateStarts(quote, page)) {
    const slice = page.slice(start, start + windowLength);
    const distance = editDistance(quote, slice.length > 0 ? slice : page);
    const score = 1 - distance / quote.length;
    if (score > best) {
      best = score;
    }
    if (best >= QUOTE_MATCH_THRESHOLD) {
      return best;
    }
  }
  return best;
}

function candidateStarts(quote: string, page: string): number[] {
  const starts = new Set<number>();
  const probeLength = Math.min(12, quote.length);
  const probes = [quote.slice(0, probeLength)];
  if (quote.length > probeLength) {
    const middle = Math.floor((quote.length - probeLength) / 2);
    probes.push(quote.slice(middle, middle + probeLength));
  }
  for (const probe of probes) {
    let from = 0;
    while (from < page.length) {
      const found = page.indexOf(probe, from);
      if (found < 0) {
        break;
      }
      const origin = probe === probes[0] ? found : found - quote.indexOf(probe);
      for (let offset = -2; offset <= 2; offset += 1) {
        const start = origin + offset;
        if (start >= 0 && start < page.length) {
          starts.add(start);
        }
      }
      from = found + 1;
    }
  }
  if (starts.size === 0) {
    starts.add(0);
  }
  return [...starts];
}

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const previous = new Array<number>(cols);
  const current = new Array<number>(cols);
  for (let col = 0; col < cols; col += 1) {
    previous[col] = col;
  }
  for (let row = 1; row < rows; row += 1) {
    current[0] = row;
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      current[col] = Math.min(current[col - 1] + 1, previous[col] + 1, previous[col - 1] + cost);
    }
    for (let col = 0; col < cols; col += 1) {
      previous[col] = current[col];
    }
  }
  return previous[cols - 1];
}

/** Directional coverage of `quote1` inside `quote2`. Used by the 80% harness. */
export function calculateQuoteOverlap(quote1: string, quote2: string): number {
  return quoteCoverage(quote1, quote2);
}

export function quotesMatch(quote: string, pageText: string, threshold = QUOTE_MATCH_THRESHOLD): boolean {
  return quoteCoverage(quote, pageText) >= threshold;
}

export interface QuotePage {
  pageNo: number;
  text: string;
}

export interface QuoteLocation {
  found: boolean;
  page: number;
  pageEnd: number;
  coverage: number;
  pageCorrected: boolean;
}

/**
 * Locate a quote on the cited page, that page plus the next, or any other page.
 * A hit on a different page sets `pageCorrected`. No hit means the caller drops the row.
 */
export function locateQuote(quote: string, pages: QuotePage[], citedPage?: number): QuoteLocation {
  const ordered = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  const cited = citedPage === undefined ? undefined : ordered.find((page) => page.pageNo === citedPage);
  const citedIndex = cited === undefined ? -1 : ordered.indexOf(cited);

  if (citedIndex >= 0 && cited) {
    const nextPhysical = ordered.find((page) => page.pageNo === cited.pageNo + 1);
    const near = nextPhysical ? [cited, nextPhysical] : [cited];
    const nearHit = bestPageHit(quote, near);
    if (nearHit && nearHit.coverage >= QUOTE_MATCH_THRESHOLD) {
      return {
        found: true,
        page: nearHit.page,
        pageEnd: nearHit.pageEnd,
        coverage: nearHit.coverage,
        pageCorrected: nearHit.page !== citedPage,
      };
    }
  }

  const anywhere = bestPageHit(quote, ordered);
  if (anywhere && anywhere.coverage >= QUOTE_MATCH_THRESHOLD) {
    return {
      found: true,
      page: anywhere.page,
      pageEnd: anywhere.pageEnd,
      coverage: anywhere.coverage,
      pageCorrected: citedPage !== undefined && anywhere.page !== citedPage,
    };
  }

  return {
    found: false,
    page: citedPage ?? 0,
    pageEnd: citedPage ?? 0,
    coverage: anywhere?.coverage ?? 0,
    pageCorrected: false,
  };
}

interface PageHit {
  page: number;
  pageEnd: number;
  coverage: number;
}

function bestPageHit(quote: string, pages: QuotePage[]): PageHit | undefined {
  let best: PageHit | undefined;
  const consider = (hit: PageHit) => {
    if (!best || hit.coverage > best.coverage) {
      best = hit;
    }
  };
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const onPage = quoteCoverage(quote, page.text);
    consider({ page: page.pageNo, pageEnd: page.pageNo, coverage: onPage });
    const next = pages[index + 1];
    if (!next || next.pageNo !== page.pageNo + 1) {
      continue;
    }
    const onNext = quoteCoverage(quote, next.text);
    if (onPage >= QUOTE_MATCH_THRESHOLD || onNext >= QUOTE_MATCH_THRESHOLD) {
      continue;
    }
    const span = quoteCoverage(quote, `${page.text}\n${next.text}`);
    consider({ page: page.pageNo, pageEnd: next.pageNo, coverage: span });
  }
  return best;
}

export function verifyQuote(
  query: string,
  documentText: string,
  threshold = QUOTE_MATCH_THRESHOLD,
): { verified: boolean; matchedQuote?: string; location?: number } {
  const verified = quotesMatch(query, documentText, threshold);
  if (!verified) {
    return { verified: false };
  }
  const location = normalizeQuote(documentText).indexOf(normalizeQuote(query));
  return {
    verified: true,
    matchedQuote: query,
    location: location >= 0 ? location : undefined,
  };
}

export function extractQuotes(text: string, pattern: RegExp): string[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  return text.match(globalPattern) ?? [];
}

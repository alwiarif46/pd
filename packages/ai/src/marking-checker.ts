export type MarkingType = 'block' | 'classification';

export interface FoundMarking {
  type: MarkingType;
  marking: string;
  page: number;
}

export interface MarkingCheckResult {
  hasMarkings: boolean;
  markings: FoundMarking[];
  shouldBlock: boolean;
  shouldReject: boolean;
}

const BLOCK_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'CUI', pattern: /\bCUI\b/i },
  { label: 'CONTROLLED UNCLASSIFIED', pattern: /CONTROLLED\s+UNCLASSIFIED/i },
  { label: 'FOUO', pattern: /\bFOUO\b/i },
  { label: 'DISTRIBUTION STATEMENT', pattern: /DISTRIBUTION\s+STATEMENT\s+[B-F]\b/i },
  { label: 'ITAR', pattern: /\bITAR\b/i },
  { label: 'EXPORT CONTROLLED', pattern: /EXPORT\s+CONTROLLED/i },
  { label: 'EAR99', pattern: /\bEAR99\b/i },
];

const REJECT_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'TOP SECRET', pattern: /\bTOP\s+SECRET\b/i },
  { label: 'SECRET', pattern: /\bSECRET\b/i },
  { label: 'CONFIDENTIAL', pattern: /\bCONFIDENTIAL\b/i },
];

export interface MarkingPage {
  text: string;
  pageNo: number;
}

/**
 * Pages 1 to 3 are searched in full. Later pages are searched on the first
 * and last non-empty lines only (header and footer).
 */
export function textInMarkingScope(page: MarkingPage): string {
  if (page.pageNo <= 3) {
    return page.text;
  }
  const lines = page.text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return '';
  }
  const header = lines[0];
  const footer = lines[lines.length - 1];
  return header === footer ? header : `${header}\n${footer}`;
}

function findInText(text: string, pageNo: number): FoundMarking[] {
  const found: FoundMarking[] = [];
  for (const rule of REJECT_PATTERNS) {
    if (rule.pattern.test(text)) {
      found.push({ type: 'classification', marking: rule.label, page: pageNo });
    }
  }
  if (found.some((marking) => marking.marking === 'TOP SECRET')) {
    return found.filter((marking) => marking.marking !== 'SECRET');
  }
  for (const rule of BLOCK_PATTERNS) {
    if (rule.pattern.test(text)) {
      found.push({ type: 'block', marking: rule.label, page: pageNo });
    }
  }
  return found;
}

export function checkPageForMarkings(text: string, pageNo: number): FoundMarking[] {
  return findInText(textInMarkingScope({ text, pageNo }), pageNo);
}

export function checkDocumentForMarkings(pages: MarkingPage[]): MarkingCheckResult {
  const markings = pages.flatMap((page) => checkPageForMarkings(page.text, page.pageNo));
  return {
    hasMarkings: markings.length > 0,
    markings,
    shouldBlock: markings.some((marking) => marking.type === 'block'),
    shouldReject: markings.some((marking) => marking.type === 'classification'),
  };
}

export function shouldRejectDocument(result: MarkingCheckResult): boolean {
  return result.shouldReject;
}

export function getMarkingSummary(result: MarkingCheckResult): string {
  if (!result.hasMarkings) {
    return 'No markings found';
  }
  return result.markings.map((marking) => `${marking.marking} on page ${marking.page}`).join(', ');
}

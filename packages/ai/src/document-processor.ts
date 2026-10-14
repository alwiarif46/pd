export interface PageText {
  pageNo: number;
  text: string;
  ocrUsed: boolean;
}

export type PageRole = 'instructions' | 'evaluation' | 'scope' | 'terms' | 'attachments' | 'other';

export interface ClassifiedPage extends PageText {
  role: PageRole;
}

export interface TextChunk {
  text: string;
  pageStart: number;
  pageEnd: number;
  tokenEstimate: number;
}

export interface PreScanHit {
  text: string;
  pageNo: number;
  kind: 'requirement' | 'informational';
}

export interface DateHit {
  text: string;
  pageNo: number;
}

const DEFAULT_CHUNK_TOKENS = 30_000;

const HEADING_RULES: { role: Exclude<PageRole, 'other'>; pattern: RegExp }[] = [
  { role: 'instructions', pattern: /\b(section\s+l|submission requirements|proposal format)\b/i },
  { role: 'evaluation', pattern: /\b(section\s+m|evaluation criteria|scoring)\b/i },
  { role: 'scope', pattern: /\b(section\s+c|\bPWS\b|\bSOW\b|\bSOO\b|scope of work)\b/i },
  { role: 'terms', pattern: /\b(section\s+i|terms and conditions|contract clauses)\b/i },
  { role: 'attachments', pattern: /\b(section\s+j|attachment|appendix)\b/i },
];

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function headingText(page: PageText): string {
  return page.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 8)
    .join('\n');
}

export function classifyPages(pages: PageText[]): ClassifiedPage[] {
  return pages.map((page) => {
    const heading = headingText(page);
    const match = HEADING_RULES.find((rule) => rule.pattern.test(heading));
    return { ...page, role: match?.role ?? 'other' };
  });
}

export function chunkPages(pages: PageText[], chunkTokens = DEFAULT_CHUNK_TOKENS): TextChunk[] {
  const chunks: TextChunk[] = [];
  let parts: { text: string; pageNo: number }[] = [];
  let tokens = 0;

  const flush = () => {
    if (parts.length === 0) {
      return;
    }
    const text = parts.map((part) => part.text).join('\n\n');
    chunks.push({
      text,
      pageStart: parts[0].pageNo,
      pageEnd: parts[parts.length - 1].pageNo,
      tokenEstimate: estimateTokens(text),
    });
    const overlap = parts.slice(-1);
    parts = overlap.map((part) => ({ ...part }));
    tokens = estimateTokens(parts.map((part) => part.text).join('\n\n'));
  };

  for (const page of pages) {
    const paragraphs = page.text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
    const blocks = paragraphs.length > 0 ? paragraphs : [page.text];
    for (const block of blocks) {
      const blockTokens = estimateTokens(block);
      if (tokens > 0 && tokens + blockTokens > chunkTokens) {
        flush();
      }
      parts.push({ text: `[page ${page.pageNo}]\n${block}`, pageNo: page.pageNo });
      tokens += blockTokens;
    }
  }
  flush();
  return chunks;
}

const REQUIREMENT_SENTENCE = /\b(shall|must|will|required|is to|are to)\b/i;
const GOVERNMENT_SUBJECT = /^(the\s+)?(government|agency|state|county)\b/i;
const DATE_HIT = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?|due|no later than)\b/i;

function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export function preScan(pages: PageText[]): { requirements: PreScanHit[]; dates: DateHit[] } {
  const requirements: PreScanHit[] = [];
  const dates: DateHit[] = [];
  for (const page of pages) {
    for (const sentence of sentencesOf(page.text)) {
      if (REQUIREMENT_SENTENCE.test(sentence)) {
        requirements.push({
          text: sentence,
          pageNo: page.pageNo,
          kind: GOVERNMENT_SUBJECT.test(sentence) ? 'informational' : 'requirement',
        });
      }
      if (DATE_HIT.test(sentence)) {
        dates.push({ text: sentence, pageNo: page.pageNo });
      }
    }
  }
  return { requirements, dates };
}

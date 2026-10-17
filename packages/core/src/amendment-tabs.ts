/**
 * Amendment step 8 (04 s3.1, PR5): the bid facts and schedule dates an amendment changes. Pure
 * functions shared by the worker's ai:amendment-tabs step, the api, and migration 0011's backfill
 * (which repeats factKeyOf in SQL; services/gateway/test/migration-amendment-tabs.test.ts keeps the two in
 * step).
 *
 * Supersede by key: a fact or date row carries a key (bid_facts.fact_key, schedule_activities.
 * date_key). An amendment's row on key K (not 'other') replaces the bid's active rows on K with a
 * lower amendment number: automatically when the AI wrote those rows and no user touched them, as
 * a proposal (the user inserts it, and only then do the rows change) when a user added, confirmed,
 * or edited one. A lower amendment's open proposal on K is outdated by it. When an active row or
 * an open proposal on K has a higher number (the amendments finished out of order), the new row
 * is inserted already superseded by it, so the result does not depend on the order the jobs
 * finish in. Rows keyed 'other' are only ever added.
 */
import { isIsoDate } from './schedule';

// ---------------------------------------------------------------------------
// Value lists (migration 0011 holds the same lists as CHECK constraints)
// ---------------------------------------------------------------------------

export const FACT_KEYS = [
  'agency',
  'solicitation_number',
  'naics',
  'set_aside',
  'contract_type',
  'pop',
  'place',
  'submission_method',
  'contracting_officer',
  'other',
] as const;
export type FactKey = (typeof FACT_KEYS)[number];

export const DATE_KEYS = ['proposal_due', 'questions_due', 'site_visit', 'orals', 'other'] as const;
export type DateKey = (typeof DATE_KEYS)[number];

/** amendments.tabs_status: step 8 queued ('pending'), written ('applied'), or failed until a retry. */
export const TABS_STATUSES = ['pending', 'applied', 'failed'] as const;
export type TabsStatus = (typeof TABS_STATUSES)[number];

/**
 * supersede_status of a row an amendment proposes (the earlier row on its key was touched by a
 * user): written, with its source, but not part of the tab until the user inserts it (confirms the
 * link). Tab lists leave it out; a rejected proposal's row stays 'proposed' and is never listed.
 */
export const PROPOSED = 'proposed' as const;

// ---------------------------------------------------------------------------
// Fact keys
// ---------------------------------------------------------------------------

/** Squashed spellings (lower case, letters and digits only) of each fact key. */
const FACT_SPELLINGS: Record<Exclude<FactKey, 'other'>, string[]> = {
  agency: ['agency', 'issuingagency', 'contractingagency'],
  solicitation_number: ['solicitationnumber', 'solicitationno', 'solicitation'],
  naics: ['naics', 'naicscode'],
  set_aside: ['setaside', 'setasidetype'],
  contract_type: ['contracttype'],
  pop: ['pop', 'periodofperformance'],
  place: ['place', 'placeofperformance'],
  submission_method: ['submissionmethod'],
  contracting_officer: ['contractingofficer', 'co'],
};

/** Every squashed spelling with its key, for migration 0011's backfill (the SQL lists the same). */
export const FACT_KEY_SPELLINGS: [string, FactKey][] = Object.entries(FACT_SPELLINGS)
  .flatMap(([key, spellings]) => spellings.map((spelling): [string, FactKey] => [spelling, key as FactKey]));

const SPELLING_KEY = new Map(FACT_KEY_SPELLINGS);

/** The key of a bid fact's field ('solicitationNumber', 'Solicitation Number', ...), else 'other'. */
export function factKeyOf(field: string): FactKey {
  return SPELLING_KEY.get(field.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? 'other';
}

export function isFactKey(value: unknown): value is FactKey {
  return typeof value === 'string' && (FACT_KEYS as readonly string[]).includes(value);
}

export function isDateKey(value: unknown): value is DateKey {
  return typeof value === 'string' && (DATE_KEYS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Dates in text
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const ORDINAL = '(?:st|nd|rd|th)?';
const DATE_TOKEN = new RegExp([
  '\\b(\\d{4})-(\\d{2})-(\\d{2})\\b',
  '\\b(\\d{1,2})[/-](\\d{1,2})[/-](\\d{4}|\\d{2})\\b',
  `\\b${MONTH}\\s+(\\d{1,2})${ORDINAL},?\\s+(\\d{4})\\b`,
  `\\b(\\d{1,2})${ORDINAL}\\s+${MONTH},?\\s+(\\d{4})\\b`,
].join('|'), 'gi');

function iso(year: number, month: number, day: number): string | null {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(value) ? value : null;
}

function monthOf(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/** Every calendar day written in `text`, in order, with where it starts and ends. */
function daysIn(text: string): { day: string; start: number; end: number }[] {
  const found: { day: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(DATE_TOKEN)) {
    const g = match.slice(1);
    let day: string | null = null;
    if (g[0]) {
      day = iso(Number(g[0]), Number(g[1]), Number(g[2]));
    } else if (g[3]) {
      const year = g[5].length === 2 ? 2000 + Number(g[5]) : Number(g[5]);
      day = iso(year, Number(g[3]), Number(g[4]));
    } else if (g[6]) {
      day = iso(Number(g[8]), monthOf(g[6]), Number(g[7]));
    } else if (g[9]) {
      day = iso(Number(g[11]), monthOf(g[10]), Number(g[9]));
    }
    if (day) {
      found.push({ day, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  return found;
}

/**
 * The calendar day a sentence gives, 'YYYY-MM-DD', or null. Reads 2026-12-15, 12/15/2026, 3-4-26
 * (month first), December 15, 2026, Dec. 15 2026, and 15 December 2026. A change written "from X
 * to Y" gives Y; otherwise the first day in the sentence.
 */
export function parseDay(text: string): string | null {
  const days = daysIn(text);
  if (days.length === 0) {
    return null;
  }
  if (days.length > 1 && /\bfrom\b/i.test(text.slice(0, days[0].start))
    && /\bto\b/i.test(text.slice(days[0].end, days[1].start))) {
    return days[1].day;
  }
  return days[0].day;
}

const QUESTIONS = /\b(questions?|inquir(?:y|ies)|rfis?|q\s?&\s?a|clarifications?)\b/;
const SITE_VISIT = /\bsite (?:visit|inspection|walk)|\bwalk-?through\b|\bpre-?(?:proposal|bid) conference\b/;
const ORALS = /\borals?\b|\boral presentations?\b/;
const RESPONSE = /\b(proposals?|offers?|quotes?|quotations?|bids?|responses?|submissions?)\b/;
const DEADLINE = /\b(due|received|receipt|submitted|submit|until|no later than|deadline|closes?|closed|closing)\b/;
const DUE_PHRASE = /\b(closing date|due date|response date|offer due date)\b/;

/**
 * A date sentence's key (questions, site visit, and orals are checked before the proposal due
 * date, so "questions about the proposal are due" is a questions date) and its day. A sentence
 * with no day is keyed 'other': only a dated row can replace another.
 */
export function classifyDateHit(text: string): { dateKey: DateKey; day: string | null } {
  const day = parseDay(text);
  if (day === null) {
    return { dateKey: 'other', day };
  }
  const name = text.toLowerCase();
  if (QUESTIONS.test(name)) return { dateKey: 'questions_due', day };
  if (SITE_VISIT.test(name)) return { dateKey: 'site_visit', day };
  if (ORALS.test(name)) return { dateKey: 'orals', day };
  if ((RESPONSE.test(name) && DEADLINE.test(name)) || DUE_PHRASE.test(name)) return { dateKey: 'proposal_due', day };
  return { dateKey: 'other', day };
}

/**
 * The label of an AI date row; its kind follows from it (inferActivityKind): 'Proposal due' is
 * the submission, the others milestones.
 */
export function dateLabel(key: DateKey, source: 'solicitation' | 'amendment'): string {
  switch (key) {
    case 'proposal_due': return 'Proposal due';
    case 'questions_due': return 'Questions due';
    case 'site_visit': return 'Site visit';
    case 'orals': return 'Oral presentations';
    default: return source === 'amendment' ? 'Date from amendment' : 'Date from solicitation';
  }
}

// ---------------------------------------------------------------------------
// amendments.dates_changed
// ---------------------------------------------------------------------------

/**
 * amendments.dates_changed: the proposal due date an amendment moves (written by step 8; the
 * worker never changes bids.due_date). previousDue is the bid's due date when step 8 ran (null
 * when it had none). resolvedAt is set when the date-change prompt is answered
 * (POST /schedule/adjust with the amendmentId), which applies nextDue to the bid.
 */
export interface DateChange {
  previousDue: string | null;
  nextDue: string;
  sourcePage: number | null;
  sourceQuote: string | null;
  resolvedAt: string | null;
}

/** A stored dates_changed value, or null when there is none or it is malformed. */
export function readDateChange(value: unknown): DateChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isIsoDate(record.nextDue) || (record.previousDue !== null && !isIsoDate(record.previousDue))) {
    return null;
  }
  return {
    previousDue: record.previousDue,
    nextDue: record.nextDue,
    sourcePage: typeof record.sourcePage === 'number' ? record.sourcePage : null,
    sourceQuote: typeof record.sourceQuote === 'string' ? record.sourceQuote : null,
    resolvedAt: typeof record.resolvedAt === 'string' ? record.resolvedAt : null,
  };
}

// ---------------------------------------------------------------------------
// The supersede plan
// ---------------------------------------------------------------------------

/** One of the bid's active rows of a tab (supersede_status null or 'active'), read under its lock. */
export interface TabExisting {
  id: string;
  key: string;
  amendmentNo: number;
  /** A user added it (origin not 'ai'), confirmed it, or edited it (updated after it was written). */
  touched: boolean;
  /** The value compared for a restatement: a fact's value, a date's day. */
  value: string;
}

/** A row the amendment's run found, in the order found. */
export interface TabIncoming {
  key: string;
  value: string;
}

/**
 * An open proposal on a key: a row with supersede_status 'proposed' whose links are still
 * 'proposed', on a document that is not deleted. A later amendment's step 8 sees it, so two
 * amendments never leave two competing proposals on one key.
 */
export interface TabOpenProposal {
  id: string;
  key: string;
  amendmentNo: number;
  value: string;
}

/**
 * What to write for one incoming row:
 * - 'active': inserted active; `closes` (the lower active rows on the key, none touched) become
 *   superseded by it (changed_by_amendment N, an auto supersede link each);
 * - 'proposed': a lower active row on the key was touched by a user. Inserted with supersede_status
 *   'proposed' (not in the tab until the user inserts it), with a proposed supersede link to every
 *   lower active row in `proposes`, touched or not: nothing on the key changes until the insert,
 *   which decides all the links of the row at once (a dismiss rejects them all);
 * - 'superseded': inserted already superseded by `supersededBy`, a higher amendment's active row
 *   or open proposal on the key (the amendments finished out of order);
 * - 'skip': not written; the row says what is already there: the highest lower open proposal, or,
 *   when there is none, every lower active row (a restatement).
 * `replaces`: lower open proposals on the key this amendment outdates; their links are rejected
 * (their rows stay 'proposed', pointing at the new row). A skip that restates the rows in force
 * still outdates a lower proposal that would have changed them.
 * `key` is the key to store: a key the run already used becomes 'other' (only added).
 */
export interface TabPlan {
  index: number;
  key: string;
  status: 'active' | 'proposed' | 'superseded' | 'skip';
  supersededBy: { id: string; amendmentNo: number } | null;
  closes: string[];
  proposes: string[];
  replaces: string[];
}

/** Two values are the same when they differ only in case, spacing, or closing punctuation. */
export function sameTabValue(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '');
  return norm(a) === norm(b);
}

function highest<T extends { id: string; amendmentNo: number }>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => b.amendmentNo - a.amendmentNo || a.id.localeCompare(b.id))[0];
}

/**
 * The supersede plan of amendment N's rows against the bid's active rows and open proposals of
 * one tab (see the header). Pure: the caller reads `existing` and `open` under the row locks and
 * writes the plan in the same transaction.
 */
export function planTabSupersede(existing: TabExisting[], incoming: TabIncoming[], amendmentNo: number, open: TabOpenProposal[] = []): TabPlan[] {
  const used = new Set<string>();
  return incoming.map((item, index): TabPlan => {
    const key = item.key !== 'other' && used.has(item.key) ? 'other' : item.key;
    const base = { index, key, supersededBy: null, closes: [] as string[], proposes: [] as string[], replaces: [] as string[] };
    if (key === 'other') {
      return { ...base, status: 'active' };
    }
    used.add(key);
    const onKey = existing.filter((row) => row.key === key);
    const proposals = open.filter((row) => row.key === key);
    const higher = highest(onKey.filter((row) => row.amendmentNo > amendmentNo))
      ?? highest(proposals.filter((row) => row.amendmentNo > amendmentNo));
    if (higher) {
      return { ...base, status: 'superseded', supersededBy: { id: higher.id, amendmentNo: higher.amendmentNo } };
    }
    const lowerOpen = proposals.filter((row) => row.amendmentNo <= amendmentNo);
    const latest = highest(lowerOpen);
    if (latest && sameTabValue(latest.value, item.value)) {
      return { ...base, status: 'skip' };
    }
    const replaces = lowerOpen.map((row) => row.id).sort();
    if (onKey.length > 0 && onKey.every((row) => sameTabValue(row.value, item.value))) {
      return { ...base, status: 'skip', replaces };
    }
    const lower = onKey.map((row) => row.id).sort();
    return onKey.some((row) => row.touched)
      ? { ...base, status: 'proposed', proposes: lower, replaces }
      : { ...base, status: 'active', closes: lower, replaces };
  });
}

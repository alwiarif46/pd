/**
 * Schedule date rules (05 s3.2, PR4). Pure functions with no imports, shared by the api's
 * adjust and seed routes and by the web schedule (`@pd/core/schedule`), so a preview in the
 * browser and the dates the server writes come from the same code.
 *
 * Dates are ISO calendar days, 'YYYY-MM-DD', with no time and no time zone.
 *
 * Workdays: with `workdaysOnly` (the bid's "Workdays only" setting, on by default), Saturdays,
 * Sundays, and US federal holidays (observed dates, 5 U.S.C. 6103) are skipped, and shift,
 * scale, and templates count workdays. With it off, every calendar day counts.
 */

// ---------------------------------------------------------------------------
// Value lists (migration 0010 holds the same lists as CHECK constraints)
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ['milestone', 'writing', 'review', 'production', 'submission', 'custom'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Color team of a review activity; only an activity of kind 'review' has one. */
export const REVIEW_COLORS = ['blue', 'pink', 'red', 'green', 'gold', 'white_glove'] as const;
export type ReviewColor = (typeof REVIEW_COLORS)[number];

/** 'ai': dated in a solicitation or amendment; 'user': added by hand; 'template': from a schedule template. */
export const ACTIVITY_ORIGINS = ['ai', 'user', 'template'] as const;
export type ActivityOrigin = (typeof ACTIVITY_ORIGINS)[number];

export const ADJUST_MODES = ['shift', 'scale', 'keep'] as const;
export type AdjustMode = (typeof ADJUST_MODES)[number];

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

export function isReviewColor(value: unknown): value is ReviewColor {
  return typeof value === 'string' && (REVIEW_COLORS as readonly string[]).includes(value);
}

export function isAdjustMode(value: unknown): value is AdjustMode {
  return typeof value === 'string' && (ADJUST_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Calendar days
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** True for a real calendar day written 'YYYY-MM-DD' ('2026-02-30' is false). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && toIsoDate(date) === value;
}

/** The UTC calendar day of `date`, 'YYYY-MM-DD'. Timestamps in the database are UTC midnight. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC midnight of an ISO day, the way the api stores schedule dates. */
export function fromIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function epochDay(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS;
}

function fromEpochDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addIsoDays(iso: string, days: number): string {
  return fromEpochDay(epochDay(iso) + days);
}

/** Calendar days from `from` to `to`: positive when `to` is later. */
export function diffIsoDays(from: string, to: string): number {
  return epochDay(to) - epochDay(from);
}

/** 0 Sunday to 6 Saturday. */
function weekday(iso: string): number {
  return new Date(epochDay(iso) * DAY_MS).getUTCDay();
}

export function isWeekend(iso: string): boolean {
  const day = weekday(iso);
  return day === 0 || day === 6;
}

// ---------------------------------------------------------------------------
// US federal holidays
// ---------------------------------------------------------------------------

export interface Holiday {
  /** The observed day, 'YYYY-MM-DD'. */
  date: string;
  name: string;
}

function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The `n`th `day` (0 Sunday) of `month` (1 to 12). */
function nthWeekday(year: number, month: number, day: number, n: number): string {
  const first = ymd(year, month, 1);
  return addIsoDays(first, ((day - weekday(first) + 7) % 7) + (n - 1) * 7);
}

/** The last `day` (0 Sunday) of `month` (1 to 12). */
function lastWeekday(year: number, month: number, day: number): string {
  const last = addIsoDays(month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1), -1);
  return addIsoDays(last, -((weekday(last) - day + 7) % 7));
}

/** A fixed-date holiday on a Saturday is observed the Friday before; on a Sunday, the Monday after. */
function observed(date: string, name: string): Holiday {
  const day = weekday(date);
  if (day === 6) return { date: addIsoDays(date, -1), name: `${name} (observed)` };
  if (day === 0) return { date: addIsoDays(date, 1), name: `${name} (observed)` };
  return { date, name };
}

function holidaysOf(year: number): Holiday[] {
  const list: Holiday[] = [
    observed(ymd(year, 1, 1), "New Year's Day"),
    { date: nthWeekday(year, 1, 1, 3), name: 'Martin Luther King Jr. Day' },
    { date: nthWeekday(year, 2, 1, 3), name: "Washington's Birthday" },
    { date: lastWeekday(year, 5, 1), name: 'Memorial Day' },
  ];
  if (year >= 2021) {
    list.push(observed(ymd(year, 6, 19), 'Juneteenth'));
  }
  list.push(
    observed(ymd(year, 7, 4), 'Independence Day'),
    { date: nthWeekday(year, 9, 1, 1), name: 'Labor Day' },
    { date: nthWeekday(year, 10, 1, 2), name: 'Columbus Day' },
    observed(ymd(year, 11, 11), 'Veterans Day'),
    { date: nthWeekday(year, 11, 4, 4), name: 'Thanksgiving Day' },
    observed(ymd(year, 12, 25), 'Christmas Day'),
  );
  return list;
}

const holidayCache = new Map<number, Map<string, string>>();

function holidayMap(year: number): Map<string, string> {
  let map = holidayCache.get(year);
  if (!map) {
    // Next year's New Year's Day is observed on 31 December when 1 January is a Saturday, and
    // this year's then falls in the year before: keep the observed days that land in `year`.
    const days = [...holidaysOf(year), ...holidaysOf(year + 1).slice(0, 1)]
      .filter((holiday) => holiday.date.startsWith(`${String(year).padStart(4, '0')}-`))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    map = new Map(days.map((holiday) => [holiday.date, holiday.name]));
    holidayCache.set(year, map);
  }
  return map;
}

/** The US federal holidays observed in `year`, by date. */
export function federalHolidays(year: number): Holiday[] {
  return [...holidayMap(year)].map(([date, name]) => ({ date, name }));
}

/** The federal holidays observed from `start` to `end`, both included. */
export function federalHolidaysBetween(start: string, end: string): Holiday[] {
  const list: Holiday[] = [];
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year += 1) {
    list.push(...federalHolidays(year).filter((holiday) => holiday.date >= start && holiday.date <= end));
  }
  return list;
}

/** The federal holiday observed on `date`, or null. */
export function federalHolidayName(date: string): string | null {
  return holidayMap(Number(date.slice(0, 4))).get(date) ?? null;
}

// ---------------------------------------------------------------------------
// Workdays
// ---------------------------------------------------------------------------

export interface DayRules {
  /** Skip weekends and federal holidays (the bid's "Workdays only" setting). */
  workdaysOnly: boolean;
  /** More days off, 'YYYY-MM-DD', counted only when `workdaysOnly` is on. */
  extraHolidays?: ReadonlySet<string>;
}

/** Every day counts when `workdaysOnly` is off. */
export function isWorkday(date: string, rules: DayRules): boolean {
  if (!rules.workdaysOnly) return true;
  return !isWeekend(date) && federalHolidayName(date) === null && !rules.extraHolidays?.has(date);
}

/** `date` when it counts, else the first later day that does. */
export function nextWorkday(date: string, rules: DayRules): string {
  let cursor = date;
  while (!isWorkday(cursor, rules)) cursor = addIsoDays(cursor, 1);
  return cursor;
}

/**
 * `n` counted days after `date` (before it when `n` is negative); `date` itself when `n` is 0.
 * With `workdaysOnly`, a nonzero `n` always lands on a workday. Long distances jump whole weeks
 * (counted with countWorkdays), so the cost does not grow with `n`.
 */
export function addWorkdays(date: string, n: number, rules: DayRules): string {
  if (!rules.workdaysOnly) return addIsoDays(date, n);
  let cursor = date;
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    if (left > 7) {
      // At most left - 1 weekdays in these whole weeks, so the jump never reaches the answer.
      const target = addIsoDays(cursor, step * Math.floor((left - 1) / 5) * 7);
      left -= step > 0
        ? countWorkdays(addIsoDays(cursor, 1), target, rules)
        : countWorkdays(target, addIsoDays(cursor, -1), rules);
      cursor = target;
      continue;
    }
    cursor = addIsoDays(cursor, step);
    if (isWorkday(cursor, rules)) left -= 1;
  }
  return cursor;
}

/** Mondays to Fridays from `start` to `end`, both included. */
function weekdaysBetween(start: string, end: string): number {
  const days = diffIsoDays(start, end) + 1;
  if (days <= 0) return 0;
  let total = Math.floor(days / 7) * 5;
  const first = weekday(start);
  for (let index = 0; index < days % 7; index += 1) {
    const day = (first + index) % 7;
    if (day !== 0 && day !== 6) total += 1;
  }
  return total;
}

/**
 * Counted days from `start` to `end`, both included; 0 when `end` is before `start`. Computed
 * from whole weeks minus the holidays in the range (observed federal holidays always fall on a
 * weekday), so the cost grows with the years spanned, not the days.
 */
export function countWorkdays(start: string, end: string, rules: DayRules): number {
  if (end < start) return 0;
  if (!rules.workdaysOnly) return diffIsoDays(start, end) + 1;
  let total = weekdaysBetween(start, end) - federalHolidaysBetween(start, end).length;
  for (const extra of rules.extraHolidays ?? []) {
    if (extra >= start && extra <= end && !isWeekend(extra) && federalHolidayName(extra) === null) total -= 1;
  }
  return total;
}

/**
 * The signed count of days from `from` to `to`: later, the counted days after `from` up to and
 * including `to`; earlier, minus the counted days from `to` up to but not including `from`. So
 * `addWorkdays(from, workdayDelta(from, to, rules), rules) === to` whenever `to` counts.
 */
export function workdayDelta(from: string, to: string, rules: DayRules): number {
  if (!rules.workdaysOnly) return diffIsoDays(from, to);
  if (to > from) return countWorkdays(addIsoDays(from, 1), to, rules);
  if (to < from) return -countWorkdays(to, addIsoDays(from, -1), rules);
  return 0;
}

// ---------------------------------------------------------------------------
// Shift, scale, keep
// ---------------------------------------------------------------------------

export interface AdjustableActivity {
  id: string;
  /** 'YYYY-MM-DD', or null for an activity with no date (never moved). */
  start: string | null;
  /** 'YYYY-MM-DD'; null means the same day as `start`. */
  end: string | null;
  locked: boolean;
  /** The kind; a locked 'submission' on the old due date is the due date itself and follows it. */
  kind?: ActivityKind;
}

export interface AdjustOptions {
  mode: AdjustMode;
  previousDue: string;
  nextDue: string;
  /** Where scale stretches from: the bid's start date. Scale shifts instead when it is null or not before both due dates. */
  anchor: string | null;
  workdaysOnly: boolean;
  extraHolidays?: ReadonlySet<string>;
}

export interface ActivityMove {
  id: string;
  previousStart: string;
  previousEnd: string;
  start: string;
  end: string;
  /** True for the locked submission that is the due date itself (it moves although locked). */
  followsDue: boolean;
}

export interface AdjustPlan {
  /** What was asked. */
  requestedMode: AdjustMode;
  /** What was done: 'shift' when a scale had no usable anchor. */
  mode: AdjustMode;
  /** 'workdays' with workdaysOnly, else 'days'. */
  unit: 'workdays' | 'days';
  /** The due date's move in `unit`s (signed). */
  delta: number;
  /** Activities whose dates change, in input order. Undated activities never appear; locked ones only when `followsDue`. */
  moves: ActivityMove[];
}

/**
 * Plans how unlocked activities follow a due-date change (05 s3.2, 09 s5.11):
 * - shift: every unlocked activity moves by the due date's move, counted in workdays (or days).
 *   Spacing in counted days stays the same.
 * - scale: the window from `anchor` to the due date is stretched or shrunk to the new due date.
 *   Each counted-day offset from the anchor is multiplied by new span / old span and rounded to
 *   the nearest day (halves round later); an end never comes before its start. Activities that
 *   start before the anchor stay. Without a usable anchor (null, or not before both due dates),
 *   scale shifts instead and `mode` says so.
 * - keep: nothing moves but the due date itself (below).
 * Locked activities and activities with no start date never move, with one exception: in every
 * mode, a locked activity of kind 'submission' that starts on `previousDue` is the due date
 * itself, so it moves to `nextDue` (keeping its length in calendar days), with `followsDue`.
 */
export function planScheduleAdjust(activities: readonly AdjustableActivity[], options: AdjustOptions): AdjustPlan {
  const rules: DayRules = { workdaysOnly: options.workdaysOnly, extraHolidays: options.extraHolidays };
  const unit = options.workdaysOnly ? 'workdays' : 'days';
  const delta = workdayDelta(options.previousDue, options.nextDue, rules);
  let mode = options.mode;
  let oldSpan = 0;
  let newSpan = 0;
  if (mode === 'scale') {
    const anchor = options.anchor;
    if (anchor !== null && anchor < options.previousDue && anchor < options.nextDue) {
      oldSpan = workdayDelta(anchor, options.previousDue, rules);
      newSpan = workdayDelta(anchor, options.nextDue, rules);
    }
    if (oldSpan <= 0 || newSpan <= 0) {
      mode = 'shift';
    }
  }
  const plan: AdjustPlan = { requestedMode: options.mode, mode, unit, delta, moves: [] };
  if (options.previousDue === options.nextDue) {
    return plan;
  }
  const anchor = options.anchor!;
  const scaled = (date: string) => {
    const offset = Math.round((workdayDelta(anchor, date, rules) * newSpan) / oldSpan);
    return offset === 0 ? nextWorkday(anchor, rules) : addWorkdays(anchor, offset, rules);
  };
  for (const activity of activities) {
    if (activity.start === null) continue;
    const previousStart = activity.start;
    const previousEnd = activity.end !== null && activity.end >= activity.start ? activity.end : activity.start;
    if (activity.locked) {
      if (activity.kind === 'submission' && previousStart === options.previousDue) {
        const end = addIsoDays(previousEnd, diffIsoDays(options.previousDue, options.nextDue));
        plan.moves.push({ id: activity.id, previousStart, previousEnd, start: options.nextDue, end, followsDue: true });
      }
      continue;
    }
    if (mode === 'keep') continue;
    let start: string;
    let end: string;
    if (mode === 'shift') {
      start = addWorkdays(previousStart, delta, rules);
      end = addWorkdays(previousEnd, delta, rules);
    } else {
      if (previousStart < anchor) continue;
      start = scaled(previousStart);
      end = scaled(previousEnd);
    }
    if (end < start) end = start;
    if (start !== previousStart || end !== previousEnd) {
      plan.moves.push({ id: activity.id, previousStart, previousEnd, start, end, followsDue: false });
    }
  }
  return plan;
}

/** `activities` with `moves` applied (for a preview). Activities not in `moves` are returned as they are. */
export function applyScheduleMoves<T extends { id: string; start: string | null; end: string | null }>(
  activities: readonly T[],
  moves: readonly ActivityMove[],
): T[] {
  const byId = new Map(moves.map((move) => [move.id, move]));
  return activities.map((activity) => {
    const move = byId.get(activity.id);
    return move ? { ...activity, start: move.start, end: move.end } : activity;
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface ScheduleTemplateItem {
  label: string;
  kind: ActivityKind;
  reviewColor: ReviewColor | null;
  /** Counted days before the due date that the activity starts. */
  startsBefore: number;
  /** Counted days the activity lasts (1: start and end are the same day). */
  length: number;
}

export interface ScheduleTemplate {
  id: string;
  name: string;
  description: string;
  items: readonly ScheduleTemplateItem[];
}

const item = (
  label: string,
  kind: ActivityKind,
  startsBefore: number,
  length: number,
  reviewColor: ReviewColor | null = null,
): ScheduleTemplateItem => ({ label, kind, reviewColor, startsBefore, length });

export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  {
    id: 'federal-standard',
    name: 'Federal standard (Pink, Red, Gold)',
    description: 'Three color team reviews with revision windows, for full RFP responses of 30 days or more.',
    items: [
      item('Kickoff meeting', 'milestone', 29, 1),
      item('Outline and compliance matrix', 'writing', 28, 4),
      item('First draft writing', 'writing', 24, 8),
      item('Pink team review', 'review', 16, 2, 'pink'),
      item('Revise after pink team', 'writing', 14, 4),
      item('Red team review', 'review', 10, 2, 'red'),
      item('Final revisions', 'writing', 8, 3),
      item('Gold team review', 'review', 5, 1, 'gold'),
      item('Production and packaging', 'production', 4, 2),
      item('White glove review', 'review', 2, 1, 'white_glove'),
    ],
  },
  {
    id: 'federal-fast',
    name: 'Fast turn (Red, Gold)',
    description: 'Two reviews for responses with two to three weeks to the due date.',
    items: [
      item('Kickoff meeting', 'milestone', 14, 1),
      item('First draft writing', 'writing', 13, 5),
      item('Red team review', 'review', 8, 1, 'red'),
      item('Final revisions', 'writing', 7, 3),
      item('Gold team review', 'review', 4, 1, 'gold'),
      item('Production and packaging', 'production', 3, 2),
    ],
  },
  {
    id: 'task-order',
    name: 'Task order (single Red)',
    description: 'One review and a short production window, for task orders and quick quotes.',
    items: [
      item('Kickoff meeting', 'milestone', 8, 1),
      item('First draft writing', 'writing', 7, 3),
      item('Red team review', 'review', 4, 1, 'red'),
      item('Production and packaging', 'production', 2, 1),
    ],
  },
];

export type ScheduleTemplateId = 'federal-standard' | 'federal-fast' | 'task-order';

export function findScheduleTemplate(id: unknown): ScheduleTemplate | null {
  return SCHEDULE_TEMPLATES.find((template) => template.id === id) ?? null;
}

export interface TemplateActivity {
  label: string;
  kind: ActivityKind;
  reviewColor: ReviewColor | null;
  start: string;
  end: string;
}

/**
 * A template's activities, counted back from `dueDate`: each starts `startsBefore` counted days
 * before the due date and lasts `length` counted days (workdays with `workdaysOnly`, else
 * calendar days, so a template is shorter on the calendar with the setting off).
 */
export function buildScheduleTemplate(template: ScheduleTemplate, dueDate: string, rules: DayRules): TemplateActivity[] {
  return template.items.map((entry) => {
    const start = addWorkdays(dueDate, -entry.startsBefore, rules);
    return {
      label: entry.label,
      kind: entry.kind,
      reviewColor: entry.reviewColor,
      start,
      end: addWorkdays(start, entry.length - 1, rules),
    };
  });
}

// ---------------------------------------------------------------------------
// Kind from a label
// ---------------------------------------------------------------------------

/**
 * The kind (and review color) a label suggests. Migration 0010 backfills existing rows with the
 * same rules in SQL; the api uses this when an activity is added without a kind.
 * - "<color> team..." (blue, pink, red, green, gold) and "white glove..." are reviews.
 * - "proposal due", "submit...", "due date..." and any "submission" are the submission.
 * - production, print, and packag(e/ing) are production.
 * - kickoff, meeting, released, questions, answers, site visit, and other "... due" dates are milestones.
 * - draft, writ(e/ing), storyboard, outline, revis(e/ion), and pricing are writing.
 * - anything else is custom.
 */
export function inferActivityKind(label: string): { kind: ActivityKind; reviewColor: ReviewColor | null } {
  const name = label.trim().toLowerCase();
  if (/^white[ -]glove\b/.test(name)) return { kind: 'review', reviewColor: 'white_glove' };
  const color = /^(blue|pink|red|green|gold)[ -]team\b/.exec(name);
  if (color) return { kind: 'review', reviewColor: color[1] as ReviewColor };
  if (/\bproposals? due\b|^submit|\bsubmission\b|^due date\b/.test(name)) return { kind: 'submission', reviewColor: null };
  if (/production|\bprint|packag/.test(name)) return { kind: 'production', reviewColor: null };
  if (/kickoff|kick-off|meeting|released|questions|answers|site visit|\bdue\b/.test(name)) return { kind: 'milestone', reviewColor: null };
  if (/draft|\bwrit|storyboard|outline|revis|pricing/.test(name)) return { kind: 'writing', reviewColor: null };
  return { kind: 'custom', reviewColor: null };
}

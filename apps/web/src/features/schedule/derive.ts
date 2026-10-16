import {
  federalHolidaysBetween,
  planScheduleAdjust,
  SCHEDULE_TEMPLATES,
  type AdjustPlan,
} from '@pd/core/schedule';
import type { BidDto, CreateRowBodyMap, RowPatchMap, ScheduleActivityDto } from '@/api';
import type {
  ActivityDraft,
  DateChangeMode,
  ScheduleActivity,
  ScheduleDateChange,
  ScheduleHoliday,
  ScheduleTemplateId,
  ScheduleTemplateOption,
} from '@/types';
import { amendmentMark } from '@/features/shared/amendment-mark';
import { formatDay, plural } from '@/schedule/format';

/** The calendar day of an API timestamp (UTC midnight of its day), never converted to local time. */
export function dayOf(ts: string | null): string | null {
  return ts ? ts.slice(0, 10) : null;
}

/** The viewer's local calendar day, 'YYYY-MM-DD'. */
export function localToday(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Milliseconds from `now` to the next local midnight (when `localToday` changes). */
export function msToNextLocalDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(0, next.getTime() - now.getTime());
}

/** An API activity in the ui contract shape. `rowIds` are the bid's activity ids (for a superseded row's jump). */
export function toScheduleActivity(dto: ScheduleActivityDto, rowIds: ReadonlySet<string>): ScheduleActivity {
  const start = dayOf(dto.startDate);
  return {
    id: dto.id,
    label: dto.label,
    kind: dto.kind,
    reviewColor: dto.reviewColor,
    start,
    end: dayOf(dto.endDate) ?? start,
    owner: dto.owner,
    locked: dto.locked,
    origin: dto.origin ?? (dto.documentId || dto.sourcePage !== null ? 'ai' : 'user'),
    sourcePage: dto.sourcePage,
    sourcePageEnd: dto.sourcePageEnd,
    sourceQuote: dto.sourceQuote,
    amendment: amendmentMark(dto, rowIds),
  };
}

/** By start day (undated last), then label. */
export function sortActivities(list: readonly ScheduleActivity[]): ScheduleActivity[] {
  return [...list].sort((a, b) => {
    if (a.start !== b.start) {
      if (a.start === null) return 1;
      if (b.start === null) return -1;
      return a.start < b.start ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });
}

const yearOf = (iso: string) => Number(iso.slice(0, 4));

/** US federal holidays from the year before the earliest day in view to the year after the latest. */
export function holidaysFor(input: {
  today: string;
  startDate: string | null;
  dueDate: string | null;
  activities: readonly ScheduleActivity[];
}): ScheduleHoliday[] {
  const firsts = [input.today, input.startDate, ...input.activities.map((a) => a.start)].filter(
    (d): d is string => d !== null,
  );
  const lasts = [input.today, input.dueDate, ...input.activities.map((a) => a.end ?? a.start)].filter(
    (d): d is string => d !== null,
  );
  const y0 = Math.min(...firsts.map(yearOf)) - 1;
  const y1 = Math.max(...lasts.map(yearOf)) + 1;
  return federalHolidaysBetween(`${y0}-01-01`, `${y1}-12-31`);
}

const TEMPLATE_IDS: readonly string[] = ['federal-standard', 'federal-fast', 'task-order'] satisfies ScheduleTemplateId[];

function isTemplateId(id: string): id is ScheduleTemplateId {
  return TEMPLATE_IDS.includes(id);
}

/** The core templates as the template dropdown shows them. */
export function templateOptions(): ScheduleTemplateOption[] {
  return SCHEDULE_TEMPLATES.flatMap((t) => (isTemplateId(t.id) ? [{ id: t.id, name: t.name, description: t.description }] : []));
}

/** Standard activity names: every template item once, in order, then the common solicitation dates. */
export const ACTIVITY_OPTIONS: string[] = [
  ...new Set([
    ...SCHEDULE_TEMPLATES.flatMap((t) => t.items.map((item) => item.label)),
    'Questions due',
    'Site visit',
    'Orals presentation',
    'Proposal due',
  ]),
];

/** '17:00' as '5:00 PM'; null when the value is not a time. */
function clockText(time: string): string | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return null;
  const h = Number(match[1]);
  if (h > 23) return null;
  return `${h % 12 === 0 ? 12 : h % 12}:${match[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Wed, Nov 25, 2026 at 5:00 PM (America/New_York)"; null without a due date. */
export function dueLabelOf(bid: Pick<BidDto, 'dueDate' | 'dueTime' | 'timeZone'> | null): string | null {
  const day = dayOf(bid?.dueDate ?? null);
  if (!bid || !day) return null;
  let label = formatDay(day);
  const clock = bid.dueTime ? clockText(bid.dueTime) : null;
  if (clock) label += ` at ${clock}`;
  if (bid.timeZone) label += ` (${bid.timeZone})`;
  return label;
}

const TOO_FAR = 'This would move activities too far. Choose another option.';
const MODES: readonly DateChangeMode[] = ['shift', 'scale', 'keep'];

/** One sentence per mode saying what it would do (09 s5.11), from the same plan the api runs. */
export function dateChangeSummary(
  activities: readonly ScheduleActivity[],
  change: Pick<ScheduleDateChange, 'previousDue' | 'nextDue'>,
  opts: { anchor: string | null; workdaysOnly: boolean },
): Record<DateChangeMode, string> {
  const dated = activities.filter((a) => a.start !== null);
  const input = dated.map((a) => ({ id: a.id, start: a.start, end: a.end, locked: a.locked, kind: a.kind }));
  const out = {} as Record<DateChangeMode, string>;
  for (const mode of MODES) {
    let plan: AdjustPlan;
    try {
      plan = planScheduleAdjust(input, {
        mode,
        previousDue: change.previousDue,
        nextDue: change.nextDue,
        anchor: opts.anchor,
        workdaysOnly: opts.workdaysOnly,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        out[mode] = TOO_FAR;
        continue;
      }
      throw error;
    }
    const n = plan.moves.filter((m) => !m.followsDue).length;
    const following = new Set(plan.moves.filter((m) => m.followsDue).map((m) => m.id));
    const follows = following.size > 0;
    const locked = dated.some((a) => a.locked && !following.has(a.id));
    const u = (k: number) => (plan.unit === 'workdays' ? (k === 1 ? 'workday' : 'workdays') : k === 1 ? 'day' : 'days');
    const unlocked = plural(n, '1 unlocked activity', `${n} unlocked activities`);
    const shiftSentence = () => {
      if (plan.delta === 0) return `The due date moves 0 ${u(0)}, so no unlocked activity moves.`;
      if (n === 0) return 'No unlocked activity has a date to move.';
      const d = Math.abs(plan.delta);
      return `Moves ${unlocked} ${d} ${u(d)} ${plan.delta > 0 ? 'later' : 'earlier'}.`;
    };
    let sentence: string;
    if (mode === 'keep') {
      out.keep = follows
        ? 'The submission moves to the new due date. Every other activity stays where it is.'
        : 'Every activity stays where it is.';
      continue;
    }
    if (mode === 'shift') {
      sentence = shiftSentence();
    } else if (plan.mode === 'shift') {
      sentence = `The bid has no start date before both due dates, so this shifts instead. ${shiftSentence()}`;
    } else if (n === 0) {
      sentence = 'No unlocked activity moves.';
    } else {
      sentence = `${change.nextDue > change.previousDue ? 'Stretches' : 'Squeezes'} ${unlocked} between the start date and the new due date.`;
    }
    if (follows) sentence += ' The submission moves to the new due date.';
    if (locked) sentence += ' Locked activities stay.';
    out[mode] = sentence;
  }
  return out;
}

/** "Add activity" as the create body. */
export function toCreateBody(d: ActivityDraft): CreateRowBodyMap['schedule'] {
  return {
    label: d.label,
    startDate: d.start,
    endDate: d.end,
    kind: d.kind,
    reviewColor: d.reviewColor,
    owner: d.owner,
    locked: d.locked,
  };
}

/** An edit as the row patch: only the keys present, with start and end renamed. */
export function toRowPatch(p: Partial<ActivityDraft>): RowPatchMap['schedule_activities'] {
  const patch: RowPatchMap['schedule_activities'] = {};
  if ('label' in p) patch.label = p.label;
  if ('kind' in p) patch.kind = p.kind;
  if ('reviewColor' in p) patch.reviewColor = p.reviewColor;
  if ('start' in p) patch.startDate = p.start;
  if ('end' in p) patch.endDate = p.end;
  if ('owner' in p) patch.owner = p.owner;
  if ('locked' in p) patch.locked = p.locked;
  return patch;
}

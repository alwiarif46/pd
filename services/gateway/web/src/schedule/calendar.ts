import { addIsoDays, diffIsoDays, fromIsoDate } from '@pd/core/schedule';
import type { ScheduleActivity } from '@/types';

/** Full Sunday-to-Saturday weeks covering the month, as ISO days. */
export function monthWeeks(month: string): string[][] {
  const first = `${month.slice(0, 7)}-01`;
  const firstDow = fromIsoDate(first).getUTCDay();
  const nextMonth = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 1));
  const last = addIsoDays(nextMonth.toISOString().slice(0, 10), -1);
  let day = addIsoDays(first, -firstDow);
  const weeks: string[][] = [];
  while (day <= last) {
    const week: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(day);
      day = addIsoDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export interface Segment {
  activity: ScheduleActivity;
  /** 0 to 6, the first column of the week the bar covers. */
  colStart: number;
  colEnd: number;
  lane: number;
  continuesLeft: boolean;
  continuesRight: boolean;
  /** The segment that carries the label: where the activity starts, or the first week shown. */
  primary: boolean;
}

interface Dated {
  activity: ScheduleActivity;
  start: string;
  end: string;
}

/**
 * Bars for one week, each in the first free lane. Undated activities are left out.
 * `firstWeek` marks the first week shown, where a bar that began earlier still carries its label.
 */
export function layoutWeek(week: string[], activities: ScheduleActivity[], firstWeek = false): Segment[] {
  const weekStart = week[0]!;
  const weekEnd = week[week.length - 1]!;
  const dated: Dated[] = [];
  for (const activity of activities) {
    if (activity.start === null) continue;
    const end = activity.end ?? activity.start;
    if (end < weekStart || activity.start > weekEnd) continue;
    dated.push({ activity, start: activity.start, end });
  }
  dated.sort((a, b) => {
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    const lengthA = diffIsoDays(a.start, a.end);
    const lengthB = diffIsoDays(b.start, b.end);
    if (lengthA !== lengthB) return lengthB - lengthA;
    return a.activity.label.localeCompare(b.activity.label);
  });
  const laneEnds: number[] = [];
  const segments: Segment[] = [];
  for (const item of dated) {
    const colStart = Math.max(0, diffIsoDays(weekStart, item.start));
    const colEnd = Math.min(week.length - 1, diffIsoDays(weekStart, item.end));
    let lane = laneEnds.findIndex((last) => last < colStart);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(colEnd);
    } else {
      laneEnds[lane] = colEnd;
    }
    segments.push({
      activity: item.activity,
      colStart,
      colEnd,
      lane,
      continuesLeft: item.start < weekStart,
      continuesRight: item.end > weekEnd,
      primary: item.start >= weekStart || firstWeek,
    });
  }
  return segments;
}

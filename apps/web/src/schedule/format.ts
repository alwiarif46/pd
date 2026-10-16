import { fromIsoDate } from '@pd/core/schedule';

// Every format uses UTC so a local time zone never shifts the day.
const DAY = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "Wed, Nov 25, 2026". */
export function formatDay(iso: string): string {
  return DAY.format(fromIsoDate(iso));
}

/** "Nov 25". */
export function formatShort(iso: string): string {
  return SHORT.format(fromIsoDate(iso));
}

/** "Nov 25" or "Nov 25 – Nov 27". */
export function formatRange(start: string, end: string | null): string {
  if (end === null || end === start) return formatShort(start);
  return `${formatShort(start)} – ${formatShort(end)}`;
}

/** "November 2026" from any day of the month. */
export function formatMonth(month: string): string {
  return MONTH.format(fromIsoDate(month));
}

/** The first day of the month holding `iso`, 'YYYY-MM-01'. */
export function monthOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** The first day of the month `n` months from `month`. */
export function addMonths(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + n;
  const year = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

/** "1 activity" or "3 activities". */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "12" or "12–13"; '' without a page. */
export function pageText(page: number | null, pageEnd: number | null): string {
  if (page === null) return '';
  return pageEnd !== null && pageEnd !== page ? `${page}–${pageEnd}` : String(page);
}

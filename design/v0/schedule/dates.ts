const DAY_MS = 86_400_000

export function toDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function toIso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  return toIso(new Date(toDate(iso).getTime() + days * DAY_MS))
}

/** Calendar days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS)
}

export function isWeekend(iso: string): boolean {
  const day = toDate(iso).getUTCDay()
  return day === 0 || day === 6
}

export function isWorkday(iso: string, holidays: Set<string>): boolean {
  return !isWeekend(iso) && !holidays.has(iso)
}

/** Workdays in the inclusive range. Returns 0 when end is before start. */
export function workdaysBetween(start: string, end: string, holidays: Set<string>): number {
  let count = 0
  for (let cur = start; cur <= end; cur = addDays(cur, 1)) {
    if (isWorkday(cur, holidays)) count += 1
  }
  return count
}

export function startOfWeek(iso: string): string {
  return addDays(iso, -toDate(iso).getUTCDay())
}

export function buildWeeks(rangeStart: string, rangeEnd: string): string[][] {
  const weeks: string[][] = []
  for (let cur = startOfWeek(rangeStart); cur <= rangeEnd; cur = addDays(cur, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cur, i)))
  }
  return weeks
}

function format(iso: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(toDate(iso))
}

export const formatShort = (iso: string) => format(iso, { month: 'short', day: '2-digit' })
export const formatDay = (iso: string) => format(iso, { weekday: 'short', month: 'short', day: 'numeric' })
export const formatLong = (iso: string) => format(iso, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
export const formatMonth = (iso: string) => format(iso, { month: 'long', year: 'numeric' })
export const dayOfMonth = (iso: string) => Number(iso.slice(8, 10))

export function formatRange(start: string, end: string): string {
  return start === end ? formatShort(start) : `${formatShort(start)} – ${formatShort(end)}`
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Preview-only container logic so the prototype is interactive.
// In the app these rules belong in the schedule feature/service, not in src/ui/.
import type { DateChange, DateChangeMode, ReviewColor, ScheduleActivity, ActivityKind } from './types'
import { addDays, diffDays, isWorkday, workdaysBetween } from './dates'

export function shiftByWorkdays(iso: string, workdays: number, holidays: Set<string>): string {
  let cur = iso
  let remaining = Math.abs(workdays)
  const step = workdays < 0 ? -1 : 1
  while (remaining > 0) {
    cur = addDays(cur, step)
    if (isWorkday(cur, holidays)) remaining -= 1
  }
  return cur
}

export function nextWorkday(iso: string, holidays: Set<string>): string {
  let cur = iso
  while (!isWorkday(cur, holidays)) cur = addDays(cur, 1)
  return cur
}

function signedWorkdayDelta(from: string, to: string, holidays: Set<string>): number {
  if (from === to) return 0
  return to > from ? workdaysBetween(addDays(from, 1), to, holidays) : -workdaysBetween(addDays(to, 1), from, holidays)
}

function isChangedTarget(a: ScheduleActivity, change: DateChange) {
  return a.locked && a.start === change.oldDate && (change.field === 'dueDate' ? a.kind === 'submission' : true)
}

export function resolveDateChange(
  activities: ScheduleActivity[],
  change: DateChange,
  mode: DateChangeMode,
  anchor: string,
  holidays: Set<string>,
): ScheduleActivity[] {
  const delta = signedWorkdayDelta(change.oldDate, change.newDate, holidays)
  const span = diffDays(anchor, change.oldDate)
  const ratio = span > 0 ? diffDays(anchor, change.newDate) / span : 1
  const scale = (iso: string) => nextWorkday(addDays(anchor, Math.round(diffDays(anchor, iso) * ratio)), holidays)

  return activities.map((a) => {
    if (isChangedTarget(a, change)) return { ...a, start: change.newDate, end: change.newDate, amendment: change.amendment ?? a.amendment }
    if (a.locked || mode === 'keep') return a
    if (mode === 'shift') return { ...a, start: shiftByWorkdays(a.start, delta, holidays), end: shiftByWorkdays(a.end, delta, holidays) }
    if (a.start < anchor) return a
    const start = scale(a.start)
    const end = scale(a.end)
    return { ...a, start, end: end < start ? start : end }
  })
}

export function summarizeDateChange(activities: ScheduleActivity[], change: DateChange, holidays: Set<string>): Record<DateChangeMode, string> {
  const movable = activities.filter((a) => !a.locked).length
  const delta = signedWorkdayDelta(change.oldDate, change.newDate, holidays)
  const direction = delta >= 0 ? 'later' : 'earlier'
  const abs = Math.abs(delta)
  return {
    shift: `Move all ${movable} movable activities ${abs} ${abs === 1 ? 'workday' : 'workdays'} ${direction}. Spacing between them stays the same.`,
    scale: `Stretch the ${movable} movable activities to fill the new window, so every phase gets proportionally more time.`,
    keep: `Leave the ${movable} movable activities where they are. Only the locked due date moves.`,
  }
}

interface TemplateItem {
  name: string
  kind: ActivityKind
  reviewColor?: ReviewColor
  /** Workdays before the due date that the activity starts. */
  startsBefore: number
  workdays: number
}

const TEMPLATE_ITEMS: Record<string, TemplateItem[]> = {
  'federal-standard': [
    { name: 'Kickoff meeting', kind: 'milestone', startsBefore: 29, workdays: 1 },
    { name: 'Outline and compliance matrix', kind: 'writing', startsBefore: 28, workdays: 4 },
    { name: 'First draft writing', kind: 'writing', startsBefore: 24, workdays: 8 },
    { name: 'Pink team review', kind: 'review', reviewColor: 'pink', startsBefore: 16, workdays: 2 },
    { name: 'Revise after pink team', kind: 'writing', startsBefore: 14, workdays: 4 },
    { name: 'Red team review', kind: 'review', reviewColor: 'red', startsBefore: 10, workdays: 2 },
    { name: 'Final revisions', kind: 'writing', startsBefore: 8, workdays: 3 },
    { name: 'Gold team review', kind: 'review', reviewColor: 'gold', startsBefore: 5, workdays: 1 },
    { name: 'Production and packaging', kind: 'production', startsBefore: 4, workdays: 2 },
    { name: 'White glove review', kind: 'review', reviewColor: 'white_glove', startsBefore: 2, workdays: 1 },
  ],
  'federal-fast': [
    { name: 'Kickoff meeting', kind: 'milestone', startsBefore: 14, workdays: 1 },
    { name: 'First draft writing', kind: 'writing', startsBefore: 13, workdays: 5 },
    { name: 'Red team review', kind: 'review', reviewColor: 'red', startsBefore: 8, workdays: 1 },
    { name: 'Final revisions', kind: 'writing', startsBefore: 7, workdays: 3 },
    { name: 'Gold team review', kind: 'review', reviewColor: 'gold', startsBefore: 4, workdays: 1 },
    { name: 'Production and packaging', kind: 'production', startsBefore: 3, workdays: 2 },
  ],
  'task-order': [
    { name: 'Kickoff meeting', kind: 'milestone', startsBefore: 8, workdays: 1 },
    { name: 'First draft writing', kind: 'writing', startsBefore: 7, workdays: 3 },
    { name: 'Red team review', kind: 'review', reviewColor: 'red', startsBefore: 4, workdays: 1 },
    { name: 'Production and packaging', kind: 'production', startsBefore: 2, workdays: 1 },
  ],
}

export function applyTemplate(templateId: string, activities: ScheduleActivity[], dueDate: string, holidays: Set<string>): ScheduleActivity[] {
  const items = TEMPLATE_ITEMS[templateId] ?? []
  const kept = activities.filter((a) => a.locked)
  const stamp = Date.now()
  const created = items.map((item, i) => {
    const start = shiftByWorkdays(dueDate, -item.startsBefore, holidays)
    return {
      id: `${templateId}-${i}-${stamp}`,
      name: item.name,
      kind: item.kind,
      reviewColor: item.reviewColor,
      start,
      end: shiftByWorkdays(start, item.workdays - 1, holidays),
      locked: false,
      origin: 'template' as const,
    }
  })
  return [...kept, ...created]
}

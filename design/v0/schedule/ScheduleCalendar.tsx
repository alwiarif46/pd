import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { ScheduleActivity } from './types'
import { addDays, buildWeeks, dayOfMonth, diffDays, formatMonth, formatRange, isWeekend, workdaysBetween, WEEKDAY_LABELS } from './dates'
import { isPointInTime, REVIEW_LABELS, KIND_LABELS, toneOf } from './activityMeta'
import { LockIcon } from './LockIcon'

interface ScheduleCalendarProps {
  activities: ScheduleActivity[]
  holidays: Map<string, string>
  today: string
  dueDate: string
  rangeStart: string
  rangeEnd: string
  selectedId?: string
  onSelect: (id: string) => void
  onMove: (id: string, start: string, end: string) => void
}

interface Segment {
  activity: ScheduleActivity
  colStart: number
  colEnd: number
  lane: number
  continuesLeft: boolean
  continuesRight: boolean
  primary: boolean
}

interface DragState {
  id: string
  anchor: string
  offset: number
  moved: boolean
}

function layoutWeek(week: string[], activities: ScheduleActivity[], isFirstWeek: boolean): Segment[] {
  const weekStart = week[0]
  const weekEnd = week[6]
  const inWeek = activities
    .filter((a) => a.end >= weekStart && a.start <= weekEnd)
    .sort((a, b) => a.start.localeCompare(b.start) || diffDays(b.start, b.end) - diffDays(a.start, a.end) || a.name.localeCompare(b.name))

  const laneEnds: number[] = []
  return inWeek.map((activity) => {
    const colStart = Math.max(0, diffDays(weekStart, activity.start))
    const colEnd = Math.min(6, diffDays(weekStart, activity.end))
    let lane = laneEnds.findIndex((end) => end < colStart)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(colEnd)
    } else {
      laneEnds[lane] = colEnd
    }
    return {
      activity,
      colStart,
      colEnd,
      lane,
      continuesLeft: activity.start < weekStart,
      continuesRight: activity.end > weekEnd,
      primary: activity.start >= weekStart || isFirstWeek,
    }
  })
}

function dateAtPoint(x: number, y: number): string | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const date = (el as HTMLElement).dataset?.date
    if (date) return date
  }
  return null
}

export function ScheduleCalendar({ activities, holidays, today, dueDate, rangeStart, rangeEnd, selectedId, onSelect, onMove }: ScheduleCalendarProps) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const suppressClick = useRef(false)
  const focusAfterMove = useRef<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const holidaySet = useMemo(() => new Set(holidays.keys()), [holidays])

  const weeks = useMemo(() => buildWeeks(rangeStart, rangeEnd), [rangeStart, rangeEnd])

  const shown = useMemo(() => {
    if (!drag || drag.offset === 0) return activities
    return activities.map((a) => (a.id === drag.id ? { ...a, start: addDays(a.start, drag.offset), end: addDays(a.end, drag.offset) } : a))
  }, [activities, drag])

  const dragTarget = useMemo(() => {
    if (!drag || !drag.moved) return null
    const a = shown.find((item) => item.id === drag.id)
    return a ? { start: a.start, end: a.end } : null
  }, [drag, shown])

  const dragId = drag?.id
  const dragAnchor = drag?.anchor

  useEffect(() => {
    if (!dragId || !dragAnchor) return

    function handleMove(event: PointerEvent) {
      const date = dateAtPoint(event.clientX, event.clientY)
      if (!date || !dragAnchor) return
      const offset = diffDays(dragAnchor, date)
      setDrag((cur) => (cur && cur.offset !== offset ? { ...cur, offset, moved: true } : cur))
    }

    function handleUp() {
      const cur = dragRef.current
      if (cur?.moved) {
        suppressClick.current = true
        window.setTimeout(() => {
          suppressClick.current = false
        }, 0)
        if (cur.offset !== 0) {
          const activity = activities.find((a) => a.id === cur.id)
          if (activity) {
            focusAfterMove.current = cur.id
            onMove(cur.id, addDays(activity.start, cur.offset), addDays(activity.end, cur.offset))
          }
        }
      }
      setDrag(null)
    }

    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setDrag(null)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      window.removeEventListener('keydown', handleKey)
    }
  }, [dragId, dragAnchor, activities, onMove])

  useEffect(() => {
    if (!focusAfterMove.current) return
    const target = gridRef.current?.querySelector<HTMLElement>(`[data-activity="${focusAfterMove.current}"][data-primary="true"]`)
    target?.focus()
    focusAfterMove.current = null
  })

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, activity: ScheduleActivity) {
    if (activity.locked || event.button !== 0) return
    const anchor = dateAtPoint(event.clientX, event.clientY)
    if (!anchor) return
    setDrag({ id: activity.id, anchor, offset: 0, moved: false })
  }

  function handleBarKey(event: KeyboardEvent<HTMLButtonElement>, activity: ScheduleActivity) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    if (activity.locked) return
    const step = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 7 : 1)
    focusAfterMove.current = activity.id
    onMove(activity.id, addDays(activity.start, step), addDays(activity.end, step))
  }

  function barLabel(a: ScheduleActivity) {
    const kind = a.kind === 'review' && a.reviewColor ? REVIEW_LABELS[a.reviewColor] : KIND_LABELS[a.kind]
    const days = workdaysBetween(a.start, a.end, holidaySet)
    const parts = [a.name, formatRange(a.start, a.end), `${days} ${days === 1 ? 'workday' : 'workdays'}`, kind]
    if (a.owner) parts.push(`owner ${a.owner}`)
    parts.push(a.locked ? 'locked' : 'use arrow keys to move by a day, Shift for a week')
    return parts.join(', ')
  }

  return (
    <div className={`sch-calendar ${drag?.moved ? 'is-dragging' : ''}`} ref={gridRef}>
      <p className="sr-only">Calendar view. The milestone list shows the same activities as a table.</p>
      <div className="sch-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label, i) => (
          <span key={label} className={i === 0 || i === 6 ? 'is-weekend' : undefined}>
            {label}
          </span>
        ))}
      </div>

      {weeks.map((week, weekIndex) => {
        const segments = layoutWeek(week, shown, weekIndex === 0)
        const lanes = Math.max(2, segments.reduce((max, s) => Math.max(max, s.lane + 1), 0))
        const firstOfMonth = week.find((d) => dayOfMonth(d) === 1)
        const monthHeading = weekIndex === 0 ? formatMonth(week[6]) : firstOfMonth ? formatMonth(firstOfMonth) : null

        return (
          <div key={week[0]} className="sch-week-block">
            {monthHeading ? <h3 className="sch-month">{monthHeading}</h3> : null}
            <div
              className="sch-week"
              role="group"
              aria-label={`Week of ${formatRange(week[0], week[6])}`}
              style={{ gridTemplateRows: `var(--sch-day-head) repeat(${lanes}, var(--sch-lane)) 6px` }}
            >
              {week.map((date, col) => {
                const holiday = holidays.get(date)
                const inTarget = dragTarget && date >= dragTarget.start && date <= dragTarget.end
                const classes = [
                  'sch-day',
                  isWeekend(date) ? 'is-weekend' : '',
                  holiday ? 'is-holiday' : '',
                  date === today ? 'is-today' : '',
                  date === dueDate ? 'is-due' : '',
                  inTarget ? 'is-target' : '',
                  dayOfMonth(date) === 1 ? 'is-month-start' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <div key={date} className={classes} data-date={date} style={{ gridColumn: col + 1 }} title={holiday}>
                    <span className="sch-daynum">{String(dayOfMonth(date)).padStart(2, '0')}</span>
                    {date === today ? <span className="sch-day-tag today">Today</span> : null}
                    {date === dueDate ? <span className="sch-day-tag due">Due</span> : null}
                    {holiday && date !== dueDate && date !== today ? <span className="sch-holiday-name">{holiday}</span> : null}
                  </div>
                )
              })}

              {segments.map((seg) => {
                const a = seg.activity
                const point = isPointInTime(a)
                const classes = [
                  'sch-bar',
                  `tone-${toneOf(a)}`,
                  point ? 'is-point' : '',
                  a.locked ? 'is-locked' : 'is-movable',
                  seg.continuesLeft ? 'cont-left' : '',
                  seg.continuesRight ? 'cont-right' : '',
                  selectedId === a.id ? 'is-selected' : '',
                  drag?.id === a.id && drag.moved ? 'is-ghost' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <button
                    key={`${a.id}-${week[0]}`}
                    type="button"
                    className={classes}
                    data-activity={a.id}
                    data-primary={seg.primary}
                    tabIndex={seg.primary ? 0 : -1}
                    aria-hidden={seg.primary ? undefined : true}
                    aria-label={barLabel(a)}
                    title={`${a.name} · ${formatRange(a.start, a.end)}`}
                    style={{ gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 2}`, gridRow: seg.lane + 2 }}
                    onPointerDown={(e) => startDrag(e, a)}
                    onKeyDown={(e) => handleBarKey(e, a)}
                    onClick={() => {
                      if (suppressClick.current) return
                      onSelect(a.id)
                    }}
                  >
                    {point ? <span className="sch-bar-diamond" aria-hidden="true" /> : null}
                    {a.locked ? <LockIcon size={10} /> : null}
                    <span className="sch-bar-label">{a.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

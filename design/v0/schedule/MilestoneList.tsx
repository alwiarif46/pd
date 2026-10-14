import { Fragment, useMemo } from 'react'
import type { ScheduleActivity } from './types'
import { formatDay, formatShort, workdaysBetween } from './dates'
import { KIND_LABELS, ORIGIN_LABELS, REVIEW_LABELS, toneOf } from './activityMeta'
import { LockIcon } from './LockIcon'

interface MilestoneListProps {
  activities: ScheduleActivity[]
  holidays: Set<string>
  today: string
  selectedId?: string
  onSelect: (id: string) => void
  onToggleLock: (id: string, locked: boolean) => void
  onOpenSource: (page: number, quote: string) => void
}

export function MilestoneList({ activities, holidays, today, selectedId, onSelect, onToggleLock, onOpenSource }: MilestoneListProps) {
  const sorted = useMemo(
    () => [...activities].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.name.localeCompare(b.name)),
    [activities],
  )
  const todayIndex = sorted.findIndex((a) => a.end >= today)

  return (
    <div className="sch-table-wrap" role="region" aria-label="Milestone list" tabIndex={0}>
      <table className="sch-table">
        <caption className="sr-only">Proposal activities in date order. Select an activity to see its details.</caption>
        <thead>
          <tr>
            <th scope="col">Activity</th>
            <th scope="col">Start</th>
            <th scope="col">End</th>
            <th scope="col" className="num">Workdays</th>
            <th scope="col">Owner</th>
            <th scope="col">Lock</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a, index) => {
            const days = workdaysBetween(a.start, a.end, holidays)
            const kind = a.kind === 'review' && a.reviewColor ? REVIEW_LABELS[a.reviewColor] : KIND_LABELS[a.kind]
            const past = a.end < today
            return (
              <Fragment key={a.id}>
                {index === todayIndex ? (
                  <tr className="sch-today-row" aria-hidden="true">
                    <td colSpan={7}>
                      <span>Today · {formatDay(today)}</span>
                    </td>
                  </tr>
                ) : null}
                <tr className={`${past ? 'is-past' : ''} ${selectedId === a.id ? 'is-selected' : ''}`} onClick={() => onSelect(a.id)}>
                  <td>
                    <div className="sch-activity-cell">
                      <span className={`sch-swatch tone-${toneOf(a)}`} aria-hidden="true" />
                      <div>
                        <button
                          type="button"
                          className="sch-row-button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onSelect(a.id)
                          }}
                        >
                          {a.name}
                        </button>
                        <span className="sch-kind">
                          {kind}
                          {past ? ' · Past' : ''}
                        </span>
                        {a.amendment ? <span className="sch-amd-tag">Changed by Amd {a.amendment}</span> : null}
                      </div>
                    </div>
                  </td>
                  <td className="sch-date-cell">{formatShort(a.start)}</td>
                  <td className="sch-date-cell">{a.end === a.start ? <span className="sch-dim">—</span> : formatShort(a.end)}</td>
                  <td className="num sch-date-cell">{days}</td>
                  <td>{a.owner ? a.owner : <span className="sch-dim">Unassigned</span>}</td>
                  <td>
                    <button
                      type="button"
                      className={`sch-lock-toggle ${a.locked ? 'is-locked' : ''}`}
                      aria-pressed={a.locked}
                      aria-label={`${a.locked ? 'Unlock' : 'Lock'} ${a.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleLock(a.id, !a.locked)
                      }}
                    >
                      <LockIcon open={!a.locked} />
                      <span>{a.locked ? 'Locked' : 'Movable'}</span>
                    </button>
                  </td>
                  <td>
                    {a.sourcePage && a.sourceQuote ? (
                      <button
                        type="button"
                        className="sch-source-link"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenSource(a.sourcePage!, a.sourceQuote!)
                        }}
                      >
                        Source · p. {a.sourcePage}
                      </button>
                    ) : (
                      <span className="sch-dim">{ORIGIN_LABELS[a.origin]}</span>
                    )}
                  </td>
                </tr>
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

import { useId, useState, type FormEvent } from 'react'
import type { Holiday, ScheduleActivity } from './types'
import { formatDay, formatShort } from './dates'
import { LockIcon } from './LockIcon'

interface ScheduleRailProps {
  activities: ScheduleActivity[]
  holidays: Holiday[]
  onSelect: (id: string) => void
  onOpenSource: (page: number, quote: string) => void
  onAddHoliday: (holiday: Holiday) => void
  onRemoveHoliday: (date: string) => void
}

export function ScheduleRail({ activities, holidays, onSelect, onOpenSource, onAddHoliday, onRemoveHoliday }: ScheduleRailProps) {
  const ids = useId()
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const solicitationDates = activities.filter((a) => a.origin === 'ai').sort((a, b) => a.start.localeCompare(b.start))
  const sortedHolidays = [...holidays].sort((a, b) => a.date.localeCompare(b.date))

  function addHoliday(event: FormEvent) {
    event.preventDefault()
    if (!date || !name.trim()) {
      setError('Enter both a date and a name.')
      return
    }
    if (holidays.some((h) => h.date === date)) {
      setError(`${formatDay(date)} is already a holiday.`)
      return
    }
    onAddHoliday({ date, name: name.trim() })
    setDate('')
    setName('')
    setError(null)
  }

  return (
    <div className="sch-rail">
      <section className="sch-card" aria-labelledby={`${ids}-sol`}>
        <div className="sch-card-head">
          <h2 id={`${ids}-sol`}>Solicitation dates</h2>
          <span className="sch-count">{solicitationDates.length}</span>
        </div>
        {solicitationDates.length ? (
          <ul className="sch-key-dates">
            {solicitationDates.map((a) => (
              <li key={a.id}>
                <span className="sch-key-date">{formatShort(a.start)}</span>
                <div>
                  <button type="button" className="sch-row-button" onClick={() => onSelect(a.id)}>
                    {a.name}
                  </button>
                  <span className="sch-key-meta">
                    {a.locked ? (
                      <>
                        <LockIcon size={10} /> Locked
                      </>
                    ) : (
                      'Unlocked'
                    )}
                    {a.amendment ? <span className="sch-amd-tag">Amd {a.amendment}</span> : null}
                  </span>
                </div>
                {a.sourcePage && a.sourceQuote ? (
                  <button type="button" className="sch-source-link" onClick={() => onOpenSource(a.sourcePage!, a.sourceQuote!)}>
                    p. {a.sourcePage}
                    <span className="sr-only"> source for {a.name}</span>
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="sch-card-empty">No dates extracted yet.</p>
        )}
        <p className="sch-card-foot">Dates from the solicitation arrive locked, with a link to the page they came from.</p>
      </section>

      <section className="sch-card" aria-labelledby={`${ids}-hol`}>
        <div className="sch-card-head">
          <h2 id={`${ids}-hol`}>Holidays</h2>
          <span className="sch-count">{holidays.length}</span>
        </div>
        <ul className="sch-holidays">
          {sortedHolidays.map((h) => (
            <li key={h.date}>
              <span className="sch-key-date">{formatShort(h.date)}</span>
              <span className="sch-holiday-label">{h.name}</span>
              <button type="button" className="sch-text-button quiet" onClick={() => onRemoveHoliday(h.date)}>
                Remove<span className="sr-only"> {h.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <form className="sch-holiday-form" onSubmit={addHoliday} noValidate>
          <div className="sch-field">
            <label htmlFor={`${ids}-hdate`}>Date</label>
            <input id={`${ids}-hdate`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="sch-field">
            <label htmlFor={`${ids}-hname`}>Holiday name</label>
            <input id={`${ids}-hname`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <button type="submit" className="sch-button">
            Add holiday
          </button>
          {error ? (
            <p className="sch-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
        <p className="sch-card-foot">Holidays and weekends are skipped when workdays are counted.</p>
      </section>
    </div>
  )
}

export function ScheduleLegend() {
  const items: { tone: string; label: string }[] = [
    { tone: 'writing', label: 'Writing' },
    { tone: 'review-pink', label: 'Pink' },
    { tone: 'review-red', label: 'Red' },
    { tone: 'review-gold', label: 'Gold' },
    { tone: 'review-white_glove', label: 'White glove' },
    { tone: 'production', label: 'Production' },
    { tone: 'submission', label: 'Due' },
  ]
  return (
    <ul className="sch-legend" aria-label="Legend">
      {items.map((item) => (
        <li key={item.tone}>
          <span className={`sch-swatch tone-${item.tone}`} aria-hidden="true" />
          {item.label}
        </li>
      ))}
      <li>
        <span className="sch-swatch is-weekend-swatch" aria-hidden="true" />
        Weekend
      </li>
      <li>
        <span className="sch-swatch is-holiday-swatch" aria-hidden="true" />
        Holiday
      </li>
      <li>
        <span className="sch-swatch is-today-swatch" aria-hidden="true" />
        Today
      </li>
    </ul>
  )
}

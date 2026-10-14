import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { ActivityDraft, ActivityKind, ReviewColor, ScheduleActivity } from './types'
import { formatLong, workdaysBetween } from './dates'
import { inferFromName, KIND_LABELS, ORIGIN_LABELS, REVIEW_LABELS } from './activityMeta'
import { LockIcon } from './LockIcon'

const CUSTOM = '__custom__'

interface ActivityPanelProps {
  activity?: ScheduleActivity
  defaultStart: string
  activityOptions: string[]
  holidays: Set<string>
  onSave: (draft: ActivityDraft) => void
  onDelete?: () => void
  onOpenSource: (page: number, quote: string) => void
  onClose: () => void
}

export function ActivityPanel({ activity, defaultStart, activityOptions: standardOptions, holidays, onSave, onDelete, onOpenSource, onClose }: ActivityPanelProps) {
  const ids = useId()
  const isEdit = Boolean(activity)
  const activityOptions =
    activity && activity.origin !== 'user' && !standardOptions.includes(activity.name) ? [activity.name, ...standardOptions] : standardOptions
  const initialName = activity?.name ?? activityOptions[0] ?? ''
  const initialIsStandard = activityOptions.includes(initialName)
  const initialInferred = inferFromName(initialName)

  const [nameChoice, setNameChoice] = useState(initialIsStandard ? initialName : CUSTOM)
  const [customName, setCustomName] = useState(initialIsStandard ? '' : initialName)
  const [kind, setKind] = useState<ActivityKind>(activity?.kind ?? initialInferred.kind)
  const [reviewColor, setReviewColor] = useState<ReviewColor>(activity?.reviewColor ?? initialInferred.reviewColor ?? 'pink')
  const [start, setStart] = useState(activity?.start ?? defaultStart)
  const [end, setEnd] = useState(activity?.end ?? defaultStart)
  const [owner, setOwner] = useState(activity?.owner ?? '')
  const [locked, setLocked] = useState(activity?.locked ?? false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLSelectElement>(null)
  const cancelDeleteRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  useEffect(() => {
    if (confirmingDelete) cancelDeleteRef.current?.focus()
  }, [confirmingDelete])

  const name = nameChoice === CUSTOM ? customName.trim() : nameChoice
  const workdays = end >= start ? workdaysBetween(start, end, holidays) : 0
  const titleId = `${ids}-title`
  const errorId = `${ids}-error`

  function chooseName(value: string) {
    setNameChoice(value)
    if (value !== CUSTOM) {
      const inferred = inferFromName(value)
      setKind(inferred.kind)
      if (inferred.reviewColor) setReviewColor(inferred.reviewColor)
    }
  }

  function changeStart(value: string) {
    setStart(value)
    if (value && end < value) setEnd(value)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!name) {
      setError('Enter a name for the custom activity.')
      return
    }
    if (!start || !end) {
      setError('Choose a start date and an end date.')
      return
    }
    if (end < start) {
      setError('The end date must be on or after the start date.')
      return
    }
    setError(null)
    onSave({ name, kind, reviewColor: kind === 'review' ? reviewColor : undefined, start, end, owner: owner.trim() || undefined, locked })
  }

  return (
    <aside
      className="sch-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="sch-panel-head">
        <div>
          <p className="sch-eyebrow">{isEdit ? 'Activity detail' : 'New activity'}</p>
          <h2 id={titleId}>{isEdit ? activity!.name : 'Add an activity'}</h2>
        </div>
        <button type="button" className="sch-icon-button" aria-label="Close activity panel" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <form className="sch-panel-body" onSubmit={submit} noValidate>
        {activity?.sourceQuote ? (
          <section className="sch-source-block" aria-label="Source">
            <p className="sch-field-label">Verbatim source text</p>
            <blockquote>{activity.sourceQuote}</blockquote>
            <dl className="sch-meta">
              <div>
                <dt>Document</dt>
                <dd>{activity.documentName ?? 'Solicitation'}</dd>
              </div>
              <div>
                <dt>Page</dt>
                <dd>{activity.sourcePage}</dd>
              </div>
              <div>
                <dt>Amendment</dt>
                <dd>{activity.amendment ? `Changed by Amd ${activity.amendment}` : 'Original'}</dd>
              </div>
              <div>
                <dt>Origin</dt>
                <dd>{ORIGIN_LABELS[activity.origin]}</dd>
              </div>
            </dl>
            {activity.sourcePage ? (
              <button type="button" className="sch-text-button" onClick={() => onOpenSource(activity.sourcePage!, activity.sourceQuote!)}>
                Open source
              </button>
            ) : null}
          </section>
        ) : activity ? (
          <p className="sch-origin-note">{ORIGIN_LABELS[activity.origin]}</p>
        ) : null}

        <div className="sch-field">
          <label htmlFor={`${ids}-name`}>Activity</label>
          <select id={`${ids}-name`} ref={firstFieldRef} value={nameChoice} onChange={(e) => chooseName(e.target.value)}>
            {activityOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            <option value={CUSTOM}>Custom activity…</option>
          </select>
        </div>

        {nameChoice === CUSTOM ? (
          <div className="sch-field">
            <label htmlFor={`${ids}-custom`}>Custom activity name</label>
            <input
              id={`${ids}-custom`}
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              aria-invalid={Boolean(error && !name)}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
        ) : null}

        <div className="sch-field-row">
          <div className="sch-field">
            <label htmlFor={`${ids}-kind`}>Type</label>
            <select id={`${ids}-kind`} value={kind} onChange={(e) => setKind(e.target.value as ActivityKind)}>
              {(Object.keys(KIND_LABELS) as ActivityKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          {kind === 'review' ? (
            <div className="sch-field">
              <label htmlFor={`${ids}-color`}>Color team</label>
              <select id={`${ids}-color`} value={reviewColor} onChange={(e) => setReviewColor(e.target.value as ReviewColor)}>
                {(Object.keys(REVIEW_LABELS) as ReviewColor[]).map((c) => (
                  <option key={c} value={c}>
                    {REVIEW_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <div className="sch-field-row">
          <div className="sch-field">
            <label htmlFor={`${ids}-start`}>Start date</label>
            <input id={`${ids}-start`} type="date" value={start} disabled={locked} onChange={(e) => changeStart(e.target.value)} />
          </div>
          <div className="sch-field">
            <label htmlFor={`${ids}-end`}>End date</label>
            <input
              id={`${ids}-end`}
              type="date"
              value={end}
              min={start}
              disabled={locked}
              onChange={(e) => setEnd(e.target.value)}
              aria-invalid={Boolean(error && end < start)}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
        </div>
        <p className="sch-hint">
          {workdays} {workdays === 1 ? 'workday' : 'workdays'}
          {start ? ` · starts ${formatLong(start)}` : ''}
        </p>

        <div className="sch-field">
          <label htmlFor={`${ids}-owner`}>Owner</label>
          <input id={`${ids}-owner`} value={owner} onChange={(e) => setOwner(e.target.value)} autoComplete="off" />
        </div>

        <div className="sch-check">
          <input id={`${ids}-lock`} type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
          <label htmlFor={`${ids}-lock`}>
            <LockIcon open={!locked} /> Lock this date
          </label>
        </div>
        <p className="sch-hint">
          {locked
            ? 'Locked dates stay put when you drag, shift, or scale the schedule. Unlock to change them.'
            : 'Movable dates follow the schedule when dates change.'}
        </p>

        {error ? (
          <p id={errorId} className="sch-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="sch-panel-foot">
          {confirmingDelete && activity ? (
            <div className="sch-delete-confirm" role="group" aria-label="Confirm delete">
              <p>
                Delete <strong>{activity.name}</strong>? This cannot be undone.
              </p>
              <div className="sch-button-row">
                <button type="button" ref={cancelDeleteRef} className="sch-button" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
                <button type="button" className="sch-button danger" onClick={onDelete}>
                  Delete activity
                </button>
              </div>
            </div>
          ) : (
            <div className="sch-button-row">
              {isEdit && onDelete ? (
                <button type="button" className="sch-text-button danger" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </button>
              ) : null}
              <span className="sch-spacer" />
              <button type="button" className="sch-button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="sch-button primary">
                {isEdit ? 'Save changes' : 'Add activity'}
              </button>
            </div>
          )}
        </footer>
      </form>
    </aside>
  )
}

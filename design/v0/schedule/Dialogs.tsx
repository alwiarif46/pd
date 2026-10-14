import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { DateChange, DateChangeMode } from './types'
import { formatDay, formatShort } from './dates'

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return ref
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, children, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useModal(open)
  const titleId = useId()
  return (
    <dialog ref={ref} className="sch-dialog" aria-labelledby={titleId} onClose={onCancel}>
      {open ? (
        <div className="sch-dialog-body">
          <h2 id={titleId}>{title}</h2>
          <div className="sch-dialog-text">{children}</div>
          <div className="sch-button-row end">
            <button type="button" className="sch-button" autoFocus onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="sch-button primary" onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  )
}

const MODE_COPY: Record<DateChangeMode, { title: string; fallback: string }> = {
  shift: { title: 'Shift', fallback: 'Move every movable activity by the same number of workdays.' },
  scale: { title: 'Scale', fallback: 'Stretch or squeeze movable activities to fit the new window.' },
  keep: { title: 'Keep', fallback: 'Leave movable activities where they are. Only locked dates change.' },
}

interface DateChangeDialogProps {
  open: boolean
  change: DateChange
  summary?: Record<DateChangeMode, string>
  onResolve: (mode: DateChangeMode) => void
  onOpenSource: (page: number, quote: string) => void
  onClose: () => void
}

export function DateChangeDialog({ open, change, summary, onResolve, onOpenSource, onClose }: DateChangeDialogProps) {
  const ref = useModal(open)
  const ids = useId()
  const [mode, setMode] = useState<DateChangeMode>('shift')
  const fieldLabel = change.field === 'dueDate' ? 'due date' : 'start date'
  const who = change.amendment ? `Amendment ${change.amendment}` : 'A date change'

  return (
    <dialog ref={ref} className="sch-dialog wide" aria-labelledby={`${ids}-title`} onClose={onClose}>
      {open ? (
        <form
          className="sch-dialog-body"
          onSubmit={(e) => {
            e.preventDefault()
            onResolve(mode)
          }}
        >
          <p className="sch-eyebrow">Date change</p>
          <h2 id={`${ids}-title`}>
            {who} moved the {fieldLabel}
          </h2>
          <div className="sch-date-shift" aria-label={`From ${formatDay(change.oldDate)} to ${formatDay(change.newDate)}`}>
            <span className="sch-date-old">
              <s>{formatShort(change.oldDate)}</s>
              <small>Was</small>
            </span>
            <span className="sch-arrow" aria-hidden="true">
              →
            </span>
            <span className="sch-date-new">
              {formatShort(change.newDate)}
              <small>Now</small>
            </span>
            {change.sourcePage && change.sourceQuote ? (
              <button type="button" className="sch-source-link" onClick={() => onOpenSource(change.sourcePage!, change.sourceQuote!)}>
                Source · p. {change.sourcePage}
              </button>
            ) : null}
          </div>

          <fieldset className="sch-mode-group">
            <legend>How should the rest of the schedule follow?</legend>
            {(Object.keys(MODE_COPY) as DateChangeMode[]).map((m, i) => (
              <label key={m} className={`sch-mode ${mode === m ? 'is-chosen' : ''}`}>
                <input type="radio" name={`${ids}-mode`} value={m} checked={mode === m} autoFocus={i === 0} onChange={() => setMode(m)} />
                <span>
                  <strong>{MODE_COPY[m].title}</strong>
                  <span>{summary?.[m] ?? MODE_COPY[m].fallback}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="sch-button-row end">
            <button type="button" className="sch-button" onClick={onClose}>
              Decide later
            </button>
            <button type="submit" className="sch-button primary">
              Apply {MODE_COPY[mode].title.toLowerCase()}
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  )
}

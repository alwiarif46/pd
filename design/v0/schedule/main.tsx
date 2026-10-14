import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ScheduleTab from './ScheduleTab'
import './schedule.css'
import type { DateChange, DateChangeMode, Holiday, ProcessingState, ScheduleActivity, ScheduleExportFormat } from './types'
import { activityOptions, sampleActivities, sampleDateChange, sampleHolidays, SAMPLE_BID, sampleTemplates } from './sampleData'
import { applyTemplate, resolveDateChange, summarizeDateChange } from './scheduleRules'
import { formatRange } from './dates'

type PreviewState = 'ready' | 'amendment' | 'processing' | 'failed' | 'empty' | 'no-solicitation'

const PREVIEW_STATES: { value: PreviewState; label: string }[] = [
  { value: 'ready', label: 'Ready' },
  { value: 'amendment', label: 'Amendment moved due date' },
  { value: 'processing', label: 'Processing' },
  { value: 'failed', label: 'Processing failed' },
  { value: 'empty', label: 'No dates found' },
  { value: 'no-solicitation', label: 'No solicitation' },
]

const DONE: ProcessingState = { stage: 'done', percent: 100 }

function download(filename: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function toCsv(activities: ScheduleActivity[]) {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`
  const rows = activities.map((a) => [a.name, a.kind, a.start, a.end, a.owner ?? '', a.locked ? 'Locked' : 'Movable'].map(escape).join(','))
  return ['Activity,Type,Start,End,Owner,Lock', ...rows].join('\n')
}

function toIcs(activities: ScheduleActivity[]) {
  const compact = (iso: string) => iso.replace(/-/g, '')
  const plusOne = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  const events = activities.map((a) =>
    ['BEGIN:VEVENT', `UID:${a.id}@shaavir-pd`, `DTSTART;VALUE=DATE:${compact(a.start)}`, `DTEND;VALUE=DATE:${compact(plusOne(a.end))}`, `SUMMARY:${a.name}`, 'END:VEVENT'].join('\r\n'),
  )
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Shaavir PD//Schedule//EN', ...events, 'END:VCALENDAR'].join('\r\n')
}

function Preview() {
  const [previewState, setPreviewState] = useState<PreviewState>('ready')
  const [activities, setActivities] = useState<ScheduleActivity[]>(sampleActivities)
  const [holidays, setHolidays] = useState<Holiday[]>(sampleHolidays)
  const [dueDate, setDueDate] = useState(SAMPLE_BID.dueDate)
  const [dateChange, setDateChange] = useState<DateChange | null>(null)
  const [source, setSource] = useState<{ page: number; quote: string } | null>(null)
  const [toast, setToast] = useState('')
  const sourceRef = useRef<HTMLDialogElement>(null)
  const holidaySet = useMemo(() => new Set(holidays.map((h) => h.date)), [holidays])

  useEffect(() => {
    const dialog = sourceRef.current
    if (!dialog) return
    if (source && !dialog.open) dialog.showModal()
    if (!source && dialog.open) dialog.close()
  }, [source])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  function choosePreviewState(next: PreviewState) {
    setPreviewState(next)
    setDueDate(SAMPLE_BID.dueDate)
    setActivities(next === 'empty' || next === 'no-solicitation' ? [] : next === 'processing' ? sampleActivities.filter((a) => a.origin === 'ai').slice(0, 2) : sampleActivities)
    setDateChange(next === 'amendment' ? sampleDateChange : null)
  }

  const processing: ProcessingState =
    previewState === 'processing'
      ? { stage: 'verify', percent: 64, message: 'Checking 9 dates against the pages they came from.', etaSeconds: 90 }
      : previewState === 'failed'
        ? { stage: 'failed', percent: 0, message: 'Page 14 of Amendment 2 could not be read.' }
        : DONE

  const updateActivity = useCallback((id: string, patch: Partial<ScheduleActivity>) => {
    setActivities((cur) => cur.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }, [])

  const handleMove = useCallback(
    (id: string, start: string, end: string) => {
      const a = activities.find((item) => item.id === id)
      updateActivity(id, { start, end })
      if (a) setToast(`Moved ${a.name} to ${formatRange(start, end)}.`)
    },
    [activities, updateActivity],
  )

  function handleResolve(mode: DateChangeMode) {
    if (!dateChange) return
    setActivities((cur) => resolveDateChange(cur, dateChange, mode, SAMPLE_BID.today, holidaySet))
    if (dateChange.field === 'dueDate') setDueDate(dateChange.newDate)
    setDateChange(null)
    setToast(mode === 'keep' ? 'Due date updated. Other activities kept their dates.' : `Schedule updated with ${mode}.`)
  }

  function handleExport(format: ScheduleExportFormat) {
    if (format === 'print') return window.print()
    if (format === 'csv') download('schedule.csv', 'text/csv', toCsv(activities))
    if (format === 'ics') download('schedule.ics', 'text/calendar', toIcs(activities))
    setToast(format === 'xlsx' ? 'The Excel workbook is generated by the app. This preview exports CSV and ICS.' : `Downloaded schedule.${format}.`)
  }

  return (
    <div className="preview-shell">
      <header className="topbar-preview">
        <span>Shaavir PD</span>
        <span>{SAMPLE_BID.name} · 42 days left</span>
      </header>
      <div className="preview-body">
        <aside className="preview-sidebar" aria-label="Bid sections">
          <p>Workspace</p>
          <div>Overview</div>
          <div className="active" aria-current="page">
            Schedule
          </div>
          <div>Compliance matrix</div>
          <div>Outline</div>
          <div>Reviews</div>
          <p>Bid</p>
          <div>Documents</div>
          <div>Settings</div>
        </aside>
        <main>
          <div className="preview-controls">
            <label htmlFor="preview-state">Preview state</label>
            <select id="preview-state" value={previewState} onChange={(e) => choosePreviewState(e.target.value as PreviewState)}>
              {PREVIEW_STATES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <ScheduleTab
            bidName={SAMPLE_BID.name}
            activities={activities}
            holidays={holidays}
            templates={sampleTemplates}
            activityOptions={activityOptions}
            today={SAMPLE_BID.today}
            startDate={SAMPLE_BID.startDate}
            dueDate={dueDate}
            dueLabel={dueDate === SAMPLE_BID.dueDate ? SAMPLE_BID.dueLabel : undefined}
            hasSolicitation={previewState !== 'no-solicitation'}
            processing={processing}
            dateChange={dateChange}
            dateChangeSummary={dateChange ? summarizeDateChange(activities, dateChange, holidaySet) : undefined}
            onAddActivity={(draft) => {
              setActivities((cur) => [...cur, { ...draft, id: `user-${Date.now()}`, origin: 'user' }])
              setToast(`Added ${draft.name}.`)
            }}
            onEditActivity={(id, patch) => {
              updateActivity(id, patch)
              setToast('Activity saved.')
            }}
            onDeleteActivity={(id) => {
              setActivities((cur) => cur.filter((a) => a.id !== id))
              setToast('Activity deleted.')
            }}
            onMoveActivity={handleMove}
            onToggleLock={(id, locked) => updateActivity(id, { locked })}
            onApplyTemplate={(id) => {
              setActivities((cur) => applyTemplate(id, cur, dueDate, holidaySet))
              if (previewState === 'empty') setPreviewState('ready')
              setToast('Template applied.')
            }}
            onResolveDateChange={handleResolve}
            onAddHoliday={(h) => setHolidays((cur) => [...cur, h])}
            onRemoveHoliday={(date) => setHolidays((cur) => cur.filter((h) => h.date !== date))}
            onOpenSource={(page, quote) => setSource({ page, quote })}
            onExport={handleExport}
            onRetry={() => choosePreviewState('processing')}
            onUploadSolicitation={() => choosePreviewState('processing')}
          />
        </main>
      </div>

      <dialog ref={sourceRef} className="sch-dialog" aria-labelledby="source-title" onClose={() => setSource(null)}>
        {source ? (
          <div className="sch-dialog-body">
            <p className="sch-eyebrow">Source viewer · preview stand-in</p>
            <h2 id="source-title">RFP DOT-24-1187.pdf · page {source.page}</h2>
            <blockquote className="preview-quote">
              <mark>{source.quote}</mark>
            </blockquote>
            <div className="sch-button-row end">
              <button type="button" className="sch-button primary" autoFocus onClick={() => setSource(null)}>
                Close
              </button>
            </div>
          </div>
        ) : null}
      </dialog>

      <div className="preview-toast" role="status" aria-live="polite">
        {toast ? <span>{toast}</span> : null}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
)

import { useEffect, useMemo, useRef, useState } from 'react'
import './schedule.css'
import type { ActivityDraft, ProcessingState, ScheduleExportFormat, ScheduleTabProps, ScheduleView } from './types'
import { addDays, diffDays, formatDay, formatShort, workdaysBetween } from './dates'
import { ScheduleCalendar } from './ScheduleCalendar'
import { MilestoneList } from './MilestoneList'
import { ActivityPanel } from './ActivityPanel'
import { ConfirmDialog, DateChangeDialog } from './Dialogs'
import { ScheduleLegend, ScheduleRail } from './ScheduleRail'

type PanelState = { mode: 'add' } | { mode: 'edit'; id: string } | null

const STAGE_LABELS: Record<ProcessingState['stage'], string> = {
  idle: 'Waiting to start',
  scanning: 'Scanning files',
  extracting: 'Reading pages',
  classifying: 'Sorting documents',
  extract: 'Finding dates',
  verify: 'Checking every date against its source',
  map: 'Placing dates on the schedule',
  done: 'Done',
  failed: 'Failed',
}

const EXPORTS: { format: ScheduleExportFormat; label: string; hint: string }[] = [
  { format: 'xlsx', label: 'Excel workbook', hint: '.xlsx' },
  { format: 'ics', label: 'Calendar file', hint: '.ics' },
  { format: 'csv', label: 'Spreadsheet', hint: '.csv' },
  { format: 'print', label: 'Print view', hint: 'PDF' },
]

export function ScheduleTab({
  bidName,
  activities,
  holidays,
  templates,
  activityOptions,
  today,
  startDate,
  dueDate,
  dueLabel,
  hasSolicitation,
  processing,
  dateChange,
  dateChangeSummary,
  onAddActivity,
  onEditActivity,
  onDeleteActivity,
  onMoveActivity,
  onToggleLock,
  onApplyTemplate,
  onResolveDateChange,
  onAddHoliday,
  onRemoveHoliday,
  onOpenSource,
  onExport,
  onRetry,
  onUploadSolicitation,
}: ScheduleTabProps) {
  const [view, setView] = useState<ScheduleView>('calendar')
  const [panel, setPanel] = useState<PanelState>(null)
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '')
  const [confirmTemplate, setConfirmTemplate] = useState(false)
  const [dateDialogOpen, setDateDialogOpen] = useState(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const exportMenuRef = useRef<HTMLDetailsElement>(null)
  const seenChangeRef = useRef<string | null>(null)

  const holidayMap = useMemo(() => new Map(holidays.map((h) => [h.date, h.name])), [holidays])
  const holidaySet = useMemo(() => new Set(holidayMap.keys()), [holidayMap])

  useEffect(() => {
    if (dateChange && seenChangeRef.current !== dateChange.id) {
      seenChangeRef.current = dateChange.id
      setDateDialogOpen(true)
    }
    if (!dateChange) setDateDialogOpen(false)
  }, [dateChange])

  const selected = panel?.mode === 'edit' ? activities.find((a) => a.id === panel.id) : undefined
  useEffect(() => {
    if (panel?.mode === 'edit' && !selected) setPanel(null)
  }, [panel, selected])

  const rangeStart = activities.reduce((min, a) => (a.start < min ? a.start : min), startDate < today ? startDate : today)
  const rangeEnd = activities.reduce((max, a) => (a.end > max ? a.end : max), dueDate)

  const daysLeft = diffDays(today, dueDate)
  const workdaysLeft = daysLeft > 0 ? workdaysBetween(addDays(today, 1), dueDate, holidaySet) : 0
  const next = [...activities].filter((a) => a.start > today).sort((a, b) => a.start.localeCompare(b.start))[0]
  const unlockedCount = activities.filter((a) => !a.locked).length
  const chosenTemplate = templates.find((t) => t.id === templateId)
  const isProcessing = !['idle', 'done', 'failed'].includes(processing.stage)
  const isEmpty = activities.length === 0

  function openPanel(next: PanelState) {
    returnFocusRef.current = document.activeElement as HTMLElement | null
    setPanel(next)
  }

  function closePanel() {
    setPanel(null)
    const target = returnFocusRef.current
    requestAnimationFrame(() => {
      if (target && document.contains(target)) target.focus()
    })
  }

  function save(draft: ActivityDraft) {
    if (panel?.mode === 'edit') onEditActivity(panel.id, draft)
    else onAddActivity(draft)
    closePanel()
  }

  function runExport(format: ScheduleExportFormat) {
    if (exportMenuRef.current) exportMenuRef.current.open = false
    onExport(format)
  }

  return (
    <section className="sch-tab" aria-labelledby="sch-title">
      <div className="sch-heading">
        <div>
          <p className="sch-eyebrow">Schedule</p>
          <h1 id="sch-title">{bidName}</h1>
          <p className="sch-lede">Every date from the solicitation, plus the work your team needs to hit them.</p>
        </div>
        {hasSolicitation ? (
          <div className="sch-countdown" aria-label={`${workdaysLeft} workdays until the due date`}>
            <span className="sch-countdown-number">{workdaysLeft}</span>
            <span className="sch-countdown-label">workdays left</span>
            <span className="sch-countdown-sub">
              {daysLeft} calendar days · due {dueLabel ?? formatDay(dueDate)}
            </span>
            {next ? (
              <span className="sch-countdown-next">
                Next: <strong>{next.name}</strong> {formatShort(next.start)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {dateChange ? (
        <div className="sch-banner warning" role="status">
          <span className="sch-banner-icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>
              {dateChange.amendment ? `Amendment ${dateChange.amendment}` : 'A new document'} moved the {dateChange.field === 'dueDate' ? 'due date' : 'start date'} from{' '}
              {formatShort(dateChange.oldDate)} to {formatShort(dateChange.newDate)}.
            </strong>
            <p>Choose whether the rest of the schedule shifts, scales, or stays put.</p>
          </div>
          <button type="button" className="sch-button" onClick={() => setDateDialogOpen(true)}>
            Review date change
          </button>
        </div>
      ) : null}

      {isProcessing ? (
        <div className="sch-banner info" role="status" aria-live="polite">
          <div className="sch-banner-progress">
            <strong>{STAGE_LABELS[processing.stage]}…</strong>
            <p>
              {processing.message ?? 'Dates appear here as they are found.'}
              {processing.etaSeconds ? ` About ${Math.max(1, Math.round(processing.etaSeconds / 60))} min left.` : ''}
            </p>
            <div className="sch-progress" role="progressbar" aria-label="Processing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={processing.percent}>
              <span style={{ width: `${processing.percent}%` }} />
            </div>
          </div>
        </div>
      ) : null}

      {processing.stage === 'failed' ? (
        <div className="sch-banner danger" role="alert">
          <span className="sch-banner-icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>We could not read the dates from this solicitation.</strong>
            <p>{processing.message ?? 'Something went wrong while processing the documents.'} Your schedule has not changed.</p>
          </div>
          <button type="button" className="sch-button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}

      {!hasSolicitation ? (
        <div className="sch-empty">
          <h2>No solicitation yet</h2>
          <p>Upload the solicitation set and its dates will appear here, locked and linked to the page they came from. You can also start from a template.</p>
          <div className="sch-button-row center">
            <button type="button" className="sch-button primary" onClick={onUploadSolicitation}>
              Upload solicitation
            </button>
            <button type="button" className="sch-button" onClick={() => openPanel({ mode: 'add' })}>
              Add an activity by hand
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="sch-toolbar" role="toolbar" aria-label="Schedule tools">
            <div className="sch-segmented" role="group" aria-label="View">
              <button type="button" aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>
                Calendar
              </button>
              <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
                Milestones
              </button>
            </div>

            <div className="sch-template">
              <label htmlFor="sch-template-select" className="sr-only">
                Schedule template
              </label>
              <select id="sch-template-select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button type="button" className="sch-button" disabled={!chosenTemplate} onClick={() => setConfirmTemplate(true)}>
                Apply template
              </button>
            </div>

            <span className="sch-spacer" />

            <details className="sch-menu" ref={exportMenuRef}>
              <summary className="sch-button">Export</summary>
              <div className="sch-menu-list" role="group" aria-label="Export formats">
                {EXPORTS.map((item) => (
                  <button key={item.format} type="button" onClick={() => runExport(item.format)}>
                    <span>{item.label}</span>
                    <span className="sch-dim">{item.hint}</span>
                  </button>
                ))}
              </div>
            </details>

            <button type="button" className="sch-button primary" onClick={() => openPanel({ mode: 'add' })}>
              <span aria-hidden="true">+</span> Add activity
            </button>
          </div>

          <div className="sch-grid">
            <section className="sch-main-panel" aria-label={view === 'calendar' ? 'Calendar' : 'Milestones'}>
              {isEmpty ? (
                <div className="sch-empty in-panel">
                  <h2>{isProcessing ? 'Looking for dates…' : 'No dates found yet'}</h2>
                  <p>
                    {isProcessing
                      ? 'Extracted dates will appear here as soon as they are verified.'
                      : 'We did not find any dates in the solicitation. Start from a template or add activities by hand.'}
                  </p>
                  {!isProcessing ? (
                    <div className="sch-button-row center">
                      <button type="button" className="sch-button primary" onClick={() => setConfirmTemplate(true)} disabled={!chosenTemplate}>
                        Apply {chosenTemplate?.name ?? 'template'}
                      </button>
                      <button type="button" className="sch-button" onClick={() => openPanel({ mode: 'add' })}>
                        Add activity
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : view === 'calendar' ? (
                <>
                  <div className="sch-panel-intro">
                    <p>Drag a movable activity to a new day, or focus it and use the arrow keys. Locked dates stay put.</p>
                    <ScheduleLegend />
                  </div>
                  <ScheduleCalendar
                    activities={activities}
                    holidays={holidayMap}
                    today={today}
                    dueDate={dueDate}
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    selectedId={selected?.id}
                    onSelect={(id) => openPanel({ mode: 'edit', id })}
                    onMove={onMoveActivity}
                  />
                </>
              ) : (
                <MilestoneList
                  activities={activities}
                  holidays={holidaySet}
                  today={today}
                  selectedId={selected?.id}
                  onSelect={(id) => openPanel({ mode: 'edit', id })}
                  onToggleLock={onToggleLock}
                  onOpenSource={onOpenSource}
                />
              )}
            </section>

            <ScheduleRail
              activities={activities}
              holidays={holidays}
              onSelect={(id) => openPanel({ mode: 'edit', id })}
              onOpenSource={onOpenSource}
              onAddHoliday={onAddHoliday}
              onRemoveHoliday={onRemoveHoliday}
            />
          </div>
        </>
      )}

      {panel ? (
        <ActivityPanel
          key={panel.mode === 'edit' ? panel.id : 'new'}
          activity={selected}
          defaultStart={today}
          activityOptions={activityOptions}
          holidays={holidaySet}
          onSave={save}
          onDelete={
            selected
              ? () => {
                  onDeleteActivity(selected.id)
                  setPanel(null)
                }
              : undefined
          }
          onOpenSource={onOpenSource}
          onClose={closePanel}
        />
      ) : null}

      <ConfirmDialog
        open={confirmTemplate}
        title={`Apply ${chosenTemplate?.name ?? 'template'}?`}
        confirmLabel="Apply template"
        onCancel={() => setConfirmTemplate(false)}
        onConfirm={() => {
          setConfirmTemplate(false)
          if (chosenTemplate) onApplyTemplate(chosenTemplate.id)
        }}
      >
        <p>{chosenTemplate?.description}</p>
        <p>
          {unlockedCount > 0
            ? `This replaces the ${unlockedCount} movable ${unlockedCount === 1 ? 'activity' : 'activities'} on the schedule. Locked dates stay where they are.`
            : 'Template activities are placed around your locked dates.'}
        </p>
      </ConfirmDialog>

      {dateChange ? (
        <DateChangeDialog
          key={dateChange.id}
          open={dateDialogOpen}
          change={dateChange}
          summary={dateChangeSummary}
          onOpenSource={onOpenSource}
          onClose={() => setDateDialogOpen(false)}
          onResolve={(mode) => {
            setDateDialogOpen(false)
            onResolveDateChange(mode)
          }}
        />
      ) : null}
    </section>
  )
}

export default ScheduleTab

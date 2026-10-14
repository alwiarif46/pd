// ProcessingState mirrors the shared type in @/types (09-ui-workflow s5.12).
// On integration, import it from @/types instead of redefining it here.
export interface ProcessingState {
  stage: 'idle' | 'scanning' | 'extracting' | 'classifying' | 'extract' | 'verify' | 'map' | 'done' | 'failed'
  percent: number
  message?: string
  etaSeconds?: number
}

export type ActivityKind = 'milestone' | 'writing' | 'review' | 'production' | 'submission' | 'custom'
export type ReviewColor = 'blue' | 'pink' | 'red' | 'green' | 'gold' | 'white_glove'
export type ActivityOrigin = 'ai' | 'user' | 'template'

export interface ScheduleActivity {
  id: string
  name: string
  kind: ActivityKind
  /** ISO date, YYYY-MM-DD */
  start: string
  /** ISO date, YYYY-MM-DD, inclusive */
  end: string
  owner?: string
  locked: boolean
  reviewColor?: ReviewColor
  origin: ActivityOrigin
  sourcePage?: number
  sourceQuote?: string
  documentName?: string
  amendment?: number
}

export type ActivityDraft = Omit<ScheduleActivity, 'id' | 'origin' | 'sourcePage' | 'sourceQuote' | 'documentName' | 'amendment'>

export interface Holiday {
  date: string
  name: string
}

export interface ScheduleTemplate {
  id: string
  name: string
  description: string
}

export interface DateChange {
  id: string
  field: 'dueDate' | 'startDate'
  oldDate: string
  newDate: string
  amendment?: number
  sourcePage?: number
  sourceQuote?: string
}

export type DateChangeMode = 'shift' | 'scale' | 'keep'
export type ScheduleView = 'calendar' | 'list'
export type ScheduleExportFormat = 'xlsx' | 'ics' | 'csv' | 'print'

export interface ScheduleTabProps {
  bidName: string
  activities: ScheduleActivity[]
  holidays: Holiday[]
  templates: ScheduleTemplate[]
  /** Standard activity names offered in the activity dropdown. */
  activityOptions: string[]
  today: string
  startDate: string
  dueDate: string
  dueLabel?: string
  hasSolicitation: boolean
  processing: ProcessingState
  dateChange: DateChange | null
  /** One plain sentence per mode describing what it would do, computed by the container. */
  dateChangeSummary?: Record<DateChangeMode, string>
  onAddActivity: (draft: ActivityDraft) => void
  onEditActivity: (id: string, patch: Partial<ActivityDraft>) => void
  onDeleteActivity: (id: string) => void
  onMoveActivity: (id: string, start: string, end: string) => void
  onToggleLock: (id: string, locked: boolean) => void
  onApplyTemplate: (templateId: string) => void
  onResolveDateChange: (mode: DateChangeMode) => void
  onAddHoliday: (holiday: Holiday) => void
  onRemoveHoliday: (date: string) => void
  onOpenSource: (page: number, quote: string) => void
  onExport: (format: ScheduleExportFormat) => void
  onRetry: () => void
  onUploadSolicitation: () => void
}

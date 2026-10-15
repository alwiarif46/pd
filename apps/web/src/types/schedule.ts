// Schedule: docs/plans/05-ui.md section 3.2. Not a v0 screen: Claude Code ports it into
// src/schedule/ (09 s6), using the prototype on origin/v0/schedule-prototype as a visual reference.
// Dates are 'YYYY-MM-DD'. The date rules (workdays, US federal holidays, shift, scale, keep,
// templates) are shared with the api: import them from '@pd/core/schedule', never re-implement them.
import type { AmendmentMark } from './shared';

/** packages/core ACTIVITY_KINDS. */
export type ActivityKind = 'milestone' | 'writing' | 'review' | 'production' | 'submission' | 'custom';
/** packages/core REVIEW_COLORS; only a 'review' has one. Tokens: bg-team-blue/-pink/-red/-green/-gold/-white-glove. */
export type ReviewColor = 'blue' | 'pink' | 'red' | 'green' | 'gold' | 'white_glove';
/** 'ai': from the solicitation or an amendment (has a source); 'user': added by hand; 'template': from a template. */
export type ActivityOrigin = 'ai' | 'user' | 'template';
export type DateChangeMode = 'shift' | 'scale' | 'keep';
export type ScheduleTemplateId = 'federal-standard' | 'federal-fast' | 'task-order';
export type ScheduleView = 'calendar' | 'list';
export type ScheduleExportFormat = 'xlsx' | 'ics' | 'csv' | 'print';

export interface ScheduleActivity {
  id: string;
  label: string;
  kind: ActivityKind;
  reviewColor: ReviewColor | null;
  /** null: not dated yet (an AI date the user has not placed, or a row added without a date). */
  start: string | null;
  /** Inclusive; equals `start` for a one-day activity. */
  end: string | null;
  owner: string | null;
  locked: boolean;
  origin: ActivityOrigin;
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
  amendment: AmendmentMark;
}

/** What "Add activity" and the activity panel send. */
export interface ActivityDraft {
  label: string;
  kind: ActivityKind;
  reviewColor: ReviewColor | null;
  start: string | null;
  end: string | null;
  owner: string | null;
  locked: boolean;
}

export interface ScheduleHoliday {
  date: string;
  name: string;
}

export interface ScheduleTemplateOption {
  id: ScheduleTemplateId;
  name: string;
  description: string;
}

/**
 * A due-date change waiting for the shift, scale, or keep answer. From Bid settings it has no
 * source; PR5 adds amendment changes with the page and quote they came from.
 */
export interface ScheduleDateChange {
  previousDue: string;
  nextDue: string;
  amendmentNo: number | null;
  sourcePage: number | null;
  sourceQuote: string | null;
}

export interface ScheduleTabProps {
  activities: ScheduleActivity[];
  /** Federal holidays in view (federalHolidaysBetween from '@pd/core/schedule'). */
  holidays: ScheduleHoliday[];
  templates: ScheduleTemplateOption[];
  /** Standard activity names offered in the activity dropdown. */
  activityOptions: string[];
  today: string;
  startDate: string | null;
  dueDate: string | null;
  /** e.g. "Wed, Nov 25 at 5:00 PM ET"; null when the bid has no due date. */
  dueLabel: string | null;
  /** The bid's "Workdays only" setting. */
  workdaysOnly: boolean;
  selectedRowId: string | null;
  dateChange: ScheduleDateChange | null;
  /** One plain sentence per mode saying what it would do, computed by the container with planScheduleAdjust. */
  dateChangeSummary: Record<DateChangeMode, string> | null;
  onAddActivity: (draft: ActivityDraft) => void;
  onEditActivity: (id: string, patch: Partial<ActivityDraft>) => void;
  onDeleteActivity: (id: string) => void;
  onMoveActivity: (id: string, start: string, end: string) => void;
  onToggleLock: (id: string, locked: boolean) => void;
  /** `replace`: the unlocked activities are removed first. */
  onApplyTemplate: (templateId: ScheduleTemplateId, replace: boolean) => void;
  onSetWorkdaysOnly: (workdaysOnly: boolean) => void;
  onResolveDateChange: (mode: DateChangeMode) => void;
  onCancelDateChange: () => void;
  onOpenRow: (id: string) => void;
  onOpenSource: (id: string) => void;
  onExport: (format: ScheduleExportFormat) => void;
}

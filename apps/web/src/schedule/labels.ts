import type {
  ActivityKind,
  ActivityOrigin,
  AmendmentMark,
  ReviewColor,
  ScheduleActivity,
  ScheduleExportFormat,
} from '@/types';

export const KIND_LABELS: Record<ActivityKind, string> = {
  milestone: 'Milestone',
  writing: 'Writing',
  review: 'Color team review',
  production: 'Production',
  submission: 'Submission',
  custom: 'Custom',
};

export const REVIEW_LABELS: Record<ReviewColor, string> = {
  blue: 'Blue team',
  pink: 'Pink team',
  red: 'Red team',
  green: 'Green team',
  gold: 'Gold team',
  white_glove: 'White glove',
};

export const ORIGIN_LABELS: Record<ActivityOrigin, string> = {
  ai: 'From the solicitation',
  user: 'Added by user',
  template: 'From template',
};

/** Full literal class strings, so Tailwind finds them. */
export const BAR_CLASSES: Record<string, string> = {
  milestone: 'bg-ink text-paper',
  submission: 'bg-due text-paper',
  writing: 'bg-primary text-primary-foreground',
  production: 'bg-muted-foreground text-paper',
  custom: 'bg-paper text-ink border border-line',
  'review-blue': 'bg-team-blue text-paper',
  'review-pink': 'bg-team-pink text-ink',
  'review-red': 'bg-team-red text-paper',
  'review-green': 'bg-team-green text-paper',
  'review-gold': 'bg-team-gold text-ink',
  'review-white_glove': 'bg-team-white-glove text-ink border border-line',
};

/** The key into BAR_CLASSES for an activity. */
export function toneOf(a: Pick<ScheduleActivity, 'kind' | 'reviewColor'>): string {
  if (a.kind === 'review') return `review-${a.reviewColor ?? 'blue'}`;
  return a.kind;
}

/** The kind label, or the review label for a review. */
export function kindText(a: Pick<ScheduleActivity, 'kind' | 'reviewColor'>): string {
  return a.kind === 'review' && a.reviewColor ? REVIEW_LABELS[a.reviewColor] : KIND_LABELS[a.kind];
}

export function amendmentText(mark: AmendmentMark): string | null {
  switch (mark.kind) {
    case 'original':
      return null;
    case 'added':
      return `Added by Amd ${mark.amendmentNo}`;
    case 'superseded':
      return `Superseded by Amd ${mark.amendmentNo}`;
    case 'withdrawn':
      return `Withdrawn by Amd ${mark.amendmentNo}`;
  }
}

export const EXPORT_OPTIONS: { format: ScheduleExportFormat; label: string }[] = [
  { format: 'xlsx', label: 'Excel workbook (.xlsx)' },
  { format: 'ics', label: 'Calendar file (.ics)' },
  { format: 'csv', label: 'Spreadsheet (.csv)' },
  { format: 'print', label: 'Print' },
];

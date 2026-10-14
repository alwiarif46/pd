import type { ActivityKind, ActivityOrigin, ReviewColor, ScheduleActivity } from './types'

export const KIND_LABELS: Record<ActivityKind, string> = {
  milestone: 'Milestone',
  writing: 'Writing',
  review: 'Color team review',
  production: 'Production',
  submission: 'Submission',
  custom: 'Custom',
}

export const REVIEW_LABELS: Record<ReviewColor, string> = {
  blue: 'Blue team',
  pink: 'Pink team',
  red: 'Red team',
  green: 'Green team',
  gold: 'Gold team',
  white_glove: 'White glove',
}

export const ORIGIN_LABELS: Record<ActivityOrigin, string> = {
  ai: 'From the solicitation',
  user: 'Added by user',
  template: 'From template',
}

/** CSS modifier used for the bar and swatch color. */
export function toneOf(activity: Pick<ScheduleActivity, 'kind' | 'reviewColor'>): string {
  if (activity.kind === 'review' && activity.reviewColor) return `review-${activity.reviewColor}`
  return activity.kind
}

export function isPointInTime(activity: Pick<ScheduleActivity, 'kind' | 'start' | 'end'>): boolean {
  return (activity.kind === 'milestone' || activity.kind === 'submission') && activity.start === activity.end
}

/** Suggests a kind and review color from a standard activity name. */
export function inferFromName(name: string): { kind: ActivityKind; reviewColor?: ReviewColor } {
  const n = name.toLowerCase()
  if (n.includes('white glove')) return { kind: 'review', reviewColor: 'white_glove' }
  for (const color of ['blue', 'pink', 'red', 'green', 'gold'] as const) {
    if (n.startsWith(color)) return { kind: 'review', reviewColor: color }
  }
  if (n.includes('due') || n.includes('submit')) return { kind: 'submission' }
  if (n.includes('production') || n.includes('print') || n.includes('package')) return { kind: 'production' }
  if (n.includes('kickoff') || n.includes('released') || n.includes('questions') || n.includes('answers') || n.includes('meeting')) {
    return { kind: 'milestone' }
  }
  return { kind: 'writing' }
}

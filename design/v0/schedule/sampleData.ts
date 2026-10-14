import type { DateChange, Holiday, ScheduleActivity, ScheduleTemplate } from './types'

export const SAMPLE_BID = {
  name: 'DOT Highway Safety Data Platform',
  today: '2026-10-14',
  startDate: '2026-10-09',
  dueDate: '2026-11-25',
  dueLabel: 'Wed, Nov 25 at 5:00 PM ET',
}

const SOL = 'RFP DOT-24-1187.pdf'

export const sampleActivities: ScheduleActivity[] = [
  { id: 'released', name: 'RFP released', kind: 'milestone', start: '2026-10-09', end: '2026-10-09', locked: true, origin: 'ai', sourcePage: 1, sourceQuote: 'Date of issuance: October 9, 2026.', documentName: SOL },
  { id: 'kickoff', name: 'Kickoff meeting', kind: 'milestone', start: '2026-10-15', end: '2026-10-15', owner: 'Amaan', locked: false, origin: 'user' },
  { id: 'outline', name: 'Outline and compliance matrix', kind: 'writing', start: '2026-10-15', end: '2026-10-20', owner: 'Priya', locked: false, origin: 'template' },
  { id: 'questions', name: 'Questions due', kind: 'milestone', start: '2026-10-21', end: '2026-10-21', locked: true, origin: 'ai', sourcePage: 3, sourceQuote: 'Questions must be submitted in writing to the Contracting Officer no later than October 21, 2026, 2:00 PM ET.', documentName: SOL },
  { id: 'draft', name: 'First draft writing', kind: 'writing', start: '2026-10-21', end: '2026-11-03', owner: 'Jordan', locked: false, origin: 'template' },
  { id: 'answers', name: 'Answers to questions posted', kind: 'milestone', start: '2026-10-28', end: '2026-10-28', locked: true, origin: 'ai', sourcePage: 3, sourceQuote: 'Answers will be posted as an amendment on or about October 28, 2026.', documentName: SOL },
  { id: 'pink', name: 'Pink team review', kind: 'review', reviewColor: 'pink', start: '2026-11-04', end: '2026-11-05', owner: 'Priya', locked: false, origin: 'template' },
  { id: 'revise1', name: 'Revise after pink team', kind: 'writing', start: '2026-11-06', end: '2026-11-12', owner: 'Jordan', locked: false, origin: 'template' },
  { id: 'red', name: 'Red team review', kind: 'review', reviewColor: 'red', start: '2026-11-13', end: '2026-11-16', owner: 'Amaan', locked: false, origin: 'template' },
  { id: 'revise2', name: 'Final revisions', kind: 'writing', start: '2026-11-17', end: '2026-11-18', owner: 'Jordan', locked: false, origin: 'template' },
  { id: 'gold', name: 'Gold team review', kind: 'review', reviewColor: 'gold', start: '2026-11-19', end: '2026-11-19', owner: 'Amaan', locked: false, origin: 'template' },
  { id: 'production', name: 'Production and packaging', kind: 'production', start: '2026-11-20', end: '2026-11-23', owner: 'Sam', locked: false, origin: 'template' },
  { id: 'whiteglove', name: 'White glove review', kind: 'review', reviewColor: 'white_glove', start: '2026-11-24', end: '2026-11-24', owner: 'Sam', locked: false, origin: 'template' },
  { id: 'due', name: 'Proposal due', kind: 'submission', start: '2026-11-25', end: '2026-11-25', locked: true, origin: 'ai', sourcePage: 2, sourceQuote: 'Proposals are due no later than 5:00 PM Eastern Time on November 25, 2026.', documentName: SOL, amendment: 1 },
]

export const sampleHolidays: Holiday[] = [
  { date: '2026-10-12', name: 'Columbus Day' },
  { date: '2026-11-11', name: 'Veterans Day' },
  { date: '2026-11-26', name: 'Thanksgiving' },
]

export const sampleTemplates: ScheduleTemplate[] = [
  { id: 'federal-standard', name: 'Federal standard (Pink, Red, Gold)', description: 'Three color team reviews with revision windows, for full RFP responses of 30 days or more.' },
  { id: 'federal-fast', name: 'Fast turn (Red, Gold)', description: 'Two reviews for responses with two to three weeks to the due date.' },
  { id: 'task-order', name: 'Task order (single Red)', description: 'One review and a short production window, for task orders and quick quotes.' },
]

export const activityOptions = [
  'Kickoff meeting',
  'Outline and compliance matrix',
  'Data calls with subject matter experts',
  'First draft writing',
  'Blue team review',
  'Pink team review',
  'Red team review',
  'Green team review',
  'Gold team review',
  'White glove review',
  'Final revisions',
  'Pricing volume',
  'Production and packaging',
  'Proposal due',
]

export const sampleDateChange: DateChange = {
  id: 'amd-2-due',
  field: 'dueDate',
  oldDate: '2026-11-25',
  newDate: '2026-12-02',
  amendment: 2,
  sourcePage: 1,
  sourceQuote: 'The proposal due date is hereby extended to December 2, 2026, 5:00 PM Eastern Time.',
}

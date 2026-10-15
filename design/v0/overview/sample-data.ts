import type { BidFact, Countdown, KickoffItem } from './types'

export const SAMPLE_FACTS: BidFact[] = [
  { id: 'solicitation', field: 'Solicitation number', value: 'VA-26-001', sourcePage: 2, confirmed: true },
  { id: 'agency', field: 'Agency', value: 'Department of Veterans Affairs', sourcePage: 1, confirmed: false },
  { id: 'period', field: 'Performance period', value: 'Base year plus four option years', sourcePage: 18, confirmed: true },
  { id: 'place', field: 'Place of performance', value: 'Washington, DC and remote', sourcePage: 23, confirmed: false },
]

export const SAMPLE_KICKOFF: KickoffItem[] = [
  { id: 'roles', label: 'Assign proposal roles', owner: 'Dana Reyes', done: true, note: 'Proposal lead confirmed.' },
  { id: 'schedule', label: 'Confirm proposal schedule', owner: 'Jordan Lee', done: false, note: 'Coordinate review dates.' },
  { id: 'questions', label: 'Collect clarification questions', owner: null, done: false, note: '' },
]

export const SAMPLE_COUNTDOWN: Countdown = { days: 19, workdays: 13, dueLabel: 'November 3, 2026 at 2:00 PM ET' }
export const EMPTY_COUNTDOWN: Countdown = null

export const OVERVIEW_STATES = ['ready', 'due-today', 'past-due', 'empty'] as const
export type OverviewPreviewState = (typeof OVERVIEW_STATES)[number]

export const SAMPLE_OVERVIEW_PROPS = { facts: SAMPLE_FACTS, kickoff: SAMPLE_KICKOFF, countdown: SAMPLE_COUNTDOWN, selectedRowId: 'agency' }

export type { BidFact, Countdown, KickoffItem }

export default SAMPLE_OVERVIEW_PROPS

// Callbacks are supplied by the preview so their effects remain visible to reviewers.
export const sampleLog = (name: string) => console.log(`[v0] overview ${name}`)

// Keep the unused empty countdown available for the empty and past-due preview states.
void EMPTY_COUNTDOWN
void OVERVIEW_STATES
void sampleLog
void SAMPLE_OVERVIEW_PROPS
void SAMPLE_FACTS
void SAMPLE_KICKOFF
void SAMPLE_COUNTDOWN

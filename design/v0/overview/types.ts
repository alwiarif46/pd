export type AmendmentMark =
  | { kind: 'original' }
  | { kind: 'added'; amendmentNo: number }
  | { kind: 'superseded'; amendmentNo: number; replacedById: string }
  | { kind: 'withdrawn'; amendmentNo: number }

export interface BidFact {
  id: string
  field: string
  value: string
  confirmed: boolean
  origin: 'ai' | 'user'
  sourcePage: number | null
  sourcePageEnd: number | null
  sourceQuote: string | null
  amendment: AmendmentMark
}

export interface KickoffItem {
  id: string
  label: string
  owner: string | null
  note: string | null
  done: boolean
}

export interface Countdown {
  dueDate: string
  dueTime: string | null
  timeZone: string | null
  daysLeft: number
  workdaysLeft: number
}

export interface OverviewTabProps {
  facts: BidFact[]
  kickoff: KickoffItem[]
  countdown: Countdown | null
  selectedRowId: string | null
  onEditFact: (id: string, value: string) => void
  onConfirmFact: (id: string, confirmed: boolean) => void
  onAddFact: (field: string, value: string) => void
  onToggleKickoff: (id: string, done: boolean) => void
  onSetKickoffOwner: (id: string, owner: string) => void
  onAddKickoff: (label: string) => void
  onOpenRow: (id: string) => void
  onOpenSource: (id: string) => void
  onJumpToRow: (id: string) => void
}

export type { OverviewTabProps as OverviewProps }

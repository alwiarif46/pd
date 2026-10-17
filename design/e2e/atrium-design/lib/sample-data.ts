import {
  FileStack,
  Activity,
  MessageSquareText,
  Inbox,
  ShieldCheck,
  Package,
  Library,
  Settings,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = {
  label: string
  icon: LucideIcon
  badge?: string
  active?: boolean
}

export const navPrimary: NavItem[] = [
  { label: 'Bids', icon: FileStack, badge: '4' },
  { label: 'Run monitor', icon: Activity, active: true },
  { label: 'Q&A', icon: MessageSquareText, badge: '2' },
  { label: 'Request & collect', icon: Inbox, badge: '5' },
  { label: 'Reviews', icon: ShieldCheck },
  { label: 'Packages', icon: Package },
]

export const navSecondary: NavItem[] = [
  { label: 'Repository', icon: Library },
  { label: 'Settings', icon: Settings },
]

export const tenant = {
  name: 'Northwind Federal',
  plan: 'Growth · 4 proposals / mo',
  used: 2,
  total: 4,
  user: { name: 'Dana Ortiz', role: 'Capture lead', initials: 'DO' },
}

export const bid = {
  title: 'EHR Modernization Support Services',
  agency: 'Department of Veterans Affairs',
  number: '36C10B26R0042',
  vehicle: 'Full and open · SDVOSB set-aside',
  dueDate: 'Nov 14, 2026',
  dueIn: '28 days',
  qaDeadline: 'Oct 22, 2026',
  qaIn: '5 days',
  pagesDrafted: 61,
  pagesTotal: 92,
  pageLimit: 100,
  costSpent: 184,
  costCap: 420,
  amendments: 2,
}

export type StageStatus = 'done' | 'running' | 'gate' | 'queued'

export const stages: { name: string; detail: string; status: StageStatus }[] = [
  { name: 'Intake', detail: 'RFP + 3 attachments', status: 'done' },
  { name: 'Bid / no-bid', detail: 'Approved · fit 82', status: 'done' },
  { name: 'Shred & matrix', detail: '214 requirements', status: 'done' },
  { name: 'Outline & format lock', detail: 'TNR 12 · 1in margins', status: 'done' },
  { name: 'Drafting', detail: '61 of 92 pages', status: 'running' },
  { name: 'Red review', detail: 'Separate reviewer', status: 'queued' },
  { name: 'Gate 1', detail: 'Human review', status: 'gate' },
  { name: 'Gold & White Glove', detail: 'Assembly + render', status: 'queued' },
]

export const volumes = [
  { name: 'Vol I · Technical', drafted: 34, total: 45, score: 91 },
  { name: 'Vol II · Management', drafted: 18, total: 25, score: 88 },
  { name: 'Vol III · Past Performance', drafted: 9, total: 15, score: 93 },
  { name: 'Vol IV · Price narrative', drafted: 0, total: 7, score: null },
]

export const needs = [
  {
    id: 'N-014',
    text: 'Key personnel resume: Program Manager',
    section: 'Vol II · 2.3',
    impact: 'High',
  },
  {
    id: 'N-022',
    text: 'CPARS rating for VA contract 36C776',
    section: 'Vol III · 1.2',
    impact: 'High',
  },
  {
    id: 'N-031',
    text: 'FedRAMP ATO date for hosting partner',
    section: 'Vol I · 4.1',
    impact: 'Medium',
  },
  {
    id: 'N-037',
    text: 'Transition staffing headcount, month 1',
    section: 'Vol II · 3.4',
    impact: 'Low',
  },
]

export const requests = [
  { item: 'Commitment letter', who: 'Helix Health IT', status: 'Received' },
  { item: 'Partner PP form', who: 'Cobalt Systems', status: 'Sent' },
  { item: 'Resume consent', who: 'J. Whitaker', status: 'Overdue' },
  { item: 'Resume consent', who: 'M. Osei', status: 'Received' },
  { item: 'Commitment letter', who: 'Ridgeway Data', status: 'Draft' },
]

export const activity = [
  { time: '10:42', text: 'Page 61 passed the 90% gate (Vol I · 3.6)' },
  { time: '10:31', text: 'Amendment 0002 diffed. 3 pages reopened.' },
  { time: '09:58', text: 'Q&A draft ready: 7 questions, agency template' },
  { time: '09:12', text: 'Commitment letter received from Helix Health IT' },
]

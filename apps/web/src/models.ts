export interface Bid {
  id: string;
  name: string;
  agency: string | null;
  bidType: 'federal' | 'sled';
  solicitationNumber: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  dueTime: string | null;
  timeZone: string | null;
  oralsEnabled: boolean;
  creditStatus: string | null;
  keyOverridesUsed: number;
  retentionExtendedUntil: string | null;
}

export interface OrgPayload {
  org: { id: string; name: string; plan: 'free' | 'starter' | 'growth'; planStatus: string } | null;
  credits: { allowed: number; used: number; reserved: number; periodEnd: string } | null;
  role: 'owner' | 'member';
}

export interface DocumentRow {
  id: string;
  fileName: string;
  kind: string;
  sizeBytes: number;
  amendmentNo: number | null;
  pageCount: number | null;
  pagesEstimated: number | null;
  createdAt: string;
  liveUntil: string | null;
  liveStatus: string | null;
  markingStatus: string | null;
  markingFound: string[] | null;
  extractStatus: string | null;
  scanStatus: string | null;
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  progress: number;
  queuePosition: number | null;
  error: string | null;
}

export interface SourceFields {
  id: string;
  documentId?: string | null;
  sourcePage?: number | null;
  sourcePageEnd?: number | null;
  sourceQuote?: string | null;
  quoteVerified?: boolean;
  confirmed?: boolean;
  amendmentNo?: number | null;
  supersedeStatus?: string | null;
  supersededByRowId?: string | null;
  changedByAmendment?: number | null;
  origin?: string | null;
  confidence?: string | null;
  flags?: string[] | null;
  sectionRef?: string | null;
  sourceRef?: string | null;
  reqType?: string | null;
  instrRef?: string | null;
  evalRef?: string | null;
  owner?: string | null;
  status?: string | null;
  requirementText?: string;
  field?: string;
  value?: string;
  label?: string;
  title?: string;
  item?: string;
  rule?: string;
  text?: string;
}

export const FREE_TABS = ['overview', 'schedule', 'compliance'] as const;
export const PAID_TABS = ['outline', 'resumes', 'reviews', 'production', 'orals', 'lessons'] as const;
export type TabId = (typeof FREE_TABS)[number] | (typeof PAID_TABS)[number] | 'documents' | 'settings';

export const TAB_LABEL: Record<TabId, string> = {
  overview: 'Overview',
  schedule: 'Schedule',
  compliance: 'Compliance',
  outline: 'Outline',
  resumes: 'Resumes',
  reviews: 'Reviews',
  production: 'Production',
  orals: 'Orals',
  lessons: 'Lessons',
  documents: 'Documents',
  settings: 'Settings',
};

export function capMb(plan: string): number {
  return plan === 'free' ? 50 : 300;
}

export function daysLeft(due: string | null): string {
  if (!due) return 'No due date';
  const ms = new Date(due).getTime() - Date.now();
  const days = Math.ceil(ms / 86400000);
  if (days < 0) return `${Math.abs(days)} days past due`;
  if (days === 0) return 'Due today';
  return `${days} days left`;
}

export function dayKey(value: string | null): string {
  if (!value) return '';
  return value.slice(0, 10);
}

export function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

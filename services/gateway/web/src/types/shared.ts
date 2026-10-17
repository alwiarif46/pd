// Shared UI contracts: docs/plans/09-ui-workflow.md sections 5.1 (Shell) and 5.12 (Shared).
// v0 and ui components import these from '@/types'. Do not redefine them.
import type { ReactNode } from 'react';
import type { AuthStatus } from './auth';

export type Tab =
  | 'overview'
  | 'schedule'
  | 'compliance'
  | 'outline'
  | 'resumes'
  | 'reviews'
  | 'production'
  | 'orals'
  | 'lessons'
  | 'documents'
  | 'settings';

/* ---- 5.1 Shell ---- */

export type OutsidePage = 'bids' | 'organization' | 'account' | 'privacy';
export type TabSignal = 'processing' | 'waiting' | 'failed';
export interface ShellBid {
  id: string;
  name: string;
  agency: string | null;
  dueDate: string | null;
  dueTime: string | null;
  timeZone: string | null;
}
export interface AppShellProps {
  bid: ShellBid | null; // null outside a bid: no sidebar
  bids: { id: string; name: string }[];
  activeTab: Tab | null; // null outside a bid
  activePage: OutsidePage | null; // null inside a bid
  plan: Plan;
  creditsLeft: number;
  creditsResetOn: string;
  oralsEnabled: boolean;
  tabSignals: { tab: Tab; signal: TabSignal }[];
  user: { name: string; email: string };
  detail: ReactNode; // the row detail slider (5.17), or null when closed
  onSelectTab: (t: Tab) => void;
  onSwitchBid: (id: string) => void;
  onOpenPage: (p: OutsidePage) => void;
  onUpgrade: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

/* ---- 5.12 Shared ---- */

export type Plan = 'free' | 'starter' | 'growth';
export type BidType = 'federal' | 'sled';
export type Role = 'owner' | 'member';
export type FileKind = 'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft';
export type ReqType = 'shall' | 'must' | 'will' | 'should' | 'other';
export type RowFlag = 'maybe_not_requirement' | 'page_estimated' | 'ocr' | 'quote_unverified';
export type FormStatus = AuthStatus; // { state: 'idle' } | { state: 'submitting' } | { state: 'error'; message } | { state: 'done'; message }
export type AmendmentMark =
  | { kind: 'original' }
  | { kind: 'added'; amendmentNo: number }
  | { kind: 'superseded'; amendmentNo: number; replacedById: string | null }
  | { kind: 'withdrawn'; amendmentNo: number };

export interface ProcessingStep {
  id: string;
  label: string;
  status: 'waiting' | 'running' | 'done' | 'failed';
  percent: number;
}
export interface ProcessingState {
  steps: ProcessingStep[];
  queuePosition: number | null;
  etaSeconds: number | null;
}
export interface ProcessingBannerProps {
  processing: ProcessingState;
}

export interface SourceLinkProps {
  page: number | null;
  pageEnd: number | null;
  rowLabel: string;
  onOpen: () => void;
}
export interface EmptyStateProps {
  title: string;
  text: string;
  action?: { label: string; onClick: () => void };
}
export interface LockedTabProps {
  tab: Tab;
  title: string;
  description: string;
  onUpgrade: () => void;
}

export type TabBlock =
  | { kind: 'no_solicitation' }
  | { kind: 'failed'; reason: string }
  | { kind: 'locked'; description: string }
  | { kind: 'out_of_credits'; creditsLeft: number; creditsResetOn: string };
export interface TabFrameProps {
  tab: Tab;
  title: string;
  plan: Plan;
  block: TabBlock | null; // replaces the content
  processing: ProcessingState | null; // banner above the content
  waiting: ReactNode; // MarkingPrompt and AmendmentConfirm, or null
  overCap: { usedBytes: number; capMb: number } | null;
  draftNotice: boolean;
  onUploadSolicitation: () => void;
  onRetry: () => void;
  onUpgrade: () => void;
  children: ReactNode;
}

export interface MarkingPromptProps {
  fileName: string;
  markings: string[];
  page: number | null;
  busy: boolean;
  onConfirm: () => void;
  onRemoveFile: () => void;
}
export interface AmendmentSide {
  rowId: string;
  label: string;
  text: string;
  sourcePage: number | null;
}
export interface AmendmentProposal {
  id: string;
  amendmentNo: number;
  action: 'supersede' | 'withdraw' | 'add';
  confidence: number | null;
  oldRow: AmendmentSide | null;
  newRow: AmendmentSide | null;
}
export interface AmendmentConfirmProps {
  proposals: AmendmentProposal[];
  busyIds: string[];
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
  onOpenSource: (rowId: string) => void;
}

export type UpgradeReason = 'locked_tab' | 'out_of_credits' | 'over_cap' | 'seats' | 'plan';
export interface UpgradeDialogProps {
  open: boolean;
  reason: UpgradeReason;
  plan: Plan;
  creditsLeft: number;
  creditsResetOn: string;
  onChoosePlan: (p: 'starter' | 'growth') => void;
  onClose: () => void;
}
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  typeToConfirm: string | null; // when set, the confirm button stays disabled until this text is typed
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

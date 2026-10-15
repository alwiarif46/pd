import type { Tab } from '@/types';
import type React from 'react';

export type OutsidePage = 'bids' | 'organization' | 'account' | 'privacy';
export type TabSignal = 'processing' | 'waiting' | 'failed';
export type Plan = 'free' | 'starter' | 'growth';

export interface ShellBid {
  id: string;
  name: string;
  agency: string | null;
  // Date-only value in YYYY-MM-DD format.
  dueDate: string | null;
  // Local time value in HH:mm format.
  dueTime: string | null;
  // IANA time-zone identifier for dueTime.
  timeZone: string | null;
}

export interface AppShellProps {
  bid: ShellBid | null;
  bids: { id: string; name: string }[];
  activeTab: Tab | null;
  activePage: OutsidePage | null;
  plan: Plan;
  creditsLeft: number;
  // Date-only value in YYYY-MM-DD format.
  creditsResetOn: string;
  oralsEnabled: boolean;
  tabSignals: { tab: Tab; signal: TabSignal }[];
  user: { name: string; email: string };
  detail: React.ReactNode;
  onSelectTab: (t: Tab) => void;
  onSwitchBid: (id: string) => void;
  onOpenPage: (p: OutsidePage) => void;
  onUpgrade: () => void;
  onSignOut: () => void;
  children: React.ReactNode;
}

export const PAID_TABS: Tab[] = ['outline', 'resumes', 'reviews', 'production', 'orals', 'lessons'];

export type UpgradeReason = 'locked_tab' | 'out_of_credits' | 'over_cap' | 'seats' | 'plan';

export interface UpgradeDialogProps {
  open: boolean;
  reason: UpgradeReason;
  plan: Plan;
  creditsLeft: number;
  // Date-only value in YYYY-MM-DD format.
  creditsResetOn: string;
  onChoosePlan: (p: 'starter' | 'growth') => void;
  onClose: () => void;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  typeToConfirm: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export type { Tab };
export type { AuthStatus } from '@/types';
                                                 

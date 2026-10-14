import type { ReactNode } from 'react';
import type { Tab, AuthStatus } from '@/types';

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

export type Plan = 'free' | 'starter' | 'growth';
export type UpgradeReason = 'locked_tab' | 'out_of_credits' | 'over_cap' | 'seats' | 'plan';

export interface AppShellProps {
  bid: ShellBid | null;
  bids: { id: string; name: string }[];
  activeTab: Tab | null;
  activePage: OutsidePage | null;
  plan: Plan;
  creditsLeft: number;
  creditsResetOn: string;
  oralsEnabled: boolean;
  tabSignals: { tab: Tab; signal: TabSignal }[];
  user: { name: string; email: string };
  detail: ReactNode;
  onSelectTab: (t: Tab) => void;
  onSwitchBid: (id: string) => void;
  onOpenPage: (p: OutsidePage) => void;
  onUpgrade: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

export const PAID_TABS: Tab[] = ['outline', 'resumes', 'reviews', 'production', 'orals', 'lessons'];

export interface UpgradeDialogProps {
  open: boolean;
  reason: UpgradeReason;
  creditsLeft: number;
  creditsResetOn: string;
  plan: Plan;
  onChoosePlan: (plan: 'starter' | 'growth') => void;
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

export type _AuthStatus = AuthStatus;
export type _Tab = Tab;
export type _ShellTab = Tab;
export type _ShellAuth = AuthStatus;

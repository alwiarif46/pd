import { createContext, useContext } from 'react';
import type { AmendmentLinkDto, BidDto, DocumentDto, JobDto, MeDto, OrgPayloadDto } from '@/api';
import type { Tab, UpgradeReason } from '@/types';
import type { OrgSummary } from '@/features/shared/credits';

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  /** When set, the confirm button stays disabled until this text is typed. */
  typeToConfirm?: string | null;
}

/**
 * What the shell loaded and the actions it owns, for the screen containers rendered inside it. Bid fields
 * are empty outside a bid and while the bid loads (`bidLoaded` false).
 */
export interface ShellContextValue {
  me: MeDto;
  org: OrgPayloadDto;
  summary: OrgSummary;
  bids: BidDto[];
  bidId: string | null;
  tab: Tab | null;
  bid: BidDto | null;
  docs: DocumentDto[];
  jobs: JobDto[];
  links: AmendmentLinkDto[];
  bidLoaded: boolean;
  /** The row named by `?row=`, or null. */
  selectedRowId: string | null;
  /** Reloads the organization, the bid list and the open bid. Call after every mutation. */
  refresh: () => void;
  /** Selects a row of the open tab (sets `?row=`), or clears it with null. */
  openRow: (rowId: string | null) => void;
  openUpgrade: (reason: UpgradeReason) => void;
  /** Opens the shell's ConfirmDialog; resolves true on confirm, false on cancel. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

/** The shell's context, or null outside the shell (tests render containers without it). */
export function useShell(): ShellContextValue | null {
  return useContext(ShellContext);
}

/** The shell's context; throws outside the shell. */
export function useRequiredShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useRequiredShell: render inside ShellContainer');
  return value;
}

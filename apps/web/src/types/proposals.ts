// Amendment proposals on the Overview and Schedule tabs (PR5): an amendment changes a fact or an activity a
// user added, confirmed, or edited, so it is offered with Insert and Dismiss instead of applied. Not a v0
// contract; drawn by features/proposals/ui/TabProposals. Dates are 'YYYY-MM-DD'.

/** What a proposal or the row it replaces says, as the panel shows it. */
export type ProposalSubject =
  | { kind: 'fact'; label: string; value: string }
  | { kind: 'activity'; label: string; start: string | null; end: string | null };

/** A row the proposal would replace. */
export interface ProposalOldRow {
  rowId: string;
  subject: ProposalSubject;
  /** From the solicitation or an earlier amendment: it has its own source control. */
  isAi: boolean;
  sourcePage: number | null;
  sourcePageEnd: number | null;
}

export interface TabProposal {
  /** The linkId to confirm (Insert) or reject (Dismiss). */
  id: string;
  /** The proposed row, for its source. */
  rowId: string;
  amendmentNo: number | null;
  next: ProposalSubject;
  /** The rows in the tab's list it replaces; empty when they were removed meanwhile. */
  replaces: ProposalOldRow[];
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
}

export interface TabProposalsProps {
  subject: 'facts' | 'dates';
  proposals: TabProposal[];
  /** Proposal ids with a decision being sent (their buttons are disabled). */
  busyIds: readonly string[];
  onInsert: (id: string) => void;
  onDismiss: (id: string) => void;
  /** Opens the source of the proposed row or of a replaced row, by row id. */
  onOpenSource: (rowId: string) => void;
}

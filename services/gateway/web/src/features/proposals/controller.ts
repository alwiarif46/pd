import * as api from '@/api';
import { ApiError } from '@/api';
import { messageOf } from '@/features/shared/messages';

/** The calls a proposals panel makes; tests pass fakes. */
export interface ProposalApi {
  confirmAmendmentLink: typeof api.confirmAmendmentLink;
  rejectAmendmentLink: typeof api.rejectAmendmentLink;
}

export const proposalApi: ProposalApi = api;

export type ProposalDecision = 'insert' | 'dismiss';

// The API's sentences for these two say "Reject" and treat a removed old row as blocking, which does not
// fit a tab proposal: the button is Dismiss, and Insert still works when the old row was removed.
export const ROW_ALREADY_CLOSED_MESSAGE =
  'Another change already replaced the row this one replaces, so it cannot be inserted. Dismiss it instead.';
export const NEW_ROW_MISSING_MESSAGE = 'The new row was removed, so this change cannot be inserted. Dismiss it instead.';
export const PROPOSAL_GONE_MESSAGE = 'This change is no longer open.';

export type ProposalOutcome = { kind: 'done'; message: string } | { kind: 'refused'; message: string };

function refusalOf(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    if (error.code === 'row_already_closed') return ROW_ALREADY_CLOSED_MESSAGE;
    if (error.code === 'new_row_missing') return NEW_ROW_MISSING_MESSAGE;
  }
  if (error instanceof ApiError && error.status === 404) return PROPOSAL_GONE_MESSAGE;
  return messageOf(error); // 409 link_already_decided and the rest: the API sentence as given
}

/**
 * Inserts (confirms) or dismisses (rejects) a tab proposal by its linkId; either decides every link of
 * the proposal. A retry after a lost response is safe: the same decision again answers 200.
 */
export async function decideProposal(
  deps: ProposalApi,
  p: { id: string; amendmentNo: number | null },
  decision: ProposalDecision,
): Promise<ProposalOutcome> {
  const amd = p.amendmentNo ? `Amendment ${p.amendmentNo}` : 'the amendment';
  try {
    if (decision === 'insert') {
      await deps.confirmAmendmentLink(p.id);
      return { kind: 'done', message: `Inserted the change from ${amd}.` };
    }
    await deps.rejectAmendmentLink(p.id);
    return { kind: 'done', message: `Dismissed the change from ${amd}. Your row stays.` };
  } catch (error) {
    return { kind: 'refused', message: refusalOf(error) };
  }
}

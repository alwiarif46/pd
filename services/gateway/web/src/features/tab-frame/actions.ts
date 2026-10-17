import * as api from '@/api';
import { messageOf } from '@/features/shared/messages';
import type { TabBlock, UpgradeReason } from '@/types';

/** The slice of the typed API client TabFrameContainer uses. Tests pass a mock. */
export interface TabFrameApi {
  retryJob: typeof api.retryJob;
  confirmMarking: typeof api.confirmMarking;
  deleteDocument: typeof api.deleteDocument;
  confirmAmendmentLink: typeof api.confirmAmendmentLink;
  rejectAmendmentLink: typeof api.rejectAmendmentLink;
}

export const tabFrameApi: TabFrameApi = api;

export type ActionResult = { ok: true } | { ok: false; message: string };

/**
 * Runs one structural action (retry, confirm marking, remove a file, decide an amendment change). These
 * wait for the server; the caller refreshes the bid either way, so a 409 (`link_already_decided`,
 * `row_already_closed`, `new_row_missing`) shows its message and the card leaves on reload.
 */
export async function runAction(call: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await call();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

export function decideLink(deps: TabFrameApi, linkId: string, decision: 'confirm' | 'reject'): Promise<ActionResult> {
  return runAction(() =>
    decision === 'confirm' ? deps.confirmAmendmentLink(linkId) : deps.rejectAmendmentLink(linkId),
  );
}

/** Which upgrade reason the frame's "Upgrade plan" opens the dialog with. */
export function upgradeReasonFor(block: TabBlock | null, overCap: boolean): UpgradeReason {
  if (block?.kind === 'locked') return 'locked_tab';
  if (block?.kind === 'out_of_credits') return 'out_of_credits';
  if (overCap) return 'over_cap';
  return 'plan';
}

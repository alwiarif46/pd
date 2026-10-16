import * as api from '@/api';
import { ApiError } from '@/api';
import { messageOf } from '@/features/shared/messages';
import type { InviteFailure } from './ui/types';

/** The slice of the typed API client the invite container uses. Tests pass a mock. */
export interface MembershipApi {
  acceptInvite: typeof api.acceptInvite;
  getMe: typeof api.getMe;
  logOut: typeof api.logOut;
}

export const membershipApi: MembershipApi = api;

export type AcceptOutcome =
  | { kind: 'joined'; orgName: string }
  | {
      kind: 'failed';
      reason: InviteFailure;
      message: string;
      /** True when the same code can still work (another account, a free seat, a retry). */
      keepCode: boolean;
    };

const REASONS: Record<string, InviteFailure> = {
  invite_invalid: 'invalid',
  invite_expired: 'expired',
  invite_used: 'used',
  invite_email_mismatch: 'email_mismatch',
  already_in_org: 'already_in_org',
  seats_full: 'seats_full',
};

const KEEP: ReadonlySet<InviteFailure> = new Set<InviteFailure>(['email_mismatch', 'seats_full', 'other']);

/** Accepts the invite. `alreadyMember` counts as joined. The API's message is shown as given. */
export async function acceptAction(deps: MembershipApi, code: string): Promise<AcceptOutcome> {
  try {
    const result = await deps.acceptInvite(code);
    return { kind: 'joined', orgName: result.name };
  } catch (error) {
    const reason = (error instanceof ApiError && error.code ? REASONS[error.code] : undefined) ?? 'other';
    return { kind: 'failed', reason, message: messageOf(error), keepCode: KEEP.has(reason) };
  }
}

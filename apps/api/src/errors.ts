/**
 * Error bodies the api sends: `{ error, code }`. `error` is a sentence a person can read and the
 * web client shows as is; `code` is a stable machine code the client can branch on. Never put a
 * machine code in `error`.
 */
export const ERROR_MESSAGES = {
  out_of_credits: 'This organization has no RFP credits left this period. Upgrade, or wait for the next period.',
  key_mismatch: 'The solicitation number on this file does not match the bid. Start a new bid for a different solicitation.',
  key_required: 'This bid already has its solicitation. Give the solicitation number on this file, or add it as an attachment.',
  solicitation_first: 'Upload the solicitation first. Attachments and amendments are added to a bid that has its solicitation.',
  document_deleted: 'This file was deleted.',
  key_locked: 'This bid already holds an RFP credit for its solicitation number. Start a new bid for a different solicitation.',
  bid_cap_exceeded: 'This file is larger than the space left on this bid.',
  invalid_upload: 'fileName, kind, a whole-number declaredSize, a sha256 hex digest, and chunkCount are required.',
  owner_only: 'Only the organization owner can do this.',
  plan_required: 'Extending how long files stay live needs a Starter or Growth plan.',
  invalid_date: 'That date is not valid.',
  override_limit: 'This bid has used all of its solicitation key overrides.',
  override_not_needed: 'This amendment is not waiting for a solicitation key override.',
  not_an_amendment: 'Only an amendment can be accepted by key override.',
  set_bid_number_first: 'This bid has no solicitation number yet. Set it in Bid settings instead of overriding: that is free, and the amendment is checked again automatically.',
  amendment_no_taken: 'Another amendment on this bid already has that number. Choose a different number.',
  invalid_amendment_no: 'The amendment number must be a whole number from 1 to 999.',
  link_already_decided: 'This amendment change was already decided. Decisions are final.',
  row_already_closed: 'The row this change replaces or withdraws is already superseded, withdrawn or removed.',
  retry_superseded: 'This step was already retried, or a newer step of this file is running. Retry the newest one if it fails.',
  invite_pending: 'This email already has an open invite.',
  seat_locked: 'All seats on the plan are taken, so you have no access for now. Ask the owner to upgrade or to free a seat.',
  new_row_missing: 'The replacing row was removed, so this change cannot be confirmed. Reject it instead.',
  activity_locked: 'This activity is locked. Unlock it before you move its dates.',
  due_date_required: 'Set the due date in Bid settings first. Templates count back from it.',
  schedule_template_exists: 'This schedule already has template activities. Replace them to apply a template again.',
  invite_invalid: 'This invite link is not valid. Ask the owner to send a new invite.',
  invite_expired: 'This invite has expired. Ask the owner to send a new one.',
  invite_used: 'This invite was already used.',
  invite_email_mismatch: 'This invite was sent to a different email address. Sign in with that address to accept it.',
  already_in_org: 'You already belong to an organization. An account can belong to one organization.',
  seats_full: 'The organization has no free seat right now. Ask the owner to upgrade or to free a seat, then open this invite again.',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export interface ErrorBody {
  error: string;
  code: ErrorCode;
}

export function apiError(code: ErrorCode, message: string = ERROR_MESSAGES[code]): ErrorBody {
  return { error: message, code };
}

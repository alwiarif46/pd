/**
 * Error bodies the api sends: `{ error, code }`. `error` is a sentence a person can read and the
 * web client shows as is; `code` is a stable machine code the client can branch on. Never put a
 * machine code in `error`.
 */
export const ERROR_MESSAGES = {
  out_of_credits: 'This organization has no RFP credits left this period. Upgrade, or wait for the next period.',
  key_mismatch: 'The solicitation number on this file does not match the bid. Start a new bid for a different solicitation.',
  key_required: 'This bid already has its solicitation. Give the solicitation number on this file, or add it as an attachment.',
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
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export interface ErrorBody {
  error: string;
  code: ErrorCode;
}

export function apiError(code: ErrorCode, message: string = ERROR_MESSAGES[code]): ErrorBody {
  return { error: message, code };
}

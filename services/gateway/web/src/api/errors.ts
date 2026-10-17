/** Message used when the API cannot be reached or answers with something that is not JSON. */
export const NETWORK_ERROR_MESSAGE = 'The API is not reachable';

/** An error from the PD API. `status` is the HTTP status, or 0 when the request never got a response. */
export class ApiError extends Error {
  readonly status: number;
  /** The api's machine code (`out_of_credits`, `key_mismatch`, ...), when it sent one. */
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The code of a 403 the api sends to a member the plan has no seat for (06 s5): every org route
 * refuses them until the owner removes members or upgrades.
 */
export const SEAT_LOCKED = 'seat_locked';

/** True when the api refused the signed-in member for lack of a seat (`SEAT_LOCKED`). */
export function isSeatLocked(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === SEAT_LOCKED;
}

/** True when the error comes from an aborted request (`AbortController.abort()`). */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

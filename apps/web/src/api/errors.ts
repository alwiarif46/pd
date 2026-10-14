/** Message used when the API cannot be reached or answers with something that is not JSON. */
export const NETWORK_ERROR_MESSAGE = 'The API is not reachable';

/** An error from the PD API. `status` is the HTTP status, or 0 when the request never got a response. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** True when the error comes from an aborted request (`AbortController.abort()`). */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

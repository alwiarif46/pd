/** The sessionStorage key that holds the bearer token. Shared with the legacy client. */
export const TOKEN_KEY = 'pd-token';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

/** Stores the token, or removes it when `value` is null or empty. */
export function setToken(value: string | null): void {
  if (value) {
    sessionStorage.setItem(TOKEN_KEY, value);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

const unauthorizedListeners = new Set<() => void>();

/**
 * Subscribes to 401 responses on requests that sent a token. The client never clears the token
 * itself; the shell container decides what to do. Returns an unsubscribe function.
 */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/** Called by the request core only. */
export function notifyUnauthorized(): void {
  for (const listener of [...unauthorizedListeners]) {
    listener();
  }
}

const seatLockedListeners = new Set<() => void>();

/**
 * Subscribes to 403 `seat_locked` responses: the signed-in member lost their seat (06 s5).
 * Returns an unsubscribe function.
 */
export function onSeatLocked(listener: () => void): () => void {
  seatLockedListeners.add(listener);
  return () => {
    seatLockedListeners.delete(listener);
  };
}

/** Called by the request core only. */
export function notifySeatLocked(): void {
  for (const listener of [...seatLockedListeners]) {
    listener();
  }
}

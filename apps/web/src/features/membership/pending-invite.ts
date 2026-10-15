/**
 * The invite code a person is working through, kept across sign-up and log in. localStorage, not
 * sessionStorage: the verify-email link opens in a new tab.
 */
export const PENDING_INVITE_KEY = 'pd-pending-invite';

/** A saved code older than this is ignored (an invite lasts 7 days). */
export const PENDING_INVITE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CODE_SHAPE = /^[0-9a-f-]{36}\.[0-9a-f]{64}$/;

/** True for `<org id>.<64 hex token>`. */
export function isInviteCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_SHAPE.test(value);
}

export function savePendingInvite(code: string): void {
  try {
    localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ code, savedAt: Date.now() }));
  } catch {
    // Storage can be blocked; the code is then kept in memory only.
  }
}

export function loadPendingInvite(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_INVITE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { code?: unknown; savedAt?: unknown } | null;
    if (!data || typeof data.savedAt !== 'number' || !isInviteCode(data.code)) return null;
    if (Date.now() - data.savedAt > PENDING_INVITE_MAX_AGE_MS) return null;
    return data.code;
  } catch {
    // Treat unreadable storage as empty.
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    localStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function hasPendingInvite(): boolean {
  return loadPendingInvite() !== null;
}

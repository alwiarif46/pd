/**
 * The invite code a person is working through, kept across sign-up and log in. localStorage, not
 * sessionStorage: the verify-email link opens in a new tab.
 */
export const PENDING_INVITE_KEY = 'pd-pending-invite';

/** sessionStorage flag: this browser session was already sent to `#/invite` from "no organization". */
export const INVITE_REDIRECTED_KEY = 'pd-invite-redirected';

/** A saved code older than this is ignored (an invite lasts 7 days). */
export const PENDING_INVITE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** `<org id>.<64 hex token>`, lowercase. Compare after `normalizeInviteCode`. */
export const CODE_SHAPE = /^[0-9a-f-]{36}\.[0-9a-f]{64}$/;

/** True for `<org id>.<64 hex token>`. */
export function isInviteCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_SHAPE.test(value);
}

/**
 * The code trimmed and lowercased (an org id typed or pasted in capitals still works; the token is
 * lowercase hex already), or null when it is not an invite code.
 */
export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return isInviteCode(code) ? code : null;
}

export function savePendingInvite(code: string): void {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return;
  try {
    localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ code: normalized, savedAt: Date.now() }));
  } catch {
    // Storage can be blocked. The invite screen still holds the code while it stays open, but it is
    // lost once the person leaves it to sign up or log in, and they paste it again.
  }
}

export function loadPendingInvite(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_INVITE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { code?: unknown; savedAt?: unknown } | null;
    if (!data || typeof data.savedAt !== 'number') return null;
    if (Date.now() - data.savedAt > PENDING_INVITE_MAX_AGE_MS) return null;
    return normalizeInviteCode(data.code);
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

/**
 * Whether the shell should send a signed-in person with no organization to `#/invite` now: only
 * while a code is waiting, and at most once per browser session, so a kept code (a seat not free
 * yet, another account) never bounces every visit. False when session storage is blocked, so it
 * can never loop; AppRoot still goes to `#/invite` right after a log in.
 */
export function takeInviteRedirect(): boolean {
  if (!hasPendingInvite()) return false;
  try {
    if (sessionStorage.getItem(INVITE_REDIRECTED_KEY)) return false;
    sessionStorage.setItem(INVITE_REDIRECTED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

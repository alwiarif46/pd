import { useCallback, useSyncExternalStore } from 'react';

/**
 * OPUS STEP: one lock per bid for a due-date change answer (the user's shift, scale, or keep, and an
 * amendment's answer), shared by every screen that applies one (Schedule, Settings).
 *
 * Module level on purpose, not component state: Settings can unmount (a tab switch) while its answer is
 * still being applied, and the Schedule tab mounted next must not start the amendment answer, or a second
 * user answer, for the same bid until that one ends. So the lock lives as long as the request, not the
 * screen: whoever takes it releases it when its request settles (success, failure, or a throw), mounted
 * or not. It guards this browser tab only; two tabs or two users are the server's to settle (stale
 * detection in resolveDateChange, 409 on a repeated amendment answer).
 *
 * The check and the take are one synchronous step (`tryLockDateChange`), done in the click handler before
 * any await, so a double click is dropped before React redraws the disabled buttons.
 *
 * Every locked call is bounded (controller.ts DATE_CHANGE_TIMEOUT_MS), so a request that never answers
 * still settles and releases. The holder is recorded (`owner`, one symbol per mounted screen), so a screen
 * can tell its own answer in flight (refuse Cancel, draw the prompt busy) from another screen's (let the
 * user put the prompt off; never trap them behind a lock they did not take).
 */

interface Held {
  token: symbol;
  owner: symbol;
}

const locks = new Map<string, Held>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

/** Releases a lock taken with tryLockDateChange. Idempotent; a stale release never frees a later holder. */
export type ReleaseDateChange = () => void;

/**
 * Takes the bid's lock for `owner` (a screen's own symbol; anonymous when omitted), or returns null when
 * an answer for that bid is already being applied.
 */
export function tryLockDateChange(bidId: string, owner: symbol = Symbol('anonymous')): ReleaseDateChange | null {
  if (locks.has(bidId)) return null;
  const token = Symbol(bidId);
  locks.set(bidId, { token, owner });
  notify();
  return () => {
    if (locks.get(bidId)?.token !== token) return;
    locks.delete(bidId);
    notify();
  };
}

export function isDateChangeLocked(bidId: string): boolean {
  return locks.has(bidId);
}

/** The owner holding the bid's lock, or null. For event handlers; render reads useDateChangeHolder. */
export function dateChangeHolder(bidId: string): symbol | null {
  return locks.get(bidId)?.owner ?? null;
}

/** The bids locked right now. For tests: assert none is left held after each test. */
export function lockedDateChangeBids(): string[] {
  return [...locks.keys()];
}

/**
 * Runs `call` under the bid's lock and releases it when the call settles or throws. Returns null, without
 * calling it, when the lock is held.
 */
export function withDateChangeLock<T>(bidId: string, call: () => Promise<T>, owner?: symbol): Promise<T> | null {
  const release = tryLockDateChange(bidId, owner);
  if (!release) return null;
  let run: Promise<T>;
  try {
    run = call();
  } catch (error) {
    release();
    return Promise.reject(error);
  }
  return run.finally(release);
}

export function subscribeDateChangeLocks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while a date-change answer for the bid is being applied, from any screen; redraws on change. */
export function useDateChangeBusy(bidId: string): boolean {
  const snapshot = useCallback(() => locks.has(bidId), [bidId]);
  return useSyncExternalStore(subscribeDateChangeLocks, snapshot, snapshot);
}

/** The owner holding the bid's lock (null when free); redraws on change. */
export function useDateChangeHolder(bidId: string): symbol | null {
  const snapshot = useCallback(() => locks.get(bidId)?.owner ?? null, [bidId]);
  return useSyncExternalStore(subscribeDateChangeLocks, snapshot, snapshot);
}

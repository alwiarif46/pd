import { useState } from 'react';
import type { DateChangeMode, DueMove } from '@/types';
import { NO_PROGRESS, resolveDateChange, type DateChangeOutcome, type DateChangeProgress, type ScheduleApi } from './controller';
import { isDateChangeLocked, withDateChangeLock } from './date-change-lock';

/** The calls a user's due-date change makes (controller.ts resolveDateChange). */
export type UserDateChangeApi = Pick<ScheduleApi, 'getBid' | 'updateBid' | 'getTab' | 'adjustSchedule'>;

/** A user's due-date change waiting for its answer, tied to the bid it was opened on, with what its tries wrote. */
export interface PendingDateChange<M> {
  readonly bidId: string;
  /** The move resolveDateChange applies. */
  readonly due: DueMove;
  /** The caller's own data for the prompt (Schedule: its ScheduleDateChange). */
  readonly meta: M;
  /** What earlier tries already wrote (controller.ts DateChangeProgress). */
  readonly progress: DateChangeProgress;
  /** A try saved the new due date but did not move the schedule. */
  readonly dueSaved: boolean;
}

interface Entry<M> extends PendingDateChange<M> {
  /** The record's identity across retries: a newer change (another bid, after a switch) gets a new one. */
  readonly token: symbol;
}

export interface UserDateChange<M> {
  /** The bid's open change, or null (one record per hook: opening on another bid replaces it). */
  current(bidId: string): PendingDateChange<M> | null;
  /** Opens a change with no progress. Refused (false) while an answer for the bid is being applied. */
  open(bidId: string, due: DueMove, meta: M): boolean;
  /**
   * Applies the answer under the bid's date-change lock (date-change-lock.ts): null at once, with nothing
   * sent, when no change is open for the bid or its lock is held. The record is closed (done, stale,
   * check) or kept with the returned progress (failed, adjust_failed) only while it is still the same
   * record; the lock is released when the call settles or throws, mounted or not. Toasts, reloads and
   * shell.refresh() are the caller's.
   */
  resolve(bidId: string, mode: DateChangeMode): Promise<DateChangeOutcome> | null;
  /** Closes the bid's change; a no-op while its answer is being applied (that answer closes it). */
  cancel(bidId: string): void;
}

/**
 * OPUS STEP: the user's due-date change, shared by Schedule and Settings so nothing copies the
 * resolveDateChange handling. Two writes to shared bid state (the due date, then the schedule):
 * resolveDateChange re-reads the bid and the schedule on every try, and the record carries what earlier
 * tries wrote, so a retry after a lost response neither skips the due date nor repeats an adjust that
 * already landed (controller.ts says what stays open: an adjust still running on the server). The lock is
 * per bid and module level, shared with the amendment answer, so no two answers for one bid overlap.
 */
export function useUserDateChange<M>(api: UserDateChangeApi): UserDateChange<M> {
  const [pending, setPending] = useState<Entry<M> | null>(null);

  const current = (bidId: string): PendingDateChange<M> | null => (pending?.bidId === bidId ? pending : null);

  const open = (bidId: string, due: DueMove, meta: M): boolean => {
    if (isDateChangeLocked(bidId)) return false;
    setPending({ bidId, due, meta, progress: NO_PROGRESS, dueSaved: false, token: Symbol('date-change') });
    return true;
  };

  const resolve = (bidId: string, mode: DateChangeMode): Promise<DateChangeOutcome> | null => {
    const record = pending?.bidId === bidId ? pending : null;
    if (!record) return null;
    const same = (p: Entry<M> | null): p is Entry<M> => p !== null && p.token === record.token;
    return withDateChangeLock(bidId, async () => {
      const outcome = await resolveDateChange(api, record.bidId, record.due, mode, record.progress);
      switch (outcome.kind) {
        case 'done':
        case 'stale':
        case 'check':
          setPending((p) => (same(p) ? null : p));
          break;
        case 'adjust_failed':
        case 'failed': {
          const dueSaved = outcome.kind === 'adjust_failed' || record.dueSaved;
          setPending((p) => (same(p) ? { ...p, progress: outcome.progress, dueSaved } : p));
          break;
        }
      }
      return outcome;
    });
  };

  const cancel = (bidId: string) => {
    if (isDateChangeLocked(bidId)) return;
    setPending((p) => (p?.bidId === bidId ? null : p));
  };

  return { current, open, resolve, cancel };
}

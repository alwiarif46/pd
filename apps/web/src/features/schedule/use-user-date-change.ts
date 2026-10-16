import { useRef, useState } from 'react';
import type { DateChangeMode, DueMove } from '@/types';
import { NO_PROGRESS, resolveDateChange, type DateChangeOutcome, type DateChangeProgress, type ScheduleApi } from './controller';
import { dateChangeHolder, isDateChangeLocked, withDateChangeLock } from './date-change-lock';

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
  /**
   * This hook's lock owner (date-change-lock.ts). A screen passes it to its other locked calls (Schedule's
   * amendment answer) and compares it with useDateChangeHolder to tell its own answer from another's.
   */
  readonly owner: symbol;
  /** The bid's open change, or null (one record per hook: opening on another bid replaces it). */
  current(bidId: string): PendingDateChange<M> | null;
  /** Opens a change with no progress. Refused (false) while an answer for the bid is being applied. */
  open(bidId: string, due: DueMove, meta: M): boolean;
  /**
   * Applies the answer under the bid's date-change lock (date-change-lock.ts): null at once, with nothing
   * sent, when no change is open for the bid or its lock is held. The record is closed (done, stale,
   * check) or kept with the returned progress (failed, adjust_failed) only while it is still the same
   * record; the lock is released when the call settles or throws (every call is bounded, controller.ts
   * DATE_CHANGE_TIMEOUT_MS), mounted or not. Toasts, reloads and shell.refresh() are the caller's.
   */
  resolve(bidId: string, mode: DateChangeMode): Promise<DateChangeOutcome> | null;
  /**
   * Closes the bid's change. A no-op while this hook's own answer for the bid is being applied (that
   * answer closes it); allowed while another screen's is (it writes nothing, and must not trap the user).
   */
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
  const [owner] = useState(() => Symbol('date-change-screen'));
  const [pending, setPending] = useState<Entry<M> | null>(null);
  // The record handlers act on, written in the same step as the state and before the lock is released,
  // so a click that lands before React redraws still answers with the last try's progress, never an older
  // render's (which could PATCH the due date again or adjust without the snapshot check). Render reads
  // the state; only handlers read the ref.
  const recordRef = useRef<Entry<M> | null>(null);
  const write = (update: (p: Entry<M> | null) => Entry<M> | null) => {
    const next = update(recordRef.current);
    recordRef.current = next;
    setPending(next);
  };

  const current = (bidId: string): PendingDateChange<M> | null => (pending?.bidId === bidId ? pending : null);

  const open = (bidId: string, due: DueMove, meta: M): boolean => {
    if (isDateChangeLocked(bidId)) return false;
    const record: Entry<M> = { bidId, due, meta, progress: NO_PROGRESS, dueSaved: false, token: Symbol('date-change') };
    write(() => record);
    return true;
  };

  const resolve = (bidId: string, mode: DateChangeMode): Promise<DateChangeOutcome> | null => {
    const latest = recordRef.current;
    const record = latest?.bidId === bidId ? latest : null;
    if (!record) return null;
    const same = (p: Entry<M> | null): p is Entry<M> => p !== null && p.token === record.token;
    return withDateChangeLock(
      bidId,
      async () => {
        const outcome = await resolveDateChange(api, record.bidId, record.due, mode, record.progress);
        switch (outcome.kind) {
          case 'done':
          case 'stale':
          case 'check':
            write((p) => (same(p) ? null : p));
            break;
          case 'adjust_failed':
          case 'failed': {
            const dueSaved = outcome.kind === 'adjust_failed' || record.dueSaved;
            write((p) => (same(p) ? { ...p, progress: outcome.progress, dueSaved } : p));
            break;
          }
        }
        return outcome;
      },
      owner,
    );
  };

  const cancel = (bidId: string) => {
    if (dateChangeHolder(bidId) === owner) return;
    write((p) => (p?.bidId === bidId ? null : p));
  };

  return { owner, current, open, resolve, cancel };
}

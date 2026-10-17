import * as api from '@/api';
import { ApiError, type AdjustScheduleDto, type PendingDateChangeDto, type ScheduleActivityDto } from '@/api';
import type { DateChangeMode, DueMove } from '@/types';
import { messageOf } from '@/features/shared/messages';
import { formatDay, plural } from '@/schedule/format';
import { dayOf } from './derive';

/** The calls the schedule container makes; tests pass fakes. */
export interface ScheduleApi {
  getTab: typeof api.getTab;
  createTabRow: typeof api.createTabRow;
  updateRow: typeof api.updateRow;
  deleteRow: typeof api.deleteRow;
  seedSchedule: typeof api.seedSchedule;
  adjustSchedule: typeof api.adjustSchedule;
  getBid: typeof api.getBid;
  updateBid: typeof api.updateBid;
  /** Insert and Dismiss on the tab's amendment proposals. */
  confirmAmendmentLink: typeof api.confirmAmendmentLink;
  rejectAmendmentLink: typeof api.rejectAmendmentLink;
}

export const scheduleApi: ScheduleApi = api;

/** An activity's days as they were just before an adjust was sent. */
export interface ActivitySnapshot {
  id: string;
  start: string | null;
  end: string | null;
}

/**
 * What earlier tries at the same date change already did, so a retry neither skips nor repeats a write.
 * Start with `NO_PROGRESS` when the prompt opens; keep the `progress` a kept-open outcome returns.
 */
export interface DateChangeProgress {
  /** The due-date PATCH was sent and may have been saved (anything but a 4xx refusal). */
  dueWritten: boolean;
  /**
   * The schedule as it was before an adjust that may have been applied (anything but a 4xx refusal):
   * a retry adjusts again only while the schedule still matches it. This narrows a double shift to an
   * adjust still running on the server when the retry reads the schedule (a 504 or a dropped connection):
   * the read does not take the server's schedule lock, so it cannot see an adjust that has not committed.
   */
  snapshot: ActivitySnapshot[] | null;
}

export const NO_PROGRESS: DateChangeProgress = { dueWritten: false, snapshot: null };

export type DateChangeOutcome =
  | { kind: 'done'; result: AdjustScheduleDto }
  /** The due date changed elsewhere: close the prompt, reload. */
  | { kind: 'stale'; message: string }
  /** An earlier try's adjust seems to have been applied after all: close the prompt, reload, let the user check. */
  | { kind: 'check'; message: string }
  /** The due date is saved, the schedule did not move: keep the prompt for a retry. */
  | { kind: 'adjust_failed'; message: string; progress: DateChangeProgress }
  /** The due date is not saved (as far as is known): keep the prompt. */
  | { kind: 'failed'; message: string; progress: DateChangeProgress };

export const STALE_MESSAGE = 'The due date changed while this was open. Check the new date and try again.';
export const CHECK_MESSAGE =
  'The schedule changed after the last try, so it may already have moved. Check the dates before you change them again.';

/**
 * The client-side bound on one date-change answer (every call it makes, together), so the per-bid lock
 * (date-change-lock.ts) is always released. 60 s: an answer is two or three small reads and writes plus
 * one adjust transaction over a bid's activities, normally done in well under a few seconds; 60 s is also
 * the usual idle timeout of the proxies and load balancers in front of an API, so a response that has
 * not come by then is not coming. Long enough not to cut a slow but live request, short enough that a
 * stuck one does not hold the prompt for minutes.
 */
export const DATE_CHANGE_TIMEOUT_MS = 60_000;

export const TIMEOUT_MESSAGE = 'The server did not answer in time. It may still have saved the change, so check before you try again.';
export const DATE_CHANGE_BUSY_MESSAGE = 'A due-date change for this bid is still being applied.';

export interface DateChangeOptions {
  /** Defaults to DATE_CHANGE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Settles with `call`, or rejects with an `ApiError` status 0 (TIMEOUT_MESSAGE) once `ms` passes. A
 * status-0 error is what a lost response already is: not a refusal, so the callers treat the write as
 * maybe applied (progress.dueWritten, the adjust snapshot, the server's 409 on a repeated amendment
 * answer), and a retry after a timeout goes through the same checks as one after a dropped connection.
 * The request itself is not cancelled; like any lost response it may still land on the server.
 */
export function withDeadline<T>(call: Promise<T>, ms: number = DATE_CHANGE_TIMEOUT_MS): Promise<T> {
  return deadline(ms).race(call);
}

/** One bound shared by every step of an answer; `race` clears the timer once the step settles. */
function deadline(ms: number) {
  const end = Date.now() + ms;
  return {
    race<T>(call: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(TIMEOUT_MESSAGE, 0)), Math.max(0, end - Date.now()));
      });
      return Promise.race([call, late]).finally(() => clearTimeout(timer));
    },
  };
}

/** A 4xx is a refusal: the server did not apply the request. Anything else (network, 5xx, a lost response) may have. */
function refused(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

function snapshotOf(activities: readonly ScheduleActivityDto[]): ActivitySnapshot[] {
  return activities.map((a) => {
    const start = dayOf(a.startDate);
    return { id: a.id, start, end: dayOf(a.endDate) ?? start };
  });
}

/** True when an activity in both lists has other days now (an adjust never adds or removes rows). */
export function scheduleMoved(before: readonly ActivitySnapshot[], now: readonly ActivitySnapshot[]): boolean {
  const byId = new Map(before.map((a) => [a.id, a]));
  return now.some((a) => {
    const was = byId.get(a.id);
    return was !== undefined && (was.start !== a.start || was.end !== a.end);
  });
}

/**
 * Applies a shift, scale, or keep answer to a due-date change: saves the bid's new due date, then moves
 * the schedule. The two writes are not atomic, so every try first re-reads the bid:
 * - a due date that is neither the previous nor the next one means someone else changed it (stale);
 * - the next due date is accepted as already saved only when an earlier try of this change sent it
 *   (`progress.dueWritten`), so a date set elsewhere (perhaps with its own adjust) is never adjusted twice;
 * - before adjusting, the schedule is read; when an earlier adjust may have been applied, a retry goes on
 *   only while the schedule still matches what it was before that adjust.
 * This narrows, but does not close, a double shift: an adjust still running on the server when the retry
 * reads the schedule is not seen. TODO(PR5, server): close it in the API, with one endpoint that saves the
 * due date and adjusts in one transaction, or an adjust precondition (apply only while the bid's due date
 * and schedule still match what the client saw), so a repeated adjust is refused instead of applied.
 */
export async function resolveDateChange(
  deps: Pick<ScheduleApi, 'getBid' | 'updateBid' | 'getTab' | 'adjustSchedule'>,
  bidId: string,
  change: DueMove,
  mode: DateChangeMode,
  progress: DateChangeProgress = NO_PROGRESS,
  opts: DateChangeOptions = {},
): Promise<DateChangeOutcome> {
  const { previousDue, nextDue } = change;
  let state = progress;
  const bound = deadline(opts.timeoutMs ?? DATE_CHANGE_TIMEOUT_MS);

  let due: string | null;
  try {
    due = dayOf((await bound.race(deps.getBid(bidId))).dueDate);
  } catch (error) {
    return { kind: 'failed', message: messageOf(error), progress: state };
  }

  if (due !== nextDue || previousDue === nextDue) {
    if (due !== previousDue) return { kind: 'stale', message: STALE_MESSAGE };
    if (previousDue !== nextDue) {
      try {
        await bound.race(deps.updateBid(bidId, { dueDate: nextDue }));
      } catch (error) {
        return { kind: 'failed', message: messageOf(error), progress: refused(error) ? state : { ...state, dueWritten: true } };
      }
    }
    state = { ...state, dueWritten: true };
  } else if (!state.dueWritten) {
    // Already on the next date, but not by this prompt: another tab or user saved it, maybe with its own adjust.
    return { kind: 'stale', message: STALE_MESSAGE };
  }

  const notMoved = (error: unknown) => `The new due date is saved, but the schedule did not move. ${messageOf(error)}`;
  let current: ActivitySnapshot[];
  try {
    current = snapshotOf((await bound.race(deps.getTab(bidId, 'schedule'))).activities);
  } catch (error) {
    return { kind: 'adjust_failed', message: notMoved(error), progress: state };
  }
  if (state.snapshot && scheduleMoved(state.snapshot, current)) {
    return { kind: 'check', message: CHECK_MESSAGE };
  }

  const before = state.snapshot ?? current;
  try {
    const result = await bound.race(deps.adjustSchedule(bidId, { mode, previousDue, nextDue }));
    return { kind: 'done', result };
  } catch (error) {
    return {
      kind: 'adjust_failed',
      message: notMoved(error),
      progress: { ...state, snapshot: state.snapshot ?? (refused(error) ? null : before) },
    };
  }
}

/** The success toast for a finished date change. */
export function doneMessage(result: Pick<AdjustScheduleDto, 'requestedMode' | 'mode' | 'moved'>): string {
  if (result.mode === 'keep' && result.moved === 0) return 'Kept the schedule dates.';
  const moved = `Moved ${plural(result.moved, '1 activity', `${result.moved} activities`)}.`;
  if (result.requestedMode === 'scale' && result.mode === 'shift') {
    return `The bid has no start date before both due dates, so the schedule was shifted. ${moved}`;
  }
  return moved;
}

export const AMENDMENT_GONE_MESSAGE = "This amendment's date change is no longer open. The schedule shows the current dates.";
export const KEEP_ONLY_MESSAGE = 'The bid had no due date, so only Keep dates applies.';

export type AmendmentAnswerOutcome =
  | { kind: 'done'; result: AdjustScheduleDto }
  /** 409 `date_change_resolved` or 404: the change is no longer open. Close the prompt and reload. */
  | { kind: 'closed'; message: string }
  /** Keep the prompt: a retry is safe, because the server refuses a repeated answer with 409. */
  | { kind: 'failed'; message: string };

/**
 * Answers the schedule tab's pendingDateChange with its amendmentId alone. The server takes the dates
 * from the change, moves the schedule from the due date in force, sets the bid's due date to nextDue and
 * resolves the change in one request, so this never reads or PATCHes the bid: a due date saved first
 * would make the server refuse the answer (409 `date_change_resolved`). A retry after a lost response
 * needs no progress record: if the first try landed, the retry is refused with that 409.
 */
export async function answerAmendmentDateChange(
  deps: Pick<ScheduleApi, 'adjustSchedule'>,
  bidId: string,
  change: Pick<PendingDateChangeDto, 'amendmentId' | 'previousDue'>,
  mode: DateChangeMode,
  opts: DateChangeOptions = {},
): Promise<AmendmentAnswerOutcome> {
  if (mode !== 'keep' && change.previousDue === null) return { kind: 'failed', message: KEEP_ONLY_MESSAGE };
  try {
    const result = await withDeadline(deps.adjustSchedule(bidId, { mode, amendmentId: change.amendmentId }), opts.timeoutMs);
    return { kind: 'done', result };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.code === 'date_change_resolved') {
      return { kind: 'closed', message: messageOf(error) };
    }
    if (error instanceof ApiError && error.status === 404) return { kind: 'closed', message: AMENDMENT_GONE_MESSAGE };
    return { kind: 'failed', message: messageOf(error) };
  }
}

/** The success toast for an answered amendment date change. */
export function amendmentDoneMessage(result: Pick<AdjustScheduleDto, 'requestedMode' | 'mode' | 'moved'>, nextDue: string): string {
  return `Due date set to ${formatDay(nextDue)}. ${doneMessage(result)}`;
}

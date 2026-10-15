import * as api from '@/api';
import { ApiError, type AdjustScheduleDto, type ScheduleActivityDto } from '@/api';
import type { DateChangeMode, ScheduleDateChange } from '@/types';
import { messageOf } from '@/features/shared/messages';
import { plural } from '@/schedule/format';
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
  change: Pick<ScheduleDateChange, 'previousDue' | 'nextDue'>,
  mode: DateChangeMode,
  progress: DateChangeProgress = NO_PROGRESS,
): Promise<DateChangeOutcome> {
  const { previousDue, nextDue } = change;
  let state = progress;

  let due: string | null;
  try {
    due = dayOf((await deps.getBid(bidId)).dueDate);
  } catch (error) {
    return { kind: 'failed', message: messageOf(error), progress: state };
  }

  if (due !== nextDue || previousDue === nextDue) {
    if (due !== previousDue) return { kind: 'stale', message: STALE_MESSAGE };
    if (previousDue !== nextDue) {
      try {
        await deps.updateBid(bidId, { dueDate: nextDue });
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
    current = snapshotOf((await deps.getTab(bidId, 'schedule')).activities);
  } catch (error) {
    return { kind: 'adjust_failed', message: notMoved(error), progress: state };
  }
  if (state.snapshot && scheduleMoved(state.snapshot, current)) {
    return { kind: 'check', message: CHECK_MESSAGE };
  }

  const before = state.snapshot ?? current;
  try {
    const result = await deps.adjustSchedule(bidId, { mode, previousDue, nextDue });
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

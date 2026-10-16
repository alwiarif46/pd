import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AdjustScheduleDto } from '@/api';
import { bidDto, scheduleActivityDto } from '@/test/fixtures';
import {
  AMENDMENT_GONE_MESSAGE,
  amendmentDoneMessage,
  answerAmendmentDateChange,
  CHECK_MESSAGE,
  KEEP_ONLY_MESSAGE,
  doneMessage,
  NO_PROGRESS,
  resolveDateChange,
  scheduleMoved,
  STALE_MESSAGE,
  TIMEOUT_MESSAGE,
  withDeadline,
  type ScheduleApi,
} from './controller';

const change = { previousDue: '2026-11-25', nextDue: '2026-12-02' };
const result: AdjustScheduleDto = {
  ok: true,
  requestedMode: 'shift',
  mode: 'shift',
  workdaysOnly: true,
  unit: 'workdays',
  delta: 4,
  moved: 1,
  moves: [],
};
const ts = (day: string) => `${day}T00:00:00.000Z`;
const original = [scheduleActivityDto()];
const shifted = [scheduleActivityDto({ startDate: ts('2026-11-20'), endDate: ts('2026-11-24') })];

type Deps = Pick<ScheduleApi, 'getBid' | 'updateBid' | 'getTab' | 'adjustSchedule'>;

function deps(due: string | null, over: Partial<{ [K in keyof Deps]: unknown }> = {}): Deps & { calls: string[] } {
  const calls: string[] = [];
  const d = {
    calls,
    getBid: vi.fn(async () => {
      calls.push('getBid');
      return bidDto({ dueDate: due ? ts(due) : null });
    }),
    updateBid: vi.fn(async () => {
      calls.push('updateBid');
      return bidDto();
    }),
    getTab: vi.fn(async () => {
      calls.push('getTab');
      return { activities: original, workdaysOnly: true };
    }),
    adjustSchedule: vi.fn(async () => {
      calls.push('adjust');
      return result;
    }),
    ...over,
  };
  return d as unknown as Deps & { calls: string[] };
}

const lost = () => new ApiError('The API is not reachable', 0);
const refusedErr = () => new ApiError('Bad date.', 400, 'invalid_date');

describe('resolveDateChange', () => {
  it('re-reads the bid, saves the due date, reads the schedule, then adjusts', async () => {
    const d = deps('2026-11-25');
    const outcome = await resolveDateChange(d, 'bid-1', change, 'shift');
    expect(outcome).toEqual({ kind: 'done', result });
    expect(d.calls).toEqual(['getBid', 'updateBid', 'getTab', 'adjust']);
    expect(d.updateBid).toHaveBeenCalledWith('bid-1', { dueDate: '2026-12-02' });
    expect(d.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'shift', previousDue: '2026-11-25', nextDue: '2026-12-02' });
  });

  it('stops when the due date changed elsewhere', async () => {
    const d = deps('2026-12-09');
    expect(await resolveDateChange(d, 'bid-1', change, 'shift')).toEqual({ kind: 'stale', message: STALE_MESSAGE });
    expect(d.updateBid).not.toHaveBeenCalled();
    expect(d.adjustSchedule).not.toHaveBeenCalled();
  });

  it('stops when the next date was saved elsewhere, not by an earlier try', async () => {
    const d = deps('2026-12-02');
    expect((await resolveDateChange(d, 'bid-1', change, 'shift')).kind).toBe('stale');
    expect(d.adjustSchedule).not.toHaveBeenCalled();
  });

  it('on a retry after its own save, skips the due date and adjusts', async () => {
    const d = deps('2026-12-02');
    const outcome = await resolveDateChange(d, 'bid-1', change, 'shift', { dueWritten: true, snapshot: null });
    expect(outcome.kind).toBe('done');
    expect(d.calls).toEqual(['getBid', 'getTab', 'adjust']);
  });

  it('returns failed when the bid cannot be read, with nothing written', async () => {
    const d = deps('2026-11-25', { getBid: vi.fn(async () => Promise.reject(lost())) });
    expect(await resolveDateChange(d, 'bid-1', change, 'shift')).toEqual({
      kind: 'failed',
      message: 'The API is not reachable',
      progress: NO_PROGRESS,
    });
    expect(d.updateBid).not.toHaveBeenCalled();
  });

  it('returns failed when the due date is not saved, and does not adjust', async () => {
    const refused = deps('2026-11-25', { updateBid: vi.fn(async () => Promise.reject(refusedErr())) });
    expect(await resolveDateChange(refused, 'bid-1', change, 'shift')).toEqual({ kind: 'failed', message: 'Bad date.', progress: NO_PROGRESS });
    expect(refused.adjustSchedule).not.toHaveBeenCalled();

    // A lost PATCH response may have saved it: the next try may accept the next date as its own.
    const unknown = deps('2026-11-25', { updateBid: vi.fn(async () => Promise.reject(lost())) });
    const outcome = await resolveDateChange(unknown, 'bid-1', change, 'shift');
    expect(outcome).toMatchObject({ kind: 'failed', progress: { dueWritten: true, snapshot: null } });
    expect(unknown.adjustSchedule).not.toHaveBeenCalled();
  });

  it('returns adjust_failed when the schedule does not move, with the due date saved', async () => {
    const d = deps('2026-11-25', { adjustSchedule: vi.fn(async () => Promise.reject(refusedErr())) });
    const outcome = await resolveDateChange(d, 'bid-1', change, 'shift');
    expect(outcome.kind).toBe('adjust_failed');
    if (outcome.kind !== 'adjust_failed') return;
    expect(outcome.message.startsWith('The new due date is saved')).toBe(true);
    expect(outcome.message).toContain('Bad date.');
    // A 4xx refusal did not move anything: a retry needs no check.
    expect(outcome.progress).toEqual({ dueWritten: true, snapshot: null });
  });

  it('never shifts twice when an adjust response was lost and it was applied', async () => {
    const first = deps('2026-11-25', { adjustSchedule: vi.fn(async () => Promise.reject(lost())) });
    const outcome = await resolveDateChange(first, 'bid-1', change, 'shift');
    expect(outcome.kind).toBe('adjust_failed');
    if (outcome.kind !== 'adjust_failed') return;
    expect(outcome.progress.snapshot).toEqual([{ id: 'act-1', start: '2026-11-16', end: '2026-11-18' }]);

    // The server applied it: the schedule no longer matches the snapshot, so the retry does not adjust.
    const retry = deps('2026-12-02', { getTab: vi.fn(async () => ({ activities: shifted, workdaysOnly: true })) });
    expect(await resolveDateChange(retry, 'bid-1', change, 'shift', outcome.progress)).toEqual({ kind: 'check', message: CHECK_MESSAGE });
    expect(retry.updateBid).not.toHaveBeenCalled();
    expect(retry.adjustSchedule).not.toHaveBeenCalled();
  });

  it('retries the adjust when the lost one was not applied, and keeps the first snapshot', async () => {
    const progress = { dueWritten: true, snapshot: [{ id: 'act-1', start: '2026-11-16', end: '2026-11-18' }] };
    const retry = deps('2026-12-02', { adjustSchedule: vi.fn(async () => Promise.reject(refusedErr())) });
    const outcome = await resolveDateChange(retry, 'bid-1', change, 'scale', progress);
    expect(retry.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'scale', previousDue: '2026-11-25', nextDue: '2026-12-02' });
    expect(outcome).toMatchObject({ kind: 'adjust_failed', progress });

    const ok = deps('2026-12-02');
    expect((await resolveDateChange(ok, 'bid-1', change, 'shift', progress)).kind).toBe('done');
  });

  it('keeps the prompt when the schedule cannot be read before the adjust', async () => {
    const d = deps('2026-11-25', { getTab: vi.fn(async () => Promise.reject(lost())) });
    const outcome = await resolveDateChange(d, 'bid-1', change, 'shift');
    expect(outcome).toMatchObject({ kind: 'adjust_failed', progress: { dueWritten: true, snapshot: null } });
    expect(d.adjustSchedule).not.toHaveBeenCalled();
  });
});

describe('scheduleMoved', () => {
  it('compares only the activities in both lists', () => {
    const before = [{ id: 'a', start: '2026-11-02', end: '2026-11-02' }];
    expect(scheduleMoved(before, [...before, { id: 'new', start: '2026-12-01', end: '2026-12-01' }])).toBe(false);
    expect(scheduleMoved(before, [])).toBe(false);
    expect(scheduleMoved(before, [{ id: 'a', start: '2026-11-03', end: '2026-11-03' }])).toBe(true);
  });
});

describe('doneMessage', () => {
  it('names the scale fallback, the count, and a plain keep', () => {
    expect(doneMessage({ requestedMode: 'scale', mode: 'shift', moved: 3 })).toBe(
      'The bid has no start date before both due dates, so the schedule was shifted. Moved 3 activities.',
    );
    expect(doneMessage({ requestedMode: 'shift', mode: 'shift', moved: 1 })).toBe('Moved 1 activity.');
    expect(doneMessage({ requestedMode: 'keep', mode: 'keep', moved: 0 })).toBe('Kept the schedule dates.');
    expect(doneMessage({ requestedMode: 'keep', mode: 'keep', moved: 1 })).toBe('Moved 1 activity.');
  });
});

describe('answerAmendmentDateChange', () => {
  const pending = { amendmentId: 'amd-3', previousDue: '2026-11-25' };
  const adjustWith = (impl: () => Promise<AdjustScheduleDto>) => ({ adjustSchedule: vi.fn(impl) });

  it('sends the mode and the amendmentId alone', async () => {
    const d = adjustWith(async () => result);
    expect(await answerAmendmentDateChange(d, 'bid-1', pending, 'scale')).toEqual({ kind: 'done', result });
    expect(d.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'scale', amendmentId: 'amd-3' });
  });

  it('closes on 409 date_change_resolved with the API sentence', async () => {
    const d = adjustWith(async () => Promise.reject(new ApiError('This date change was already answered.', 409, 'date_change_resolved')));
    expect(await answerAmendmentDateChange(d, 'bid-1', pending, 'shift')).toEqual({
      kind: 'closed',
      message: 'This date change was already answered.',
    });
  });

  it('closes on 404', async () => {
    const d = adjustWith(async () => Promise.reject(new ApiError('Not found.', 404, 'not_found')));
    expect(await answerAmendmentDateChange(d, 'bid-1', pending, 'keep')).toEqual({ kind: 'closed', message: AMENDMENT_GONE_MESSAGE });
  });

  it('keeps the prompt on another 409, a 500, and a lost response', async () => {
    for (const error of [new ApiError('Busy.', 409, 'other'), new ApiError('Server error.', 500), new ApiError('The API is not reachable', 0)]) {
      const d = adjustWith(async () => Promise.reject(error));
      expect(await answerAmendmentDateChange(d, 'bid-1', pending, 'shift')).toEqual({ kind: 'failed', message: error.message });
    }
  });

  it('allows only keep when the bid had no due date, without a call', async () => {
    const d = adjustWith(async () => result);
    const none = { amendmentId: 'amd-3', previousDue: null };
    expect(await answerAmendmentDateChange(d, 'bid-1', none, 'shift')).toEqual({ kind: 'failed', message: KEEP_ONLY_MESSAGE });
    expect(await answerAmendmentDateChange(d, 'bid-1', none, 'scale')).toEqual({ kind: 'failed', message: KEEP_ONLY_MESSAGE });
    expect(d.adjustSchedule).not.toHaveBeenCalled();
    expect((await answerAmendmentDateChange(d, 'bid-1', none, 'keep')).kind).toBe('done');
    expect(d.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'keep', amendmentId: 'amd-3' });
  });
});

describe('amendmentDoneMessage', () => {
  it('names the new due date, then what moved', () => {
    expect(amendmentDoneMessage({ requestedMode: 'shift', mode: 'shift', moved: 1 }, '2026-12-02')).toBe(
      'Due date set to Wed, Dec 2, 2026. Moved 1 activity.',
    );
    expect(amendmentDoneMessage({ requestedMode: 'keep', mode: 'keep', moved: 0 }, '2026-12-02')).toBe(
      'Due date set to Wed, Dec 2, 2026. Kept the schedule dates.',
    );
  });
});

describe('date-change timeouts', () => {
  const never = () => new Promise<never>(() => {});
  const TIMEOUT = { timeoutMs: 20 };

  it('withDeadline settles with the call, or with a status-0 ApiError once the time is up', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
    await expect(withDeadline(Promise.reject(new ApiError('No.', 400)), 1000)).rejects.toMatchObject({ status: 400 });
    const error = await withDeadline(never(), 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: TIMEOUT_MESSAGE, status: 0 });
  });

  it('a bid read that never answers fails with no progress', async () => {
    const d = deps('2026-11-25', { getBid: vi.fn(never) });
    expect(await resolveDateChange(d, 'bid-1', change, 'shift', NO_PROGRESS, TIMEOUT)).toEqual({
      kind: 'failed',
      message: TIMEOUT_MESSAGE,
      progress: NO_PROGRESS,
    });
    expect(d.updateBid).not.toHaveBeenCalled();
  });

  it('a due-date PATCH that never answers counts as maybe saved: the retry does not PATCH again', async () => {
    const d = deps('2026-11-25', { updateBid: vi.fn(never) });
    const first = await resolveDateChange(d, 'bid-1', change, 'shift', NO_PROGRESS, TIMEOUT);
    expect(first).toEqual({ kind: 'failed', message: TIMEOUT_MESSAGE, progress: { dueWritten: true, snapshot: null } });
    if (first.kind !== 'failed') throw new Error('unreachable');
    // The PATCH landed after all.
    vi.mocked(d.getBid).mockResolvedValue(bidDto({ dueDate: ts('2026-12-02') }));
    expect((await resolveDateChange(d, 'bid-1', change, 'shift', first.progress, TIMEOUT)).kind).toBe('done');
    expect(d.updateBid).toHaveBeenCalledTimes(1);
    expect(d.adjustSchedule).toHaveBeenCalledTimes(1);
  });

  it('an adjust that never answers keeps the snapshot: a retry checks instead of adjusting twice when it landed', async () => {
    const d = deps('2026-11-25', { adjustSchedule: vi.fn(never) });
    const first = await resolveDateChange(d, 'bid-1', change, 'shift', NO_PROGRESS, TIMEOUT);
    expect(first).toMatchObject({ kind: 'adjust_failed', progress: { dueWritten: true, snapshot: [{ id: original[0]!.id }] } });
    expect(first.kind === 'adjust_failed' && first.message).toBe(`The new due date is saved, but the schedule did not move. ${TIMEOUT_MESSAGE}`);
    if (first.kind !== 'adjust_failed') throw new Error('unreachable');
    vi.mocked(d.getBid).mockResolvedValue(bidDto({ dueDate: ts('2026-12-02') }));
    vi.mocked(d.getTab).mockResolvedValue({ activities: shifted, workdaysOnly: true } as never);
    expect(await resolveDateChange(d, 'bid-1', change, 'shift', first.progress, TIMEOUT)).toEqual({ kind: 'check', message: CHECK_MESSAGE });
    expect(d.adjustSchedule).toHaveBeenCalledTimes(1);
  });

  it("an amendment answer that never answers fails and keeps the prompt (a retry is refused with 409 if it landed)", async () => {
    const adjustSchedule = vi.fn(never);
    expect(
      await answerAmendmentDateChange({ adjustSchedule }, 'bid-1', { amendmentId: 'amd-3', previousDue: '2026-11-25' }, 'shift', TIMEOUT),
    ).toEqual({ kind: 'failed', message: TIMEOUT_MESSAGE });
  });

  it('defaults to a 60 second bound', async () => {
    vi.useFakeTimers();
    try {
      const d = deps('2026-11-25', { getBid: vi.fn(never) });
      const run = resolveDateChange(d, 'bid-1', change, 'shift');
      let settled = false;
      void run.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await run).kind).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

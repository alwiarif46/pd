// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type AdjustScheduleDto, type BidDto } from '@/api';
import { bidDto, scheduleActivityDto } from '@/test/fixtures';
import { CHECK_MESSAGE, DATE_CHANGE_TIMEOUT_MS, NO_PROGRESS, STALE_MESSAGE, TIMEOUT_MESSAGE, type DateChangeOutcome } from './controller';
import { dateChangeHolder, isDateChangeLocked, lockedDateChangeBids, tryLockDateChange } from './date-change-lock';

afterEach(() => {
  // The lock is module state: a test that leaves one held fails here, not in a later test.
  expect(lockedDateChangeBids()).toEqual([]);
});
import { useUserDateChange, type UserDateChangeApi } from './use-user-date-change';

const ts = (day: string) => `${day}T00:00:00.000Z`;
const move = { previousDue: '2026-11-25', nextDue: '2026-12-02' };
const adjusted: AdjustScheduleDto = {
  ok: true,
  requestedMode: 'shift',
  mode: 'shift',
  workdaysOnly: true,
  unit: 'workdays',
  delta: 4,
  moved: 1,
  moves: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeApi(over: Partial<UserDateChangeApi> = {}): UserDateChangeApi {
  return {
    getBid: vi.fn(async () => bidDto({ dueDate: ts('2026-11-25') })),
    updateBid: vi.fn(async () => bidDto()),
    getTab: vi.fn(async () => ({ activities: [scheduleActivityDto()], workdaysOnly: true, proposals: [], pendingDateChange: null })) as unknown as UserDateChangeApi['getTab'],
    adjustSchedule: vi.fn(async () => adjusted),
    ...over,
  };
}

const setup = (api: UserDateChangeApi) => renderHook(() => useUserDateChange<string>(api));
type Hook = ReturnType<typeof setup>['result'];

/** Runs resolve inside act and returns its outcome (null when refused). */
async function answer(result: Hook, bidId: string, mode: 'shift' | 'scale' | 'keep' = 'shift'): Promise<DateChangeOutcome | null> {
  const box: { run: Promise<DateChangeOutcome> | null; outcome: DateChangeOutcome | null } = { run: null, outcome: null };
  act(() => {
    box.run = result.current.resolve(bidId, mode);
  });
  const run = box.run;
  if (!run) return null;
  await act(async () => {
    box.outcome = await run;
  });
  return box.outcome;
}

describe('useUserDateChange: opening and cancelling', () => {
  it('opens one change per hook, tied to its bid, with no progress', () => {
    const { result } = setup(fakeApi());
    act(() => {
      expect(result.current.open('bid-1', move, 'meta-1')).toBe(true);
    });
    expect(result.current.current('bid-1')).toMatchObject({ bidId: 'bid-1', due: move, meta: 'meta-1', progress: NO_PROGRESS, dueSaved: false });
    expect(result.current.current('bid-2')).toBeNull();
    act(() => result.current.cancel('bid-2'));
    expect(result.current.current('bid-1')).not.toBeNull();
    act(() => result.current.cancel('bid-1'));
    expect(result.current.current('bid-1')).toBeNull();
  });

  it('refuses to open or answer while another answer holds the bid, but lets it be cancelled', async () => {
    const api = fakeApi();
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    const release = tryLockDateChange('bid-1')!;
    try {
      act(() => {
        expect(result.current.open('bid-1', { previousDue: '2026-11-25', nextDue: '2026-12-09' }, 'other')).toBe(false);
      });
      expect(result.current.current('bid-1')?.meta).toBe('meta');
      expect(await answer(result, 'bid-1')).toBeNull();
      expect(api.getBid).not.toHaveBeenCalled();
      // Cancel writes nothing, so it is allowed while another screen holds the lock (no trapped prompt).
      act(() => result.current.cancel('bid-1'));
      expect(result.current.current('bid-1')).toBeNull();
      expect(isDateChangeLocked('bid-1')).toBe(true);
    } finally {
      release();
    }
    expect(isDateChangeLocked('bid-1')).toBe(false);
  });

  it('resolves nothing when no change is open for the bid', async () => {
    const api = fakeApi();
    const { result } = setup(api);
    expect(await answer(result, 'bid-1')).toBeNull();
    act(() => {
      result.current.open('bid-2', move, 'meta');
    });
    expect(await answer(result, 'bid-1')).toBeNull();
    expect(api.getBid).not.toHaveBeenCalled();
    expect(isDateChangeLocked('bid-1')).toBe(false);
  });
});

describe('useUserDateChange: outcomes', () => {
  it('done: saves the due date, adjusts, closes, and unlocks', async () => {
    const api = fakeApi();
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    const outcome = await answer(result, 'bid-1');
    expect(outcome).toEqual({ kind: 'done', result: adjusted });
    expect(api.updateBid).toHaveBeenCalledWith('bid-1', { dueDate: '2026-12-02' });
    expect(api.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'shift', ...move });
    expect(result.current.current('bid-1')).toBeNull();
    expect(isDateChangeLocked('bid-1')).toBe(false);
  });

  it('stale: closes without writing', async () => {
    const api = fakeApi({ getBid: vi.fn(async () => bidDto({ dueDate: ts('2026-12-09') })) });
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    expect(await answer(result, 'bid-1', 'keep')).toEqual({ kind: 'stale', message: STALE_MESSAGE });
    expect(api.updateBid).not.toHaveBeenCalled();
    expect(result.current.current('bid-1')).toBeNull();
    expect(isDateChangeLocked('bid-1')).toBe(false);
  });

  it('failed: keeps the change with its progress and dueSaved false, then the retry PATCHes again after a refusal', async () => {
    const api = fakeApi({ updateBid: vi.fn<UserDateChangeApi['updateBid']>().mockRejectedValueOnce(new ApiError('No.', 422)).mockResolvedValue(bidDto()) });
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    const outcome = await answer(result, 'bid-1');
    expect(outcome).toMatchObject({ kind: 'failed', message: 'No.', progress: NO_PROGRESS });
    expect(result.current.current('bid-1')).toMatchObject({ meta: 'meta', progress: NO_PROGRESS, dueSaved: false });
    expect(isDateChangeLocked('bid-1')).toBe(false);
    expect((await answer(result, 'bid-1'))?.kind).toBe('done');
    expect(api.updateBid).toHaveBeenCalledTimes(2);
  });

  it('adjust_failed: marks the due date saved and keeps it saved across a later failed try', async () => {
    const api = fakeApi({
      adjustSchedule: vi.fn<UserDateChangeApi['adjustSchedule']>().mockRejectedValueOnce(new ApiError('Bad date.', 400, 'invalid_date')),
    });
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    const first = await answer(result, 'bid-1');
    expect(first).toMatchObject({ kind: 'adjust_failed', progress: { dueWritten: true, snapshot: null } });
    expect(result.current.current('bid-1')).toMatchObject({ dueSaved: true, progress: { dueWritten: true } });

    // The next try fails before any write (the bid read): dueSaved stays true.
    vi.mocked(api.getBid).mockRejectedValueOnce(new ApiError('The API is not reachable', 0));
    expect((await answer(result, 'bid-1'))?.kind).toBe('failed');
    expect(result.current.current('bid-1')).toMatchObject({ dueSaved: true, progress: { dueWritten: true } });

    // The server has the next date now: the retry adjusts with no second PATCH.
    vi.mocked(api.getBid).mockResolvedValue(bidDto({ dueDate: ts('2026-12-02') }));
    expect((await answer(result, 'bid-1'))?.kind).toBe('done');
    expect(api.updateBid).toHaveBeenCalledTimes(1);
    expect(result.current.current('bid-1')).toBeNull();
  });

  it('check: closes when a lost adjust seems to have landed', async () => {
    const api = fakeApi({ adjustSchedule: vi.fn<UserDateChangeApi['adjustSchedule']>().mockRejectedValueOnce(new ApiError('The API is not reachable', 0)) });
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    expect((await answer(result, 'bid-1'))?.kind).toBe('adjust_failed');
    vi.mocked(api.getBid).mockResolvedValue(bidDto({ dueDate: ts('2026-12-02') }));
    vi.mocked(api.getTab).mockResolvedValue({
      activities: [scheduleActivityDto({ startDate: ts('2026-11-20'), endDate: ts('2026-11-24') })],
      workdaysOnly: true,
      proposals: [],
      pendingDateChange: null,
    } as never);
    expect(await answer(result, 'bid-1')).toEqual({ kind: 'check', message: CHECK_MESSAGE });
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
    expect(result.current.current('bid-1')).toBeNull();
  });
});

describe('useUserDateChange: the lock', () => {
  it('holds the lock while the answer runs and refuses a second answer', async () => {
    const bid = deferred<BidDto>();
    const api = fakeApi({ getBid: vi.fn(() => bid.promise) });
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    let run: Promise<DateChangeOutcome> | null = null;
    act(() => {
      run = result.current.resolve('bid-1', 'shift');
    });
    expect(run).not.toBeNull();
    expect(isDateChangeLocked('bid-1')).toBe(true);
    act(() => {
      expect(result.current.resolve('bid-1', 'scale')).toBeNull();
    });
    expect(api.getBid).toHaveBeenCalledTimes(1);
    await act(async () => {
      bid.resolve(bidDto({ dueDate: ts('2026-11-25') }));
      await run;
    });
    expect(isDateChangeLocked('bid-1')).toBe(false);
  });

  it('two hooks on the same bid (Schedule and Settings) cannot answer at once; another bid is not blocked', async () => {
    const bid = deferred<BidDto>();
    const scheduleApi = fakeApi({ getBid: vi.fn(() => bid.promise) });
    const settingsApi = fakeApi();
    const schedule = setup(scheduleApi).result;
    const settings = setup(settingsApi).result;
    act(() => {
      schedule.current.open('bid-1', move, 'schedule');
      settings.current.open('bid-2', move, 'settings-2');
    });
    let run: Promise<DateChangeOutcome> | null = null;
    act(() => {
      run = schedule.current.resolve('bid-1', 'shift');
    });
    // Settings sees the bid busy and can neither open nor answer a change for it.
    expect(isDateChangeLocked('bid-1')).toBe(true);
    act(() => {
      expect(settings.current.open('bid-1', move, 'settings-1')).toBe(false);
    });
    expect(settings.current.current('bid-1')).toBeNull();
    // A different bid goes ahead meanwhile.
    expect((await answer(settings, 'bid-2'))?.kind).toBe('done');
    expect(settingsApi.adjustSchedule).toHaveBeenCalledTimes(1);

    await act(async () => {
      bid.resolve(bidDto({ dueDate: ts('2026-11-25') }));
      await run;
    });
    expect(isDateChangeLocked('bid-1')).toBe(false);
    act(() => {
      expect(settings.current.open('bid-1', move, 'settings-1')).toBe(true);
    });
  });

  it('releases the lock when resolveDateChange throws', async () => {
    // resolveDateChange catches every API failure; an error that throws when inspected escapes it.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    const api = fakeApi({ getBid: vi.fn(() => Promise.reject(hostile)) });
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    let run: Promise<DateChangeOutcome> | null = null;
    act(() => {
      run = result.current.resolve('bid-1', 'shift');
    });
    await act(async () => {
      await expect(run).rejects.toThrow();
    });
    expect(isDateChangeLocked('bid-1')).toBe(false);
    // The change stays open for another try.
    expect(result.current.current('bid-1')).not.toBeNull();
  });

  it('keeps the lock past an unmount until the answer settles, then releases it', async () => {
    const adjust = deferred<AdjustScheduleDto>();
    const api = fakeApi({ adjustSchedule: vi.fn(() => adjust.promise) });
    const errors = vi.spyOn(console, 'error');
    const { result, unmount } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    let run: Promise<DateChangeOutcome> | null = null;
    act(() => {
      run = result.current.resolve('bid-1', 'shift');
    });
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalled());
    unmount();
    // The writes are still being applied: the next screen on this bid must wait.
    expect(isDateChangeLocked('bid-1')).toBe(true);
    expect(tryLockDateChange('bid-1')).toBeNull();
    await act(async () => {
      adjust.resolve(adjusted);
      await run;
    });
    expect(isDateChangeLocked('bid-1')).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer change opened on another bid while the answer ran', async () => {
    const adjust = deferred<AdjustScheduleDto>();
    const api = fakeApi({ adjustSchedule: vi.fn(() => adjust.promise) });
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'first');
    });
    let run: Promise<DateChangeOutcome> | null = null;
    act(() => {
      run = result.current.resolve('bid-1', 'shift');
    });
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalled());
    // The shell switched bids and the user opened a change there (one record per hook, as Schedule had).
    act(() => {
      expect(result.current.open('bid-2', move, 'second')).toBe(true);
    });
    await act(async () => {
      adjust.reject(new ApiError('Bad date.', 400));
      await run;
    });
    expect(result.current.current('bid-2')).toMatchObject({ meta: 'second', progress: NO_PROGRESS, dueSaved: false });
    expect(result.current.current('bid-1')).toBeNull();
  });

  it("refuses Cancel while this hook's own answer is in flight, and takes the lock as its owner", async () => {
    const adjust = deferred<AdjustScheduleDto>();
    const api = fakeApi({ adjustSchedule: vi.fn(() => adjust.promise) });
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    let run: Promise<DateChangeOutcome> | null = null;
    act(() => {
      run = result.current.resolve('bid-1', 'shift');
    });
    expect(dateChangeHolder('bid-1')).toBe(result.current.owner);
    act(() => result.current.cancel('bid-1'));
    expect(result.current.current('bid-1')).not.toBeNull();
    await act(async () => {
      adjust.resolve(adjusted);
      await run;
    });
  });

  it('uses the record written by the last try, even before React redraws (no stale progress)', async () => {
    const api = fakeApi({
      adjustSchedule: vi.fn<UserDateChangeApi['adjustSchedule']>().mockRejectedValueOnce(new ApiError('The API is not reachable', 0)),
    });
    const { result } = setup(api);
    act(() => {
      result.current.open('bid-1', move, 'meta');
    });
    // Keep the resolve of this render, as a click handler from before the redraw would.
    const stale = result.current;
    await act(async () => {
      await stale.resolve('bid-1', 'shift');
    });
    vi.mocked(api.getBid).mockResolvedValue(bidDto({ dueDate: ts('2026-12-02') }));
    vi.mocked(api.getTab).mockResolvedValue({
      activities: [scheduleActivityDto({ startDate: ts('2026-11-20'), endDate: ts('2026-11-24') })],
      workdaysOnly: true,
      proposals: [],
      pendingDateChange: null,
    } as never);
    let outcome: DateChangeOutcome | null = null;
    await act(async () => {
      outcome = await stale.resolve('bid-1', 'shift');
    });
    // With the first render's record (no progress) this would read as stale; with the last try's it checks.
    expect(outcome).toEqual({ kind: 'check', message: CHECK_MESSAGE });
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when a call never answers, keeping the change open with its progress', async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ adjustSchedule: vi.fn(() => new Promise<never>(() => {})) });
      const { result } = setup(api);
      act(() => {
        result.current.open('bid-1', move, 'meta');
      });
      let run: Promise<DateChangeOutcome> | null = null;
      act(() => {
        run = result.current.resolve('bid-1', 'shift');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DATE_CHANGE_TIMEOUT_MS);
      });
      const outcome = await run!;
      expect(outcome).toMatchObject({ kind: 'adjust_failed', message: expect.stringContaining(TIMEOUT_MESSAGE) });
      expect(isDateChangeLocked('bid-1')).toBe(false);
      expect(result.current.current('bid-1')).toMatchObject({ dueSaved: true, progress: { dueWritten: true } });
    } finally {
      vi.useRealTimers();
    }
  });
});

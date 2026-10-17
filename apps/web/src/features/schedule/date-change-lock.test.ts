// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dateChangeHolder,
  isDateChangeLocked,
  lockedDateChangeBids,
  subscribeDateChangeLocks,
  tryLockDateChange,
  useDateChangeBusy,
  useDateChangeHolder,
  withDateChangeLock,
} from './date-change-lock';

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const held: Array<() => void> = [];
const lock = (bidId: string) => {
  const release = tryLockDateChange(bidId);
  if (release) held.push(release);
  return release;
};

afterEach(() => {
  held.splice(0).forEach((release) => release());
  // The lock is module state: a test that leaves one held fails here, not in a later test.
  expect(lockedDateChangeBids()).toEqual([]);
});

describe('date-change lock', () => {
  it('refuses a second lock on the same bid until the first is released', () => {
    const release = lock('bid-1');
    expect(release).not.toBeNull();
    expect(isDateChangeLocked('bid-1')).toBe(true);
    expect(lock('bid-1')).toBeNull();
    release!();
    expect(isDateChangeLocked('bid-1')).toBe(false);
    expect(lock('bid-1')).not.toBeNull();
  });

  it('keeps bids apart', () => {
    expect(lock('bid-1')).not.toBeNull();
    expect(lock('bid-2')).not.toBeNull();
    expect(isDateChangeLocked('bid-3')).toBe(false);
  });

  it('releases only once: a stale release cannot free the next holder', () => {
    const first = lock('bid-1')!;
    first();
    const second = lock('bid-1');
    expect(second).not.toBeNull();
    first();
    expect(isDateChangeLocked('bid-1')).toBe(true);
  });

  it('notifies subscribers on lock and on release', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDateChangeLocks(listener);
    const release = lock('bid-1')!;
    expect(listener).toHaveBeenCalledTimes(1);
    release();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    lock('bid-1');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('withDateChangeLock runs the call and releases on success and on failure', async () => {
    const ok = deferred<string>();
    const run = withDateChangeLock('bid-1', () => ok.promise);
    expect(run).not.toBeNull();
    expect(isDateChangeLocked('bid-1')).toBe(true);
    expect(withDateChangeLock('bid-1', async () => 'second')).toBeNull();
    ok.resolve('done');
    await expect(run).resolves.toBe('done');
    expect(isDateChangeLocked('bid-1')).toBe(false);

    const bad = withDateChangeLock('bid-1', async () => {
      throw new Error('boom');
    });
    await expect(bad).rejects.toThrow('boom');
    expect(isDateChangeLocked('bid-1')).toBe(false);
  });

  it('withDateChangeLock releases when the call throws before it returns a promise', async () => {
    const run = withDateChangeLock('bid-1', () => {
      throw new Error('sync');
    });
    await expect(run).rejects.toThrow('sync');
    expect(isDateChangeLocked('bid-1')).toBe(false);
  });

  it('useDateChangeBusy follows the lock of its own bid only', () => {
    const { result, rerender } = renderHook(({ bidId }) => useDateChangeBusy(bidId), { initialProps: { bidId: 'bid-1' } });
    expect(result.current).toBe(false);
    let release: (() => void) | null = null;
    act(() => {
      release = lock('bid-2');
    });
    expect(result.current).toBe(false);
    act(() => {
      lock('bid-1');
    });
    expect(result.current).toBe(true);
    rerender({ bidId: 'bid-2' });
    expect(result.current).toBe(true);
    act(() => release!());
    expect(result.current).toBe(false);
  });

  it('records the holder, and useDateChangeHolder follows it', () => {
    const mine = Symbol('mine');
    const { result } = renderHook(() => useDateChangeHolder('bid-1'));
    expect(result.current).toBeNull();
    let release: (() => void) | null = null;
    act(() => {
      release = tryLockDateChange('bid-1', mine);
    });
    expect(dateChangeHolder('bid-1')).toBe(mine);
    expect(result.current).toBe(mine);
    act(() => release!());
    expect(result.current).toBeNull();
    // Without an owner the lock still has a holder, just not one any screen can claim as its own.
    const anon = lock('bid-1');
    expect(anon).not.toBeNull();
    expect(dateChangeHolder('bid-1')).not.toBeNull();
    expect(dateChangeHolder('bid-1')).not.toBe(mine);
  });

  it('withDateChangeLock takes the lock for its owner', async () => {
    const mine = Symbol('mine');
    const call = deferred<void>();
    const run = withDateChangeLock('bid-1', () => call.promise, mine);
    expect(dateChangeHolder('bid-1')).toBe(mine);
    call.resolve();
    await run;
    expect(dateChangeHolder('bid-1')).toBeNull();
  });
});

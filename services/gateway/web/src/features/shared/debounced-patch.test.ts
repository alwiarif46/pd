import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatchDebouncer } from './debounced-patch';

describe('PatchDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one patch 500 ms after the last edit of a field', () => {
    const send = vi.fn();
    const debouncer = new PatchDebouncer(send);
    debouncer.patch('r1', 'owner', 'D');
    vi.advanceTimersByTime(300);
    debouncer.patch('r1', 'owner', 'Da');
    vi.advanceTimersByTime(499);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledExactlyOnceWith('r1', 'owner', 'Da');
  });

  it('keeps each row and field separate', () => {
    const send = vi.fn();
    const debouncer = new PatchDebouncer(send);
    debouncer.patch('r1', 'owner', 'A');
    debouncer.patch('r1', 'status', 'done');
    debouncer.patch('r2', 'owner', 'B');
    vi.advanceTimersByTime(500);
    expect(send.mock.calls).toEqual([
      ['r1', 'owner', 'A'],
      ['r1', 'status', 'done'],
      ['r2', 'owner', 'B'],
    ]);
  });

  it('flushes pending edits at once, and cancel drops them', () => {
    const send = vi.fn();
    const debouncer = new PatchDebouncer(send);
    debouncer.patch('r1', 'owner', 'A');
    debouncer.flush();
    expect(send).toHaveBeenCalledExactlyOnceWith('r1', 'owner', 'A');
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
    debouncer.patch('r1', 'owner', 'B');
    debouncer.cancel();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

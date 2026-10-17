import { useCallback, useEffect, useMemo, useRef } from 'react';

export type PatchSender = (rowId: string, field: string, value: string) => void | Promise<void>;

/** The timer functions the debouncer uses; tests pass fakes. */
export interface Timers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const browserTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const PATCH_DELAY_MS = 500;

/**
 * Debounces single-field edits per row and field: typing in one cell sends one PATCH 500 ms after the
 * last keystroke, and edits to other cells or rows do not delay or drop it. `flush` sends everything
 * pending now (on unmount or before navigating away).
 */
export class PatchDebouncer {
  private readonly pending = new Map<string, { handle: unknown; rowId: string; field: string; value: string }>();

  constructor(
    private readonly send: PatchSender,
    private readonly delayMs = PATCH_DELAY_MS,
    private readonly timers: Timers = browserTimers,
  ) {}

  patch(rowId: string, field: string, value: string): void {
    const key = JSON.stringify([rowId, field]);
    const existing = this.pending.get(key);
    if (existing) this.timers.clear(existing.handle);
    const handle = this.timers.set(() => {
      this.pending.delete(key);
      void this.send(rowId, field, value);
    }, this.delayMs);
    this.pending.set(key, { handle, rowId, field, value });
  }

  flush(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      this.timers.clear(entry.handle);
      void this.send(entry.rowId, entry.field, entry.value);
    }
  }

  /** Drops everything pending without sending it. */
  cancel(): void {
    for (const entry of this.pending.values()) this.timers.clear(entry.handle);
    this.pending.clear();
  }
}

/**
 * `PatchDebouncer` for a component. `send` may change between renders (the latest one is used); pending
 * edits are flushed on unmount so a quick edit before leaving the tab is not lost.
 */
export function useDebouncedPatch(send: PatchSender, delayMs = PATCH_DELAY_MS): Pick<PatchDebouncer, 'patch' | 'flush'> {
  const latest = useRef(send);
  const debouncer = useRef<PatchDebouncer | null>(null);
  useEffect(() => {
    latest.current = send;
  }, [send]);
  useEffect(
    () => () => {
      debouncer.current?.flush();
      debouncer.current = null;
    },
    [delayMs],
  );
  const patch = useCallback(
    (rowId: string, field: string, value: string) => {
      debouncer.current ??= new PatchDebouncer((r, f, v) => latest.current(r, f, v), delayMs);
      debouncer.current.patch(rowId, field, value);
    },
    [delayMs],
  );
  const flush = useCallback(() => debouncer.current?.flush(), []);
  return useMemo(() => ({ patch, flush }), [patch, flush]);
}

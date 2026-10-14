import { request, seg, type CallOptions } from './http';
import type { AdjustScheduleInput } from './types';

/** Moves unlocked activities after a due-date change. Returns how many moved. */
export function adjustSchedule(
  bidId: string,
  input: AdjustScheduleInput,
  opts?: CallOptions,
): Promise<{ ok: true; moved: number }> {
  return request(`/api/bids/${seg(bidId)}/schedule/adjust`, { method: 'POST', json: input, signal: opts?.signal });
}

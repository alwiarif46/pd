import { request, seg, type CallOptions } from './http';
import type { AdjustScheduleDto, AdjustScheduleInput, SeedScheduleDto, SeedScheduleInput } from './types';

/**
 * Moves the unlocked activities after a due-date change (shift, scale, or keep), counting
 * workdays when the bid's setting (or `input.workdaysOnly`) is on. Does not change the bid's due
 * date. `ApiError` 400 (`invalid_date`) when shift or scale lacks a date.
 */
export function adjustSchedule(bidId: string, input: AdjustScheduleInput, opts?: CallOptions): Promise<AdjustScheduleDto> {
  return request(`/api/bids/${seg(bidId)}/schedule/adjust`, { method: 'POST', json: input, signal: opts?.signal });
}

/**
 * Applies a schedule template, counted back from the bid's due date (origin 'template'), and
 * returns the bid's activities. `ApiError` 409 `due_date_required` when the bid has no due date.
 */
export function seedSchedule(bidId: string, input: SeedScheduleInput = {}, opts?: CallOptions): Promise<SeedScheduleDto> {
  return request(`/api/bids/${seg(bidId)}/tabs/schedule/seed`, { method: 'POST', json: input, signal: opts?.signal });
}

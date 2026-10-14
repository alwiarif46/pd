import { request, seg, type CallOptions } from './http';
import type {
  CreatedRowMap,
  CreateRowBodyMap,
  MoveOutlineInput,
  Ok,
  OutlineItemDto,
  ScheduleTemplate,
  SeedableTab,
  TabName,
  TabPayloadMap,
} from './types';

export function getTab<T extends TabName>(bidId: string, tab: T, opts?: CallOptions): Promise<TabPayloadMap[T]> {
  return request(`/api/bids/${seg(bidId)}/tabs/${seg(tab)}`, { signal: opts?.signal });
}

/** Adds a user row to a tab. Throws `ApiError` 400 when a required field is missing. */
export function createTabRow<T extends TabName>(
  bidId: string,
  tab: T,
  body: CreateRowBodyMap[T],
  opts?: CallOptions,
): Promise<CreatedRowMap[T]> {
  return request(`/api/bids/${seg(bidId)}/tabs/${seg(tab)}/rows`, {
    method: 'POST',
    json: body,
    signal: opts?.signal,
  });
}

/**
 * Fills a tab with its starter rows. Always sends a JSON body: `{ template }` for the schedule,
 * `{}` otherwise (the server reads `body.template` for the schedule and fails without a body).
 */
export function seedTab(
  bidId: string,
  tab: SeedableTab,
  options: CallOptions & { template?: ScheduleTemplate } = {},
): Promise<Ok> {
  const json = tab === 'schedule' ? { template: options.template } : {};
  return request(`/api/bids/${seg(bidId)}/tabs/${seg(tab)}/seed`, {
    method: 'POST',
    json,
    signal: options.signal,
  });
}

/**
 * Moves an outline item under `parentId` (null: a volume) at `index` among its new siblings and
 * returns the bid's whole outline in order. `ApiError` 409 for a move under itself or one of its
 * own sections, 404 when either item is not on the bid.
 */
export function moveOutlineItem(bidId: string, input: MoveOutlineInput, opts?: CallOptions): Promise<OutlineItemDto[]> {
  return request(`/api/bids/${seg(bidId)}/outline/move`, { method: 'POST', json: input, signal: opts?.signal });
}

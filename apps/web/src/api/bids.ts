import { request, seg, type CallOptions } from './http';
import type { BidDto, BidPatch, BidStatus, CreateBidInput, Ok } from './types';

/** The four bid statuses, in workflow order (09 s5.2). */
export const BID_STATUSES: readonly BidStatus[] = ['planning', 'writing', 'submitted', 'closed'];

export function isBidStatus(value: unknown): value is BidStatus {
  return typeof value === 'string' && (BID_STATUSES as readonly string[]).includes(value);
}

export function listBids(opts?: CallOptions): Promise<BidDto[]> {
  return request('/api/bids', { signal: opts?.signal });
}

/** The new bid starts in `planning`. */
export function createBid(input: CreateBidInput, opts?: CallOptions): Promise<BidDto> {
  return request('/api/bids', { method: 'POST', json: input, signal: opts?.signal });
}

export function getBid(id: string, opts?: CallOptions): Promise<BidDto> {
  return request(`/api/bids/${seg(id)}`, { signal: opts?.signal });
}

/** Returns the updated bid. A `status` outside `BID_STATUSES` is refused with 400. */
export function updateBid(id: string, patch: BidPatch, opts?: CallOptions): Promise<BidDto> {
  return request(`/api/bids/${seg(id)}`, { method: 'PATCH', json: patch, signal: opts?.signal });
}

export function deleteBid(id: string, opts?: CallOptions): Promise<Ok> {
  return request(`/api/bids/${seg(id)}`, { method: 'DELETE', signal: opts?.signal });
}

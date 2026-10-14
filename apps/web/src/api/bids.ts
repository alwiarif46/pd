import { request, seg, type CallOptions } from './http';
import type { BidDto, BidPatch, CreateBidInput, Ok } from './types';

export function listBids(opts?: CallOptions): Promise<BidDto[]> {
  return request('/api/bids', { signal: opts?.signal });
}

export function createBid(input: CreateBidInput, opts?: CallOptions): Promise<BidDto> {
  return request('/api/bids', { method: 'POST', json: input, signal: opts?.signal });
}

export function getBid(id: string, opts?: CallOptions): Promise<BidDto> {
  return request(`/api/bids/${seg(id)}`, { signal: opts?.signal });
}

/** Returns the updated bid. */
export function updateBid(id: string, patch: BidPatch, opts?: CallOptions): Promise<BidDto> {
  return request(`/api/bids/${seg(id)}`, { method: 'PATCH', json: patch, signal: opts?.signal });
}

export function deleteBid(id: string, opts?: CallOptions): Promise<Ok> {
  return request(`/api/bids/${seg(id)}`, { method: 'DELETE', signal: opts?.signal });
}

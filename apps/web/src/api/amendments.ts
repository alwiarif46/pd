import { request, seg, type CallOptions } from './http';
import type { AmendmentLinkDto, Ok } from './types';

export function listAmendmentLinks(bidId: string, opts?: CallOptions): Promise<AmendmentLinkDto[]> {
  return request(`/api/bids/${seg(bidId)}/amendment-links`, { signal: opts?.signal });
}

export function confirmAmendmentLink(linkId: string, opts?: CallOptions): Promise<Ok> {
  return request(`/api/amendment-links/${seg(linkId)}/confirm`, { method: 'POST', signal: opts?.signal });
}

export function rejectAmendmentLink(linkId: string, opts?: CallOptions): Promise<Ok> {
  return request(`/api/amendment-links/${seg(linkId)}/reject`, { method: 'POST', signal: opts?.signal });
}

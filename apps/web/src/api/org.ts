import { request, seg, type CallOptions } from './http';
import type { CreatedOrgDto, MembershipDto, Ok, OrgPayloadDto, ProcessingInfoDto } from './types';

export function createOrg(name: string, opts?: CallOptions): Promise<CreatedOrgDto> {
  return request('/api/org', { method: 'POST', json: { name }, signal: opts?.signal });
}

/**
 * The signed-in user's organization, credits, and role.
 * Throws `ApiError` 403 "No organization" when the user has none; treat that as "no org yet".
 */
export function getOrg(opts?: CallOptions): Promise<OrgPayloadDto> {
  return request('/api/org', { signal: opts?.signal });
}

export function updateOrg(name: string, opts?: CallOptions): Promise<Ok> {
  return request('/api/org', { method: 'PATCH', json: { name }, signal: opts?.signal });
}

export function listMembers(opts?: CallOptions): Promise<MembershipDto[]> {
  return request('/api/org/members', { signal: opts?.signal });
}

/** Throws `ApiError` 402 when the plan has no free seat. */
export function inviteMember(email: string, opts?: CallOptions): Promise<Ok> {
  return request('/api/org/invites', { method: 'POST', json: { email }, signal: opts?.signal });
}

export function removeMember(userId: string, opts?: CallOptions): Promise<Ok> {
  return request(`/api/org/members/${seg(userId)}`, { method: 'DELETE', signal: opts?.signal });
}

export function getProcessingInfo(opts?: CallOptions): Promise<ProcessingInfoDto> {
  return request('/api/about/processing', { signal: opts?.signal });
}

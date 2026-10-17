import { request, seg, type CallOptions } from './http';
import type {
  AcceptInviteDto,
  BillingRedirectDto,
  CreatedOrgDto,
  Ok,
  OrgMemberDto,
  OrgPayloadDto,
  PaidPlan,
  ProcessingInfoDto,
} from './types';

export function createOrg(name: string, opts?: CallOptions): Promise<CreatedOrgDto> {
  return request('/api/org', { method: 'POST', json: { name }, signal: opts?.signal });
}

/**
 * The signed-in user's organization, credits, role, seat limit, MB cap per bid, and whether
 * billing is available.
 * Throws `ApiError` 403 "No organization" when the user has none; treat that as "no org yet".
 */
export function getOrg(opts?: CallOptions): Promise<OrgPayloadDto> {
  return request('/api/org', { signal: opts?.signal });
}

export function updateOrg(name: string, opts?: CallOptions): Promise<Ok> {
  return request('/api/org', { method: 'PATCH', json: { name }, signal: opts?.signal });
}

/** The organization's members with names and emails, oldest first. */
export function listMembers(opts?: CallOptions): Promise<OrgMemberDto[]> {
  return request('/api/org/members', { signal: opts?.signal });
}

/** Throws `ApiError` 402 when the plan has no free seat. */
export function inviteMember(email: string, opts?: CallOptions): Promise<Ok> {
  return request('/api/org/invites', { method: 'POST', json: { email }, signal: opts?.signal });
}

/**
 * Joins the organization an invite was sent for. `code` is the invite code, `<orgId>.<token>`.
 * Signed-in users only; the invite must have been sent to the user's email address.
 * Throws `ApiError` with code: `invite_invalid` (404, or 400 without a body),
 * `invite_email_mismatch` (403), `invite_used`, `invite_expired`, `already_in_org` or
 * `seats_full` (409). `seats_full` and `invite_email_mismatch` leave the invite pending.
 */
export function acceptInvite(code: string, opts?: CallOptions): Promise<AcceptInviteDto> {
  return request('/api/invites/accept', { method: 'POST', json: { code }, signal: opts?.signal });
}

export function removeMember(userId: string, opts?: CallOptions): Promise<Ok> {
  return request(`/api/org/members/${seg(userId)}`, { method: 'DELETE', signal: opts?.signal });
}

export function getProcessingInfo(opts?: CallOptions): Promise<ProcessingInfoDto> {
  return request('/api/about/processing', { signal: opts?.signal });
}

/**
 * Opens Stripe Checkout for a paid plan; send the browser to the returned `url`.
 * Owner only. Throws `ApiError` 403 for a member, 409 when the organization already has a
 * subscription (use `openBillingPortal`), and 503 with code `billing_unavailable` when Stripe is
 * not configured (`OrgPayloadDto.billingAvailable` is false then).
 */
export function startCheckout(plan: PaidPlan, opts?: CallOptions): Promise<BillingRedirectDto> {
  return request('/api/billing/checkout', { method: 'POST', json: { plan }, signal: opts?.signal });
}

/**
 * Opens the Stripe Customer Portal (plan changes, cancellation, invoices); send the browser to
 * the returned `url`. Owner only. Throws `ApiError` 409 before the organization has a billing
 * account, and 503 with code `billing_unavailable` when Stripe is not configured.
 */
export function openBillingPortal(opts?: CallOptions): Promise<BillingRedirectDto> {
  return request('/api/billing/portal', { method: 'POST', signal: opts?.signal });
}

import { describe, expect, it } from 'vitest';
import { jsonBody, jsonResponse, lastCall, mockFetch } from '../test/fetch';
import { ApiError } from './errors';
import { getOrg, listMembers, openBillingPortal, startCheckout } from './org';
import { setToken } from './session';
import type { OrgMemberDto, OrgPayloadDto } from './types';

describe('startCheckout', () => {
  it('posts the plan with the token and returns the Checkout url', async () => {
    setToken('tok');
    const fetchMock = mockFetch(jsonResponse(200, { url: 'https://checkout.stripe.com/c/1' }));
    await expect(startCheckout('growth')).resolves.toEqual({ url: 'https://checkout.stripe.com/c/1' });
    const call = lastCall(fetchMock);
    expect(call.url).toBe('/api/billing/checkout');
    expect(call.method).toBe('POST');
    expect(call.headers.get('Authorization')).toBe('Bearer tok');
    expect(jsonBody(call)).toEqual({ plan: 'growth' });
  });

  it('throws the billing_unavailable code when Stripe is not configured', async () => {
    mockFetch(jsonResponse(503, { error: 'Billing is not available yet.', code: 'billing_unavailable' }));
    const error = await startCheckout('starter').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: 'billing_unavailable', message: 'Billing is not available yet.' });
  });

  it('throws 409 when the organization already has a subscription', async () => {
    mockFetch(jsonResponse(409, { error: 'This organization already has a subscription.', code: 'subscription_exists' }));
    await expect(startCheckout('starter')).rejects.toMatchObject({ status: 409, code: 'subscription_exists' });
  });

  it('throws 403 for a member', async () => {
    mockFetch(jsonResponse(403, { error: 'Only the organization owner can do this.', code: 'owner_only' }));
    await expect(startCheckout('starter')).rejects.toMatchObject({ status: 403, code: 'owner_only' });
  });
});

describe('openBillingPortal', () => {
  it('posts with no body and returns the Portal url', async () => {
    setToken('tok');
    const fetchMock = mockFetch(jsonResponse(200, { url: 'https://billing.stripe.com/p/1' }));
    await expect(openBillingPortal()).resolves.toEqual({ url: 'https://billing.stripe.com/p/1' });
    const call = lastCall(fetchMock);
    expect(call.url).toBe('/api/billing/portal');
    expect(call.method).toBe('POST');
    expect(call.body).toBeUndefined();
    expect(call.headers.has('Content-Type')).toBe(false);
  });

  it('throws 409 before there is a billing account', async () => {
    mockFetch(jsonResponse(409, { error: 'There is no billing account yet. Upgrade first.', code: 'no_billing_account' }));
    await expect(openBillingPortal()).rejects.toMatchObject({ status: 409, code: 'no_billing_account' });
  });
});

describe('org payloads', () => {
  it('listMembers returns names, emails, and isYou as the API sends them', async () => {
    const members: OrgMemberDto[] = [
      { userId: 'u1', name: 'Ann', email: 'ann@acme.com', role: 'owner', joinedAt: '2026-10-01T00:00:00.000Z', isYou: true },
      { userId: 'u2', name: null, email: 'bo@acme.com', role: 'member', joinedAt: '2026-10-02T00:00:00.000Z', isYou: false },
    ];
    mockFetch(jsonResponse(200, members));
    await expect(listMembers()).resolves.toEqual(members);
  });

  it('getOrg carries seatLimit, mbCap, billingAvailable, and a typed planStatus', async () => {
    const payload: OrgPayloadDto = {
      org: {
        id: 'o1',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        name: 'Acme',
        emailDomain: null,
        plan: 'starter',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        planStatus: 'past_due',
        cycleStart: '2026-10-01T00:00:00.000Z',
        cycleEnd: '2026-11-01T00:00:00.000Z',
        freeFirstMonthEnds: null,
      },
      credits: null,
      role: 'owner',
      seatLimit: 5,
      mbCap: 300,
      billingAvailable: true,
    };
    mockFetch(jsonResponse(200, payload));
    const result = await getOrg();
    expect(result).toEqual(payload);
    expect(result.org?.planStatus).toBe('past_due');
  });
});

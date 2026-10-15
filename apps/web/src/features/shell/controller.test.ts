import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api';
import { summarizeOrg } from '@/features/shared/credits';
import { bidDto, creditDto, docDto, jobDto, linkDto, meDto, orgPayload } from '@/test/fixtures';
import {
  BILLING_UNAVAILABLE_MESSAGE,
  isBillingUrl,
  jobsKey,
  loadBid,
  loadShell,
  needsPolling,
  noonOf,
  OWNER_ONLY_MESSAGE,
  pollDelay,
  toShellBid,
  UNEXPECTED_BILLING_URL_MESSAGE,
  upgradeAction,
  userOf,
  type ShellApi,
} from './controller';

function mockApi(over: Partial<ShellApi> = {}): ShellApi {
  return {
    getMe: vi.fn(async () => meDto()),
    getOrg: vi.fn(async () => orgPayload()),
    listBids: vi.fn(async () => [bidDto()]),
    getBid: vi.fn(async () => bidDto()),
    listDocuments: vi.fn(async () => [docDto()]),
    listJobs: vi.fn(async () => [jobDto()]),
    listAmendmentLinks: vi.fn(async () => [linkDto()]),
    startCheckout: vi.fn(async () => ({ url: 'https://checkout.stripe.com/c/1' })),
    openBillingPortal: vi.fn(async () => ({ url: 'https://billing.stripe.com/p/1' })),
    logOut: vi.fn(async () => undefined),
    ...over,
  };
}

describe('loadShell', () => {
  it('loads the user, the organization and the bids with one signal', async () => {
    const api = mockApi();
    const abort = new AbortController();
    const data = await loadShell(api, abort.signal);
    expect(data).toEqual({ kind: 'ready', me: meDto(), org: orgPayload(), bids: [bidDto()] });
    expect(api.getOrg).toHaveBeenCalledWith({ signal: abort.signal });
  });

  it('reports no organization on 403', async () => {
    const api = mockApi({ getOrg: vi.fn(async () => Promise.reject(new ApiError('No organization', 403))) });
    expect(await loadShell(api)).toEqual({ kind: 'no_org', me: meDto() });
  });

  it('throws anything else', async () => {
    const api = mockApi({ listBids: vi.fn(async () => Promise.reject(new ApiError('The API is not reachable', 0))) });
    await expect(loadShell(api)).rejects.toMatchObject({ status: 0 });
  });
});

describe('loadBid', () => {
  it('loads the bid, its files, jobs and amendment links', async () => {
    const api = mockApi();
    expect(await loadBid(api, 'bid-1')).toEqual({ bid: bidDto(), docs: [docDto()], jobs: [jobDto()], links: [linkDto()] });
    expect(api.listJobs).toHaveBeenCalledWith('bid-1', { signal: undefined });
  });
});

describe('needsPolling', () => {
  it('polls only while a job is queued or running or a file is still being read', () => {
    expect(needsPolling(null)).toBe(false);
    expect(needsPolling({ docs: [docDto()], jobs: [jobDto()] })).toBe(false);
    expect(needsPolling({ docs: [docDto()], jobs: [jobDto({ status: 'pending' })] })).toBe(true);
    expect(needsPolling({ docs: [docDto()], jobs: [jobDto({ status: 'running' })] })).toBe(true);
    expect(needsPolling({ docs: [docDto({ extractStatus: 'pending' })], jobs: [] })).toBe(true);
    expect(needsPolling({ docs: [docDto({ extractStatus: 'pending', liveStatus: 'deleted' })], jobs: [] })).toBe(false);
    expect(needsPolling({ docs: [], jobs: [jobDto({ status: 'failed' })] })).toBe(false);
  });

  it('backs off after failed polls: 3 s, 6 s, then 10 s at most', () => {
    expect([0, 1, 2, 3, 8].map(pollDelay)).toEqual([3000, 6000, 10_000, 10_000, 10_000]);
  });

  it('keys job states for legacy reloads, ignoring progress', () => {
    const a = jobsKey({ jobs: [jobDto({ status: 'running', progress: 10 })] });
    expect(jobsKey({ jobs: [jobDto({ status: 'running', progress: 80 })] })).toBe(a);
    expect(jobsKey({ jobs: [jobDto({ status: 'completed' })] })).not.toBe(a);
    expect(jobsKey(null)).toBe('');
  });
});

describe('dates and user for AppShell', () => {
  it('passes due dates as local noon of the calendar day', () => {
    expect(noonOf('2026-11-03T00:00:00.000Z')).toBe('2026-11-03T12:00:00');
    expect(noonOf('2026-11-03')).toBe('2026-11-03T12:00:00');
    expect(noonOf(null)).toBeNull();
    expect(noonOf('soon')).toBeNull();
    // Local noon is the same calendar day in every time zone.
    expect(new Date(noonOf('2026-11-03') as string).getDate()).toBe(3);
    expect(toShellBid(bidDto())).toEqual({
      id: 'bid-1',
      name: 'VA EHR Support',
      agency: 'Department of Veterans Affairs',
      dueDate: '2026-11-03T12:00:00',
      dueTime: '14:00',
      timeZone: 'America/New_York',
    });
  });

  it('names the user, falling back to the email', () => {
    expect(userOf(meDto())).toEqual({ name: 'Dana Reyes', email: 'dana@northbridge.example' });
    expect(userOf(meDto({ name: '  ' }))).toEqual({ name: 'dana@northbridge.example', email: 'dana@northbridge.example' });
    expect(userOf(null)).toEqual({ name: '', email: '' });
  });
});

describe('credits math', () => {
  const now = new Date('2026-10-15T00:00:00.000Z');

  it('is allowed minus used minus reserved, never below 0, reset at the period end', () => {
    expect(summarizeOrg(orgPayload({ credits: creditDto({ allowed: 10, used: 3, reserved: 2 }) }), now)).toMatchObject({
      creditsLeft: 5,
      creditsResetOn: '2026-11-01T00:00:00.000Z',
    });
    expect(summarizeOrg(orgPayload({ credits: creditDto({ allowed: 1, used: 1, reserved: 1 }) }), now).creditsLeft).toBe(0);
  });

  it('reads the projected period the API sends before its row exists', () => {
    const projected = {
      id: null,
      orgId: 'org-1',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      allowed: 2,
      used: 0,
      reserved: 0,
      createdAt: null,
      updatedAt: null,
    } as const;
    expect(summarizeOrg(orgPayload({ credits: projected }), now)).toMatchObject({ creditsLeft: 2, creditsResetOn: '2026-11-01T00:00:00.000Z' });
  });
});

describe('upgradeAction', () => {
  it('sends the browser to Checkout', async () => {
    const api = mockApi();
    expect(await upgradeAction(api, 'growth')).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.com/c/1' });
    expect(api.startCheckout).toHaveBeenCalledWith('growth');
  });

  it('opens the billing portal when the organization already has a subscription', async () => {
    const api = mockApi({
      startCheckout: vi.fn(async () => Promise.reject(new ApiError('Already subscribed', 409, 'subscription_exists'))),
    });
    expect(await upgradeAction(api, 'starter')).toEqual({ kind: 'redirect', url: 'https://billing.stripe.com/p/1' });
  });

  it('maps 503, 403 and other errors to a notice', async () => {
    const fail = (error: Error) => mockApi({ startCheckout: vi.fn(async () => Promise.reject(error)) });
    expect(await upgradeAction(fail(new ApiError('Billing is not available yet.', 503, 'billing_unavailable')), 'starter')).toEqual({
      kind: 'notice',
      message: BILLING_UNAVAILABLE_MESSAGE,
    });
    expect(await upgradeAction(fail(new ApiError('Only the organization owner can do this.', 403, 'owner_only')), 'starter')).toEqual({
      kind: 'notice',
      message: OWNER_ONLY_MESSAGE,
    });
    expect(await upgradeAction(fail(new ApiError('Choose the Starter or Growth plan', 400)), 'starter')).toEqual({
      kind: 'notice',
      message: 'Choose the Starter or Growth plan',
    });
    expect(await upgradeAction(fail(new TypeError('boom')), 'starter')).toEqual({
      kind: 'notice',
      message: 'Something went wrong. Try again.',
    });
  });

  it('follows only https URLs on stripe.com', async () => {
    for (const url of ['http://checkout.stripe.com/c/1', 'https://stripe.com.evil.example/c', 'https://evil.example/stripe.com', 'javascript:alert(1)', 'nope']) {
      expect(isBillingUrl(url)).toBe(false);
      const api = mockApi({ startCheckout: vi.fn(async () => ({ url })) });
      expect(await upgradeAction(api, 'starter')).toEqual({ kind: 'notice', message: UNEXPECTED_BILLING_URL_MESSAGE });
    }
    expect(isBillingUrl('https://checkout.stripe.com/c/pay/cs_1')).toBe(true);
    expect(isBillingUrl('https://stripe.com/x')).toBe(true);
  });

  it('maps portal errors the same way', async () => {
    const api = mockApi({
      startCheckout: vi.fn(async () => Promise.reject(new ApiError('Already subscribed', 409, 'subscription_exists'))),
      openBillingPortal: vi.fn(async () => Promise.reject(new ApiError('Billing is not available yet.', 503, 'billing_unavailable'))),
    });
    expect(await upgradeAction(api, 'starter')).toEqual({ kind: 'notice', message: BILLING_UNAVAILABLE_MESSAGE });
  });
});

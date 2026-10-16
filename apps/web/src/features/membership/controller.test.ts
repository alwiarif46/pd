import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api';
import { acceptAction, type MembershipApi } from './controller';

function apiRejecting(error: unknown): MembershipApi {
  return {
    acceptInvite: vi.fn(async () => Promise.reject(error)),
    getMe: vi.fn(),
    logOut: vi.fn(),
  };
}

describe('acceptAction', () => {
  it('maps a join to the organization name', async () => {
    const api: MembershipApi = {
      acceptInvite: vi.fn(async () => ({ orgId: 'o', name: 'Acme', role: 'member' as const, alreadyMember: false })),
      getMe: vi.fn(),
      logOut: vi.fn(),
    };
    expect(await acceptAction(api, 'o.t')).toEqual({ kind: 'joined', orgName: 'Acme' });
    expect(api.acceptInvite).toHaveBeenCalledWith('o.t');
  });

  it('counts alreadyMember as joined', async () => {
    const api: MembershipApi = {
      acceptInvite: vi.fn(async () => ({ orgId: 'o', name: 'Acme', role: 'member' as const, alreadyMember: true })),
      getMe: vi.fn(),
      logOut: vi.fn(),
    };
    expect(await acceptAction(api, 'c')).toEqual({ kind: 'joined', orgName: 'Acme' });
  });

  it.each([
    ['invite_invalid', 404, 'invalid', false],
    ['invite_expired', 409, 'expired', false],
    ['invite_used', 409, 'used', false],
    ['invite_email_mismatch', 403, 'email_mismatch', true],
    ['already_in_org', 409, 'already_in_org', false],
    ['seats_full', 409, 'seats_full', true],
  ])('maps %s', async (code, status, reason, keepCode) => {
    const out = await acceptAction(apiRejecting(new ApiError('Said so.', status, code)), 'c');
    expect(out).toEqual({ kind: 'failed', reason, message: 'Said so.', keepCode });
  });

  it('maps anything else to other and keeps the code', async () => {
    expect(await acceptAction(apiRejecting(new ApiError('Boom', 500)), 'c')).toEqual({
      kind: 'failed',
      reason: 'other',
      message: 'Boom',
      keepCode: true,
    });
    expect(await acceptAction(apiRejecting(new ApiError('Boom', 409, 'something_new')), 'c')).toMatchObject({
      reason: 'other',
      keepCode: true,
    });
    expect(await acceptAction(apiRejecting(new Error('x')), 'c')).toMatchObject({
      reason: 'other',
      message: 'Something went wrong. Try again.',
    });
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api';
import { meDto } from '@/test/fixtures';
import { InviteContainer } from './InviteContainer';
import type { MembershipApi } from './controller';
import { loadPendingInvite, savePendingInvite } from './pending-invite';

const CODE = `${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}.${'b'.repeat(64)}`;

function mockApi(over: Partial<MembershipApi> = {}): MembershipApi {
  return {
    acceptInvite: vi.fn(async () => ({ orgId: 'o', name: 'Acme', role: 'member' as const, alreadyMember: false })),
    getMe: vi.fn(async () => meDto({ email: 'm@acme.com' })),
    logOut: vi.fn(async () => undefined),
    ...over,
  };
}

beforeEach(() => {
  window.location.hash = '';
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
  localStorage.clear();
});

describe('InviteContainer', () => {
  it('saves the code from the link and removes it from the address bar', async () => {
    window.location.hash = `#/invite?token=${CODE}`;
    render(<InviteContainer signedIn={false} api={mockApi()} />);
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe('#/invite'));
    expect(loadPendingInvite()).toBe(CODE);
  });

  it('asks for the code when there is none, and keeps a pasted one', async () => {
    render(<InviteContainer signedIn={false} api={mockApi()} />);
    await userEvent.type(screen.getByLabelText('Invite code'), CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(loadPendingInvite()).toBe(CODE);
  });

  it('sends a signed-out person to sign up or log in', async () => {
    savePendingInvite(CODE);
    render(<InviteContainer signedIn={false} api={mockApi()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(window.location.hash).toBe('#/signup');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(window.location.hash).toBe('#/login');
    expect(loadPendingInvite()).toBe(CODE);
  });

  it('shows who is signed in and joins only on click, then clears the code', async () => {
    savePendingInvite(CODE);
    const api = mockApi();
    render(<InviteContainer signedIn api={api} />);
    expect(await screen.findByText('You are signed in as m@acme.com.')).toBeTruthy();
    expect(api.acceptInvite).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Join organization' }));
    expect(await screen.findByText('You joined Acme.')).toBeTruthy();
    expect(api.acceptInvite).toHaveBeenCalledWith(CODE);
    expect(loadPendingInvite()).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open Shaavir PD' }));
    expect(window.location.hash).toBe('#/bids');
  });

  it('keeps the code on seats_full, and Try again calls the API again', async () => {
    savePendingInvite(CODE);
    const acceptInvite = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('No free seat.', 409, 'seats_full'))
      .mockResolvedValueOnce({ orgId: 'o', name: 'Acme', role: 'member', alreadyMember: false });
    render(<InviteContainer signedIn api={mockApi({ acceptInvite })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Join organization' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No free seat.');
    expect(loadPendingInvite()).toBe(CODE);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('You joined Acme.')).toBeTruthy();
    expect(acceptInvite).toHaveBeenCalledTimes(2);
    expect(loadPendingInvite()).toBeNull();
  });

  it('clears the code on a final refusal', async () => {
    savePendingInvite(CODE);
    const acceptInvite = vi.fn().mockRejectedValue(new ApiError('Expired.', 409, 'invite_expired'));
    render(<InviteContainer signedIn api={mockApi({ acceptInvite })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Join organization' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Expired.');
    expect(loadPendingInvite()).toBeNull();
  });

  it('email_mismatch signs out through the API, goes to log in and keeps the code', async () => {
    savePendingInvite(CODE);
    const acceptInvite = vi.fn().mockRejectedValue(new ApiError('Different address.', 403, 'invite_email_mismatch'));
    const api = mockApi({ acceptInvite });
    render(<InviteContainer signedIn api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Join organization' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out and use another account' }));
    expect(api.logOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
    expect(loadPendingInvite()).toBe(CODE);
  });
});

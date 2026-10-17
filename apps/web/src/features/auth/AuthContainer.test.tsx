// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContainer } from './AuthContainer';
import { loadPending, savePending, type AuthApi } from './controller';

function mockApi(verifyEmail: AuthApi['verifyEmail']): AuthApi {
  return {
    logIn: vi.fn(async () => undefined),
    signUp: vi.fn(async () => ({ userId: 'u1' })),
    verifyEmail,
    verifyPhone: vi.fn(async () => ({ ok: true as const })),
    resendEmail: vi.fn(async () => ({ ok: true as const })),
    resendCode: vi.fn(async () => ({ ok: true as const })),
    requestPasswordReset: vi.fn(async () => ({ ok: true as const })),
    resetPassword: vi.fn(async () => ({ ok: true as const })),
  };
}

/** Sets the hash and lets its hashchange event fire before a render, as on a fresh page load. */
async function openAt(hash: string) {
  window.location.hash = hash;
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(async () => {
  localStorage.clear();
  savePending({ email: 'pat@acme.com', phone: '+15555550100' });
  await openAt('#/verify?token=link-token');
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
  localStorage.clear();
});

describe('AuthContainer verify flow', () => {
  it('takes an allow-listed tester from the email link straight to log in, never the phone step', async () => {
    const api = mockApi(vi.fn(async () => ({ ok: true as const, phoneRequired: false })));
    render(<AuthContainer onSignedIn={() => undefined} api={api} />);
    await waitFor(() => expect(screen.getByText("You're all set.")).toBeTruthy());
    expect(api.verifyEmail).toHaveBeenCalledWith('link-token');
    expect(screen.queryByLabelText('SMS code')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Create your account' })).toBeNull();
    screen.getByRole('button', { name: 'Log in' }).click();
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
    expect(loadPending()).toBeNull();
  });

  it('resumes an allow-listed tester at done after a refresh, not the phone step', async () => {
    savePending({ email: 'pat@acme.com', phone: '+15555550100', emailVerified: true, phoneRequired: false });
    await openAt('#/verify');
    const api = mockApi(vi.fn(async () => ({ ok: true as const })));
    render(<AuthContainer onSignedIn={() => undefined} api={api} />);
    expect(screen.getByText("You're all set.")).toBeTruthy();
    expect(screen.queryByLabelText('SMS code')).toBeNull();
    expect(api.verifyEmail).not.toHaveBeenCalled();
  });

  it('takes a normal user from the email link to the phone step', async () => {
    const api = mockApi(vi.fn(async () => ({ ok: true as const, phoneRequired: true })));
    render(<AuthContainer onSignedIn={() => undefined} api={api} />);
    await waitFor(() => expect(screen.getByLabelText('SMS code')).toBeTruthy());
    expect(screen.queryByText("You're all set.")).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Create your account' })).toBeNull();
    expect(loadPending()?.emailVerified).toBe(true);
  });

  it('still shows the phone step when an older API sends no flag', async () => {
    const api = mockApi(vi.fn(async () => ({ ok: true as const })));
    render(<AuthContainer onSignedIn={() => undefined} api={api} />);
    await waitFor(() => expect(screen.getByLabelText('SMS code')).toBeTruthy());
  });
});

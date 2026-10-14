import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api';
import { MemoryStorage } from '@/test/setup';
import {
  loadPending,
  logInAction,
  messageOf,
  PENDING_KEY,
  requestResetAction,
  resendCodeAction,
  resendEmailAction,
  savePending,
  setPasswordAction,
  signUpAction,
  verifyEmailAction,
  verifyPhoneAction,
  type AuthApi,
} from './controller';

function mockApi(): { [K in keyof AuthApi]: ReturnType<typeof vi.fn> } & AuthApi {
  return {
    logIn: vi.fn().mockResolvedValue(undefined),
    signUp: vi.fn().mockResolvedValue({ userId: 'u1' }),
    verifyEmail: vi.fn().mockResolvedValue({ ok: true }),
    verifyPhone: vi.fn().mockResolvedValue({ ok: true }),
    resendEmail: vi.fn().mockResolvedValue({ ok: true }),
    resendCode: vi.fn().mockResolvedValue({ ok: true }),
    requestPasswordReset: vi.fn().mockResolvedValue({ ok: true }),
    resetPassword: vi.fn().mockResolvedValue({ ok: true }),
  } as never;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

describe('messageOf', () => {
  it('shows API error text as given', () => {
    expect(messageOf(new ApiError('Email or password is wrong', 401))).toBe('Email or password is wrong');
  });

  it('hides non-API errors behind a plain line', () => {
    expect(messageOf(new TypeError('x is undefined'))).toBe('Something went wrong. Try again.');
  });
});

describe('logInAction', () => {
  it('calls the client and reports done', async () => {
    const api = mockApi();
    await expect(logInAction(api, 'a@acme.com', 'pw')).resolves.toEqual({ state: 'done', message: '' });
    expect(api.logIn).toHaveBeenCalledWith('a@acme.com', 'pw');
  });

  it('reports the API error message', async () => {
    const api = mockApi();
    api.logIn.mockRejectedValue(new ApiError('Verify your email first', 403));
    await expect(logInAction(api, 'a@acme.com', 'pw')).resolves.toEqual({
      state: 'error',
      message: 'Verify your email first',
    });
  });

  it('reports a network failure with the client message', async () => {
    const api = mockApi();
    api.logIn.mockRejectedValue(new ApiError('The API is not reachable', 0));
    const status = await logInAction(api, 'a@acme.com', 'pw');
    expect(status).toEqual({ state: 'error', message: 'The API is not reachable' });
  });
});

describe('signUpAction', () => {
  const values = { email: 'a@acme.com', name: 'Ann', password: 'twelve chars!', phone: '+15555550100' };

  it('sends the values and remembers the sign-up for the verify step', async () => {
    const api = mockApi();
    const status = await signUpAction(api, values);
    expect(status.state).toBe('done');
    expect(api.signUp).toHaveBeenCalledWith(values);
    expect(loadPending()).toEqual({ email: 'a@acme.com', phone: '+15555550100', emailVerified: false });
  });

  it('keeps nothing when the server refuses', async () => {
    const api = mockApi();
    api.signUp.mockRejectedValue(new ApiError('That email is already registered', 409));
    const status = await signUpAction(api, values);
    expect(status).toEqual({ state: 'error', message: 'That email is already registered' });
    expect(loadPending()).toBeNull();
  });
});

describe('verify', () => {
  it('marks the email verified so a refresh resumes at the code', async () => {
    const api = mockApi();
    savePending({ email: 'a@acme.com', phone: '+15555550100' });
    const status = await verifyEmailAction(api, 'link-token');
    expect(status.state).toBe('done');
    expect(api.verifyEmail).toHaveBeenCalledWith('link-token');
    expect(loadPending()?.emailVerified).toBe(true);
  });

  it('does not mark anything when the link is bad', async () => {
    const api = mockApi();
    api.verifyEmail.mockRejectedValue(new ApiError('That link has expired', 400));
    savePending({ email: 'a@acme.com', phone: '+15555550100' });
    expect(await verifyEmailAction(api, 'old')).toEqual({ state: 'error', message: 'That link has expired' });
    expect(loadPending()?.emailVerified).toBe(false);
  });

  it('verifies the phone and clears the pending sign-up', async () => {
    const api = mockApi();
    savePending({ email: 'a@acme.com', phone: '+15555550100' });
    const status = await verifyPhoneAction(api, '+15555550100', '123456');
    expect(status.state).toBe('done');
    expect(api.verifyPhone).toHaveBeenCalledWith('+15555550100', '123456');
    expect(loadPending()).toBeNull();
  });

  it('keeps the pending sign-up when the code is wrong', async () => {
    const api = mockApi();
    api.verifyPhone.mockRejectedValue(new ApiError('That code is not right', 400));
    savePending({ email: 'a@acme.com', phone: '+15555550100' });
    expect(await verifyPhoneAction(api, '+15555550100', '000000')).toEqual({
      state: 'error',
      message: 'That code is not right',
    });
    expect(loadPending()).not.toBeNull();
  });

  it('resends the email and the code through the client', async () => {
    const api = mockApi();
    expect((await resendEmailAction(api, 'a@acme.com')).state).toBe('done');
    expect(api.resendEmail).toHaveBeenCalledWith('a@acme.com');
    expect((await resendCodeAction(api)).state).toBe('done');
    expect(api.resendCode).toHaveBeenCalledWith();
  });

  it('shows a resend failure', async () => {
    const api = mockApi();
    api.resendCode.mockRejectedValue(new ApiError('Wait a minute before asking again', 429));
    expect(await resendCodeAction(api)).toEqual({
      state: 'error',
      message: 'Wait a minute before asking again',
    });
  });
});

describe('reset', () => {
  it('requests a reset link', async () => {
    const api = mockApi();
    const status = await requestResetAction(api, 'a@acme.com');
    expect(status.state).toBe('done');
    expect(api.requestPasswordReset).toHaveBeenCalledWith('a@acme.com');
  });

  it('sets the new password with the link token', async () => {
    const api = mockApi();
    const status = await setPasswordAction(api, 'reset-tok', 'a new password!');
    expect(status.state).toBe('done');
    expect(api.resetPassword).toHaveBeenCalledWith('reset-tok', 'a new password!');
  });

  it('shows an expired link', async () => {
    const api = mockApi();
    api.resetPassword.mockRejectedValue(new ApiError('That link has expired', 400));
    expect(await setPasswordAction(api, 'old', 'a new password!')).toEqual({
      state: 'error',
      message: 'That link has expired',
    });
  });
});

describe('pending storage', () => {
  it('survives unreadable and blocked storage', () => {
    localStorage.setItem(PENDING_KEY, '{not json');
    expect(loadPending()).toBeNull();
    vi.stubGlobal('localStorage', undefined);
    expect(() => savePending({ email: 'a', phone: 'b' })).not.toThrow();
    expect(loadPending()).toBeNull();
  });
});

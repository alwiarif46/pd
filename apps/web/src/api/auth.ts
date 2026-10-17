import { request, type CallOptions } from './http';
import { getToken, setToken } from './session';
import type { Ok, SignUpInput, VerifyEmailDto } from './types';

/** Creates an account and sends the email link and phone code. */
export function signUp(input: SignUpInput, opts?: CallOptions): Promise<{ userId: string }> {
  return request('/api/auth/signup', { method: 'POST', json: input, signal: opts?.signal });
}

export function verifyEmail(token: string, opts?: CallOptions): Promise<VerifyEmailDto> {
  return request('/api/auth/verify-email', { method: 'POST', json: { token }, signal: opts?.signal });
}

export function verifyPhone(phone: string, code: string, opts?: CallOptions): Promise<Ok> {
  return request('/api/auth/verify-phone', { method: 'POST', json: { phone, code }, signal: opts?.signal });
}

/**
 * Sends a new email verification link. Always 200 `{ ok: true }` (even for unknown or verified
 * addresses); 400 for a bad body, 429 on daily caps.
 */
export function resendEmail(email: string, opts?: CallOptions): Promise<Ok> {
  return request('/api/auth/resend-email', { method: 'POST', json: { email }, signal: opts?.signal });
}

/**
 * Sends a new SMS code. Unauthenticated; the server looks up the phone from the email. Same
 * responses as `resendEmail`.
 */
export function resendCode(email: string, opts?: CallOptions): Promise<Ok> {
  return request('/api/auth/resend-code', { method: 'POST', json: { email }, signal: opts?.signal });
}

/** Signs in and stores the session token. */
export async function logIn(email: string, password: string, opts?: CallOptions): Promise<void> {
  const { token } = await request<{ token: string }>('/api/auth/login', {
    method: 'POST',
    json: { email, password },
    signal: opts?.signal,
  });
  setToken(token);
}

/** Revokes the session on the server when possible. Never throws; always clears the local token. */
export async function logOut(opts?: CallOptions): Promise<void> {
  try {
    await request('/api/auth/logout', { method: 'POST', signal: opts?.signal });
  } catch {
    // The local token is cleared either way.
  } finally {
    setToken(null);
  }
}

export function requestPasswordReset(email: string, opts?: CallOptions): Promise<Ok> {
  return request('/api/auth/reset', { method: 'POST', json: { email }, signal: opts?.signal });
}

export function resetPassword(token: string, password: string, opts?: CallOptions): Promise<Ok> {
  return request('/api/auth/reset', { method: 'POST', json: { token, password }, signal: opts?.signal });
}

export function isSignedIn(): boolean {
  return Boolean(getToken());
}

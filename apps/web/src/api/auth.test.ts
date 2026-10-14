import { describe, expect, it, vi } from 'vitest';
import { callAt, jsonBody, jsonResponse, lastCall, mockFetch } from '../test/fetch';
import { isSignedIn, logIn, logOut, resetPassword, signUp } from './auth';
import { ApiError } from './errors';
import { getMe, updateMe } from './me';
import { getToken, setToken } from './session';

describe('logIn', () => {
  it('stores the token', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { token: 'tok-1' }));
    await logIn('a@acme.com', 'correct horse battery');
    const call = lastCall(fetchMock);
    expect(call.url).toBe('/api/auth/login');
    expect(call.method).toBe('POST');
    expect(call.headers.has('Authorization')).toBe(false);
    expect(jsonBody(call)).toEqual({ email: 'a@acme.com', password: 'correct horse battery' });
    expect(getToken()).toBe('tok-1');
    expect(isSignedIn()).toBe(true);
  });

  it('keeps no token when the server refuses', async () => {
    mockFetch(jsonResponse(401, { error: 'Email or password is wrong' }));
    await expect(logIn('a@acme.com', 'nope')).rejects.toBeInstanceOf(ApiError);
    expect(getToken()).toBeNull();
    expect(isSignedIn()).toBe(false);
  });
});

describe('logOut', () => {
  it('posts with the token and no body, then clears the token', async () => {
    setToken('tok');
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }));
    await logOut();
    const call = lastCall(fetchMock);
    expect(call.url).toBe('/api/auth/logout');
    expect(call.method).toBe('POST');
    expect(call.headers.get('Authorization')).toBe('Bearer tok');
    expect(call.headers.has('Content-Type')).toBe(false);
    expect(getToken()).toBeNull();
  });

  it('clears the token and does not throw when the server fails', async () => {
    setToken('tok');
    mockFetch(jsonResponse(500, { error: 'boom' }));
    await expect(logOut()).resolves.toBeUndefined();
    expect(getToken()).toBeNull();
  });

  it('clears the token and does not throw when the network fails', async () => {
    setToken('tok');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(logOut()).resolves.toBeUndefined();
    expect(getToken()).toBeNull();
  });
});

describe('bodies', () => {
  it('signUp sends the sign-up fields', async () => {
    const fetchMock = mockFetch(jsonResponse(201, { userId: 'u1' }));
    const input = { email: 'a@acme.com', name: 'Ann', password: 'twelve chars!', phone: '+15555550100' };
    await expect(signUp(input)).resolves.toEqual({ userId: 'u1' });
    const call = lastCall(fetchMock);
    expect(call.url).toBe('/api/auth/signup');
    expect(call.method).toBe('POST');
    expect(jsonBody(call)).toEqual(input);
  });

  it('resetPassword sends the token and the new password', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }));
    await resetPassword('reset-tok', 'a new password');
    const call = lastCall(fetchMock);
    expect(call.url).toBe('/api/auth/reset');
    expect(call.method).toBe('POST');
    expect(jsonBody(call)).toEqual({ token: 'reset-tok', password: 'a new password' });
  });
});

describe('me', () => {
  it('reads and patches the account', async () => {
    setToken('tok');
    const me = { id: 'u1', email: 'a@acme.com', name: 'Ann', phone: null, orgId: null };
    const fetchMock = mockFetch(jsonResponse(200, me), jsonResponse(200, { ok: true }));
    await expect(getMe()).resolves.toEqual(me);
    expect(callAt(fetchMock, 0).url).toBe('/api/me');
    await updateMe({ name: 'Annie' });
    const call = callAt(fetchMock, 1);
    expect(call.url).toBe('/api/me');
    expect(call.method).toBe('PATCH');
    expect(jsonBody(call)).toEqual({ name: 'Annie' });
  });
});

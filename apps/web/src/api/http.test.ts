import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody, jsonResponse, lastCall, mockFetch, textResponse } from '../test/fetch';
import { ApiError } from './errors';
import { request, requestBlob, seg } from './http';
import { onUnauthorized, setToken } from './session';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

const unsubscribers: Array<() => void> = [];
afterEach(() => {
  while (unsubscribers.length) {
    unsubscribers.pop()?.();
  }
});

describe('request headers and body', () => {
  it('sends Authorization only when a token exists', async () => {
    const fetchMock = mockFetch(jsonResponse(200, {}), jsonResponse(200, {}));
    await request('/api/me');
    expect(lastCall(fetchMock).headers.has('Authorization')).toBe(false);
    setToken('tok');
    await request('/api/me');
    expect(lastCall(fetchMock).headers.get('Authorization')).toBe('Bearer tok');
  });

  it('defaults to GET', async () => {
    const fetchMock = mockFetch(jsonResponse(200, {}));
    await request('/api/me');
    expect(lastCall(fetchMock).method).toBe('GET');
  });

  it('sends JSON with a Content-Type', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }));
    await request('/api/org', { method: 'PATCH', json: { name: 'Acme' } });
    const call = lastCall(fetchMock);
    expect(call.method).toBe('PATCH');
    expect(call.headers.get('Content-Type')).toBe('application/json');
    expect(jsonBody(call)).toEqual({ name: 'Acme' });
  });

  it('sends no Content-Type on a body-less POST', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }));
    await request('/api/auth/logout', { method: 'POST' });
    const call = lastCall(fetchMock);
    expect(call.headers.has('Content-Type')).toBe(false);
    expect(call.body).toBeUndefined();
  });

  it('sends binary bodies as octet-stream', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ok: true }));
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await request('/api/uploads/u/chunks/0', { method: 'PUT', binary: bytes });
    const call = lastCall(fetchMock);
    expect(call.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(call.body).toBe(bytes);
  });

  it('never sends X-Org-Id', async () => {
    setToken('tok');
    const fetchMock = mockFetch(jsonResponse(200, {}));
    await request('/api/bids');
    expect(lastCall(fetchMock).headers.has('X-Org-Id')).toBe(false);
  });

  it('serializes the query and skips undefined values', async () => {
    const fetchMock = mockFetch(jsonResponse(200, {}));
    await request('/api/documents/d/pages', { query: { from: 1, to: undefined, flag: true } });
    expect(lastCall(fetchMock).url).toBe('/api/documents/d/pages?from=1&flag=true');
  });

  it('adds no "?" when every query value is undefined', async () => {
    const fetchMock = mockFetch(jsonResponse(200, {}));
    await request('/api/x', { query: { a: undefined } });
    expect(lastCall(fetchMock).url).toBe('/api/x');
  });
});

describe('seg', () => {
  it('encodes slashes and other reserved characters', () => {
    expect(seg('a/b')).toBe('a%2Fb');
    expect(seg('a b?c')).toBe('a%20b%3Fc');
  });
});

describe('request responses', () => {
  it('returns undefined for 204', async () => {
    mockFetch(jsonResponse(204));
    await expect(request('/api/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('returns undefined for an ok empty body', async () => {
    mockFetch(new Response('', { status: 200 }));
    await expect(request('/api/x')).resolves.toBeUndefined();
  });

  it('returns parsed JSON', async () => {
    mockFetch(jsonResponse(200, { id: '1' }));
    await expect(request<{ id: string }>('/api/x')).resolves.toEqual({ id: '1' });
  });

  it('maps an error body to its exact message and status', async () => {
    mockFetch(jsonResponse(409, { error: 'This bid already exists' }));
    const error = await rejection(request('/api/x'));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('This bid already exists');
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBeUndefined();
  });

  it('keeps the machine code next to the readable message', async () => {
    mockFetch(jsonResponse(402, { error: 'No RFP credits left.', code: 'out_of_credits' }));
    const error = (await rejection(request('/api/x'))) as ApiError;
    expect(error.message).toBe('No RFP credits left.');
    expect(error.code).toBe('out_of_credits');
  });

  it('maps a non-JSON error body to the network message', async () => {
    mockFetch(textResponse(502, '<html>Bad gateway</html>'));
    const error = (await rejection(request('/api/x'))) as ApiError;
    expect(error.message).toBe('The API is not reachable');
    expect(error.status).toBe(502);
  });

  it('maps JSON without an error string to "The request failed"', async () => {
    mockFetch(jsonResponse(500, { message: 'nope' }));
    const error = (await rejection(request('/api/x'))) as ApiError;
    expect(error.message).toBe('The request failed');
    expect(error.status).toBe(500);
  });

  it('maps an empty error body to "The request failed"', async () => {
    mockFetch(new Response('', { status: 404 }));
    const error = (await rejection(request('/api/x'))) as ApiError;
    expect(error.message).toBe('The request failed');
    expect(error.status).toBe(404);
  });

  it('maps an ok non-JSON body to "The server sent an unexpected response"', async () => {
    mockFetch(textResponse(200, 'hello'));
    const error = (await rejection(request('/api/x'))) as ApiError;
    expect(error.message).toBe('The server sent an unexpected response');
    expect(error.status).toBe(200);
  });

  it('maps a network failure to ApiError status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const error = (await rejection(request('/api/x'))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('The API is not reachable');
    expect(error.status).toBe(0);
  });

  it('rethrows an AbortError unchanged and forwards the signal', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Promise.reject(abortError));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const error = await rejection(request('/api/x', { signal: controller.signal }));
    expect(error).toBe(abortError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

describe('401 handling', () => {
  it('notifies listeners on 401 when a token was sent, and does not clear the token', async () => {
    const listener = vi.fn();
    unsubscribers.push(onUnauthorized(listener));
    setToken('tok');
    mockFetch(jsonResponse(401, { error: 'Sign in again' }));
    const error = (await rejection(request('/api/me'))) as ApiError;
    expect(error.status).toBe(401);
    expect(error.message).toBe('Sign in again');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('pd-token')).toBe('tok');
  });

  it('does not notify on 401 when no token was sent', async () => {
    const listener = vi.fn();
    unsubscribers.push(onUnauthorized(listener));
    mockFetch(jsonResponse(401, { error: 'Wrong email or password' }));
    await rejection(request('/api/auth/login', { method: 'POST', json: {} }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('requestBlob', () => {
  it('returns the body as a Blob', async () => {
    mockFetch(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    const blob = await requestBlob('/api/documents/d/file');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(4);
  });

  it('maps an error JSON body', async () => {
    mockFetch(jsonResponse(410, { error: 'This file was archived' }));
    const error = (await rejection(requestBlob('/api/documents/d/file'))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('This file was archived');
    expect(error.status).toBe(410);
  });
});

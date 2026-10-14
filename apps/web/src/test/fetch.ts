import { vi, type Mock } from 'vitest';

export type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

/** A JSON `Response`. Status 204 (or an undefined body) sends no body. */
export function jsonResponse(status: number, body?: unknown): Response {
  if (status === 204 || body === undefined) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A plain-text `Response`, for non-JSON bodies. */
export function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * Stubs the global `fetch` with a mock that resolves the given responses in order.
 * Once they run out, every further call resolves `204 No Content`.
 */
export function mockFetch(...responses: Response[]): FetchMock {
  const queue = [...responses];
  const fn: FetchMock = vi.fn(async () => queue.shift() ?? new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'] | undefined;
  signal: AbortSignal | null | undefined;
}

/** The `index`th recorded call (default: the last one). */
export function callAt(fetchMock: FetchMock, index?: number): RecordedCall {
  const calls = fetchMock.mock.calls;
  const call = calls[index ?? calls.length - 1];
  if (!call) {
    throw new Error('fetch was not called');
  }
  const [input, init] = call;
  return {
    url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    method: init?.method ?? 'GET',
    headers: new Headers(init?.headers),
    body: init?.body,
    signal: init?.signal,
  };
}

export function lastCall(fetchMock: FetchMock): RecordedCall {
  return callAt(fetchMock);
}

/** Parses a recorded string body as JSON; `undefined` when there is no body. */
export function jsonBody(call: RecordedCall): unknown {
  if (call.body === undefined || call.body === null) {
    return undefined;
  }
  if (typeof call.body !== 'string') {
    throw new Error('The request body is not a string');
  }
  return JSON.parse(call.body) as unknown;
}

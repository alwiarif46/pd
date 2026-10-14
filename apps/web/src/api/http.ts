import { ApiError, isAbortError, NETWORK_ERROR_MESSAGE } from './errors';
import { getToken, notifyUnauthorized } from './session';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CallOptions {
  signal?: AbortSignal;
}

export interface RequestOptions extends CallOptions {
  /** Default 'GET'. */
  method?: HttpMethod;
  /** Sent as JSON with `Content-Type: application/json`. */
  json?: unknown;
  /** Sent as is with `Content-Type: application/octet-stream`. */
  binary?: Blob | ArrayBuffer;
  /** Appended as a query string; `undefined` values are skipped. */
  query?: Record<string, string | number | boolean | undefined>;
}

/** Encodes one path segment. Use it for every id placed in a path. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  if (!query) {
    return path;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  const search = params.toString();
  if (!search) {
    return path;
  }
  return `${path}${path.includes('?') ? '&' : '?'}${search}`;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers = new Headers();
  const token = getToken();
  const sentToken = Boolean(token);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.json);
  } else if (options.binary !== undefined) {
    headers.set('Content-Type', 'application/octet-stream');
    body = options.binary;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }

  if (response.status === 401 && sentToken) {
    notifyUnauthorized();
  }
  return response;
}

async function errorFrom(response: Response): Promise<ApiError> {
  const text = await response.text();
  if (!text) {
    return new ApiError('The request failed', response.status);
  }
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return new ApiError(NETWORK_ERROR_MESSAGE, response.status || 502);
  }
  if (typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string') {
    return new ApiError((data as { error: string }).error, response.status);
  }
  return new ApiError('The request failed', response.status);
}

/** Sends a request and returns the parsed JSON body (`undefined` for 204 or an empty body). */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  if (!response.ok) {
    throw await errorFrom(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('The server sent an unexpected response', response.status);
  }
}

/** Sends a request and returns the body as a `Blob` (for files). Errors are mapped like `request`. */
export async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const response = await send(path, options);
  if (!response.ok) {
    throw await errorFrom(response);
  }
  return response.blob();
}

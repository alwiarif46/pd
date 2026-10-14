import { ApiError } from './api/errors';
import { getToken as token, setToken } from './api/session';

export { ApiError, token, setToken };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const current = token();
  if (current) {
    headers.set('Authorization', `Bearer ${current}`);
  }
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, { ...init, headers });
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  let data: { error?: string } = {};
  if (text) {
    try {
      data = JSON.parse(text) as { error?: string };
    } catch {
      throw new ApiError(response.ok ? 'The server sent an unexpected response' : 'The API is not reachable', response.status || 502);
    }
  }
  if (!response.ok) {
    throw new ApiError(data.error || 'The request failed', response.status);
  }
  return data as T;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const CHUNK = 20 * 1024 * 1024;

export async function uploadFile(bidId: string, file: File, kind: string): Promise<{ duplicate?: boolean; id?: string }> {
  const bytes = await file.arrayBuffer();
  const hash = await sha256Hex(bytes);
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / CHUNK));
  const session = await api<{ duplicate?: boolean; id?: string }>(`/api/bids/${bidId}/uploads`, {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      kind,
      declaredSize: bytes.byteLength,
      sha256: hash,
      chunkCount,
    }),
  });
  if (session.duplicate || !session.id) {
    return session;
  }
  for (let index = 0; index < chunkCount; index += 1) {
    const slice = bytes.slice(index * CHUNK, (index + 1) * CHUNK);
    const headers = new Headers();
    headers.set('Content-Type', 'application/octet-stream');
    const current = token();
    if (current) {
      headers.set('Authorization', `Bearer ${current}`);
    }
    const response = await fetch(`/api/uploads/${session.id}/chunks/${index}`, {
      method: 'PUT',
      headers,
      body: slice,
    });
    if (!response.ok) {
      const payload = await response.json() as { error?: string };
      throw new ApiError(payload.error || 'Upload failed', response.status);
    }
  }
  await api(`/api/uploads/${session.id}/complete`, { method: 'POST' });
  return session;
}

import { describe, expect, it, vi } from 'vitest';
import { callAt, jsonBody, jsonResponse, mockFetch } from '../test/fetch';
import { ApiError } from './errors';
import { setToken } from './session';
import { sha256Hex, uploadFile } from './uploads';

const TEN_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function tenByteFile(): File {
  return new File([TEN_BYTES], 'rfp.pdf', { type: 'application/pdf' });
}

function byteLength(body: unknown): number {
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (body instanceof Blob) {
    return body.size;
  }
  throw new Error('Unexpected chunk body');
}

describe('sha256Hex', () => {
  it('hashes "abc"', async () => {
    const bytes = new TextEncoder().encode('abc');
    await expect(sha256Hex(bytes.buffer as ArrayBuffer)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('uploadFile', () => {
  it('stops after opening the session when the file is a duplicate', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { duplicate: true }));
    await expect(uploadFile('b1', tenByteFile(), 'solicitation')).resolves.toEqual({ duplicate: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens, sends each chunk in order, and completes', async () => {
    setToken('tok');
    const fetchMock = mockFetch(
      jsonResponse(201, { id: 's1', expiresAt: '2026-10-15T00:00:00.000Z' }),
      jsonResponse(200, { ok: true }),
      jsonResponse(200, { ok: true }),
      jsonResponse(200, { ok: true }),
      jsonResponse(201, { documentId: 'd1', jobId: 'j1' }),
    );
    const onProgress = vi.fn();
    const result = await uploadFile('b1', tenByteFile(), 'solicitation', { chunkBytes: 4, onProgress });

    expect(result).toEqual({ duplicate: false, sessionId: 's1', documentId: 'd1', jobId: 'j1' });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const open = callAt(fetchMock, 0);
    expect(open.url).toBe('/api/bids/b1/uploads');
    expect(open.method).toBe('POST');
    expect(jsonBody(open)).toEqual({
      fileName: 'rfp.pdf',
      kind: 'solicitation',
      declaredSize: 10,
      sha256: await sha256Hex(TEN_BYTES.buffer as ArrayBuffer),
      chunkCount: 3,
    });

    const lengths = [4, 4, 2];
    for (let index = 0; index < 3; index += 1) {
      const put = callAt(fetchMock, index + 1);
      expect(put.url).toBe(`/api/uploads/s1/chunks/${index}`);
      expect(put.method).toBe('PUT');
      expect(put.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(put.headers.get('Authorization')).toBe('Bearer tok');
      expect(byteLength(put.body)).toBe(lengths[index]);
    }

    const complete = callAt(fetchMock, 4);
    expect(complete.url).toBe('/api/uploads/s1/complete');
    expect(complete.method).toBe('POST');
    expect(complete.body).toBeUndefined();
    expect(complete.headers.has('Content-Type')).toBe(false);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, { chunksSent: 1, chunkCount: 3 });
    expect(onProgress).toHaveBeenNthCalledWith(3, { chunksSent: 3, chunkCount: 3 });
  });

  it('throws the server message when a chunk fails', async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { id: 's1', expiresAt: '2026-10-15T00:00:00.000Z' }),
      jsonResponse(404, { error: 'Upload session not found' }),
    );
    const error = await uploadFile('b1', tenByteFile(), 'attachment', { chunkBytes: 4 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('Upload session not found');
    expect((error as ApiError).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops before the next chunk when the signal is aborted', async () => {
    const controller = new AbortController();
    const fetchMock = mockFetch(
      jsonResponse(201, { id: 's1', expiresAt: '2026-10-15T00:00:00.000Z' }),
      jsonResponse(200, { ok: true }),
    );
    const onProgress = vi.fn(() => controller.abort());
    const error = await uploadFile('b1', tenByteFile(), 'attachment', {
      chunkBytes: 4,
      onProgress,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as { name?: string }).name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws before any request when the file is empty', async () => {
    const fetchMock = mockFetch();
    const error = await uploadFile('b1', new File([], 'empty.pdf'), 'attachment').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('This file is empty');
    expect((error as ApiError).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

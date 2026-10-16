import { ApiError } from './errors';
import { request, seg, type CallOptions } from './http';
import type { FileKind, Ok, OpenUploadInput, UploadCompleteDto, UploadSessionDto } from './types';

/** Upload chunk size. Must equal the server's `CHUNK_BYTES`. */
export const CHUNK_BYTES = 20 * 1024 * 1024;

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Opens an upload session. Returns `{ duplicate: true }` when the bid already has this file. */
export function openUploadSession(bidId: string, input: OpenUploadInput, opts?: CallOptions): Promise<UploadSessionDto> {
  return request(`/api/bids/${seg(bidId)}/uploads`, { method: 'POST', json: input, signal: opts?.signal });
}

export function putUploadChunk(
  sessionId: string,
  index: number,
  chunk: Blob | ArrayBuffer,
  opts?: CallOptions,
): Promise<Ok> {
  return request(`/api/uploads/${seg(sessionId)}/chunks/${index}`, {
    method: 'PUT',
    binary: chunk,
    signal: opts?.signal,
  });
}

export function completeUpload(sessionId: string, opts?: CallOptions): Promise<UploadCompleteDto> {
  return request(`/api/uploads/${seg(sessionId)}/complete`, { method: 'POST', signal: opts?.signal });
}

export interface UploadProgress {
  chunksSent: number;
  chunkCount: number;
}

export type UploadOptions = CallOptions & {
  onProgress?: (progress: UploadProgress) => void;
  /** Defaults to `CHUNK_BYTES`, clamped to `[1, CHUNK_BYTES]`. Exists for tests. */
  chunkBytes?: number;
  /** Amendments only: the amendment's number, 1 to 999. Sent only for `kind` `amendment`. */
  amendmentNo?: number;
};

export type UploadResult =
  | { duplicate: true }
  | { duplicate: false; sessionId: string; documentId: string; jobId: string };

/**
 * Uploads a file to a bid in chunks: hash, open a session, send each chunk in order, complete.
 * Stops before the next chunk when `signal` is aborted. Credits are reserved by the server.
 */
export async function uploadFile(
  bidId: string,
  file: File,
  kind: FileKind,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const { signal, onProgress, amendmentNo } = options;
  if (file.size === 0) {
    throw new ApiError('This file is empty', 400);
  }
  const chunkBytes = Math.min(CHUNK_BYTES, Math.max(1, Math.floor(options.chunkBytes ?? CHUNK_BYTES)));
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / chunkBytes));

  const session = await openUploadSession(
    bidId,
    {
      fileName: file.name,
      kind,
      declaredSize: bytes.byteLength,
      sha256,
      chunkCount,
      ...(kind === 'amendment' && amendmentNo !== undefined ? { amendmentNo } : {}),
    },
    { signal },
  );
  if ('duplicate' in session) {
    return { duplicate: true };
  }

  for (let index = 0; index < chunkCount; index += 1) {
    signal?.throwIfAborted();
    const chunk = bytes.slice(index * chunkBytes, (index + 1) * chunkBytes);
    await putUploadChunk(session.id, index, chunk, { signal });
    onProgress?.({ chunksSent: index + 1, chunkCount });
  }

  const { documentId, jobId } = await completeUpload(session.id, { signal });
  return { duplicate: false, sessionId: session.id, documentId, jobId };
}

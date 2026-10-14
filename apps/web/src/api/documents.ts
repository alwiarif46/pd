import { request, requestBlob, seg, type CallOptions } from './http';
import type { DocumentDto, DocumentPagesDto, KeyOverrideDto, Ok, RestoreDocumentDto, ViewTokenDto } from './types';

export function listDocuments(bidId: string, opts?: CallOptions): Promise<DocumentDto[]> {
  return request(`/api/bids/${seg(bidId)}/documents`, { signal: opts?.signal });
}

export function getViewToken(documentId: string, opts?: CallOptions): Promise<ViewTokenDto> {
  return request(`/api/documents/${seg(documentId)}/view-token`, { signal: opts?.signal });
}

export function resolveViewToken(token: string, opts?: CallOptions): Promise<{ documentId: string }> {
  return request(`/api/documents/view/${seg(token)}`, { signal: opts?.signal });
}

/** Extracted page text for pages `from`..`to` (inclusive; `to` defaults to `from` on the server). */
export function getDocumentPages(
  documentId: string,
  range: { from: number; to?: number },
  opts?: CallOptions,
): Promise<DocumentPagesDto> {
  return request(`/api/documents/${seg(documentId)}/pages`, {
    query: { from: range.from, to: range.to },
    signal: opts?.signal,
  });
}

/** The viewer PDF. Errors (404, 409, 410) arrive as `ApiError`. */
export function getDocumentFile(documentId: string, opts?: CallOptions): Promise<Blob> {
  return requestBlob(`/api/documents/${seg(documentId)}/file`, { signal: opts?.signal });
}

export function confirmMarking(documentId: string, opts?: CallOptions): Promise<Ok> {
  return request(`/api/documents/${seg(documentId)}/confirm-marking`, { method: 'POST', signal: opts?.signal });
}

/** Owner only. 409 `override_limit` once the bid has none left; `remaining` is what is left after this one. */
export function overrideSolicitationKey(
  documentId: string,
  reason: string,
  opts?: CallOptions,
): Promise<KeyOverrideDto> {
  return request(`/api/documents/${seg(documentId)}/key-override`, {
    method: 'POST',
    json: { reason },
    signal: opts?.signal,
  });
}

/**
 * Asks for an archived file back. Answers `{ status: 'restore_requested' }`, or the current state
 * when a restore is already pending. 402 `plan_required` when free restores are turned off;
 * 409 when the file is not archived.
 */
export function restoreDocument(documentId: string, opts?: CallOptions): Promise<RestoreDocumentDto> {
  return request(`/api/documents/${seg(documentId)}/restore`, { method: 'POST', signal: opts?.signal });
}

export function deleteDocument(documentId: string, opts?: CallOptions): Promise<Ok> {
  return request(`/api/documents/${seg(documentId)}`, { method: 'DELETE', signal: opts?.signal });
}

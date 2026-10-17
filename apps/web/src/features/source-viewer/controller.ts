import { createElement } from 'react';
import * as client from '@/api';
import { isAbortError, type DocumentDto } from '@/api';
import type { PageText, SourceView } from '@/types';
import { messageOf } from '@/features/shared/messages';

/** The calls the source viewer makes; tests pass fakes. */
export interface SourceApi {
  getViewToken: typeof client.getViewToken;
  resolveViewToken: typeof client.resolveViewToken;
  getDocumentPages: typeof client.getDocumentPages;
  getDocumentFile: typeof client.getDocumentFile;
  restoreDocument: typeof client.restoreDocument;
}

export const sourceApi: SourceApi = client;

/** What the viewer opens: a document, its page (or page range), and the stored quote. */
export interface SourceRef {
  documentId: string;
  page: number;
  pageEnd: number | null;
  quote: string | null;
}

export interface LoadedSource {
  view: SourceView;
  /** The object URL of the viewer PDF in `view` (page mode); the caller revokes it. */
  objectUrl: string | null;
  /** The file name the pages endpoint reports, or null when the load failed before it. */
  fileName: string | null;
}

/** 09 s5.18 has no mode for a deleted file that is not a resume (plan Open question 6). */
export const DELETED_FILE_MESSAGE = 'This file was deleted. Its rows keep the stored quote.';

/** The PDF page in an iframe, opened at the source page. */
export function pageViewFor(url: string, page: number) {
  return createElement('iframe', { title: 'Document page', src: `${url}#page=${page}`, className: 'h-[70vh] w-full border-0' });
}

/**
 * Loads a source for the viewer (09 s5.18): a viewing token (resolved once, as the legacy viewer did), the
 * stored page text for the page range, then by the file's state: a live or restored file shows the viewer PDF
 * at the page (a Word file whose conversion fell back to text shows the text, "Page estimated"); an archived
 * file shows the page text with its restore state; a deleted resume says so, and any other deleted file is an
 * error with DELETED_FILE_MESSAGE. A failed request is an error view with the API's message. An abort rejects.
 */
export async function loadSource(
  api: SourceApi,
  ref: SourceRef,
  kind: DocumentDto['kind'] | null,
  signal: AbortSignal,
  createUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): Promise<LoadedSource> {
  let fileName: string | null = null;
  try {
    const grant = await api.getViewToken(ref.documentId, { signal });
    await api.resolveViewToken(grant.token, { signal });
    const to = Math.max(ref.page, ref.pageEnd ?? ref.page);
    const payload = await api.getDocumentPages(ref.documentId, { from: ref.page, to }, { signal });
    fileName = payload.fileName;
    const pages: PageText[] = payload.pages.map((p) => ({ pageNo: p.pageNo, text: p.text }));
    switch (payload.liveStatus) {
      case 'archived':
        return { view: { mode: 'archived', pages, restore: 'none' }, objectUrl: null, fileName };
      case 'restore_requested':
        return { view: { mode: 'archived', pages, restore: 'requested' }, objectUrl: null, fileName };
      case 'restoring':
        return { view: { mode: 'archived', pages, restore: 'restoring' }, objectUrl: null, fileName };
      case 'deleted':
        return {
          view: kind === 'resume' ? { mode: 'resume_deleted' } : { mode: 'error', message: DELETED_FILE_MESSAGE },
          objectUrl: null,
          fileName,
        };
      default: {
        // live, restored, or not reported
        if (payload.extractMethod === 'docx_text_fallback') return { view: { mode: 'text', pages }, objectUrl: null, fileName };
        const blob = await api.getDocumentFile(ref.documentId, { signal });
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const url = createUrl(blob);
        return { view: { mode: 'page', pageView: pageViewFor(url, ref.page) }, objectUrl: url, fileName };
      }
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    return { view: { mode: 'error', message: messageOf(error) }, objectUrl: null, fileName };
  }
}

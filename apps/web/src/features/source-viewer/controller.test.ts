import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type DocumentPagesDto } from '@/api';
import { DELETED_FILE_MESSAGE, loadSource, type SourceApi } from './controller';

const ref = { documentId: 'doc-1', page: 4, pageEnd: null, quote: 'Proposals are due.' };

function pages(over: Partial<DocumentPagesDto> = {}): DocumentPagesDto {
  return {
    fileName: 'rfp.pdf',
    liveStatus: 'live',
    pagesEstimated: null,
    extractMethod: 'pdf_text',
    pages: [
      {
        id: 'p4',
        orgId: 'org-1',
        createdAt: '',
        updatedAt: '',
        documentId: 'doc-1',
        pageNo: 4,
        text: 'Proposals are due.',
        ocrUsed: false,
        sectionTag: null,
      },
    ],
    ...over,
  };
}

function mockApi(over: Partial<SourceApi> = {}): SourceApi {
  return {
    getViewToken: vi.fn(async () => ({ token: 'tok', expiresInSeconds: 900 })),
    resolveViewToken: vi.fn(async () => ({ documentId: 'doc-1' })),
    getDocumentPages: vi.fn(async () => pages()),
    getDocumentFile: vi.fn(async () => new Blob(['%PDF'])),
    restoreDocument: vi.fn(async () => ({ status: 'restore_requested' as const })),
    ...over,
  };
}

const signal = () => new AbortController().signal;
const url = () => 'blob:pdf-1';

describe('loadSource', () => {
  it.each(['live', 'restored', null] as const)('shows the viewer PDF at the page for a %s file', async (liveStatus) => {
    const api = mockApi({ getDocumentPages: vi.fn(async () => pages({ liveStatus })) });
    const result = await loadSource(api, ref, 'solicitation', signal(), url);
    expect(api.getViewToken).toHaveBeenCalledWith('doc-1', expect.anything());
    expect(api.resolveViewToken).toHaveBeenCalledWith('tok', expect.anything());
    expect(api.getDocumentFile).toHaveBeenCalledWith('doc-1', expect.anything());
    expect(result.objectUrl).toBe('blob:pdf-1');
    expect(result.fileName).toBe('rfp.pdf');
    expect(result.view.mode).toBe('page');
    const pageView = result.view.mode === 'page' ? result.view.pageView : null;
    expect(isValidElement(pageView)).toBe(true);
    expect((pageView as { props: { src: string; title: string } }).props).toMatchObject({ src: 'blob:pdf-1#page=4', title: 'Document page' });
  });

  it('asks for the page range, never a range that ends before it starts', async () => {
    const api = mockApi();
    await loadSource(api, { ...ref, pageEnd: 6 }, null, signal(), url);
    await loadSource(api, { ...ref, pageEnd: 2 }, null, signal(), url);
    expect(vi.mocked(api.getDocumentPages).mock.calls.map((c) => c[1])).toEqual([
      { from: 4, to: 6 },
      { from: 4, to: 4 },
    ]);
  });

  it('shows the page text, "Page estimated", for a Word file that fell back to text, without fetching the file', async () => {
    const api = mockApi({ getDocumentPages: vi.fn(async () => pages({ extractMethod: 'docx_text_fallback' })) });
    const result = await loadSource(api, ref, null, signal(), url);
    expect(result.view).toEqual({ mode: 'text', pages: [{ pageNo: 4, text: 'Proposals are due.' }] });
    expect(api.getDocumentFile).not.toHaveBeenCalled();
    expect(result.objectUrl).toBeNull();
  });

  it.each([
    ['archived', 'none'],
    ['restore_requested', 'requested'],
    ['restoring', 'restoring'],
  ] as const)('shows the page text of a %s file with restore %s', async (liveStatus, restore) => {
    const api = mockApi({ getDocumentPages: vi.fn(async () => pages({ liveStatus })) });
    const result = await loadSource(api, ref, null, signal(), url);
    expect(result.view).toEqual({ mode: 'archived', pages: [{ pageNo: 4, text: 'Proposals are due.' }], restore });
    expect(api.getDocumentFile).not.toHaveBeenCalled();
  });

  it('says a deleted resume was deleted, and any other deleted file is an error with the stored-quote message', async () => {
    const api = mockApi({ getDocumentPages: vi.fn(async () => pages({ liveStatus: 'deleted', pages: [] })) });
    expect((await loadSource(api, ref, 'resume', signal(), url)).view).toEqual({ mode: 'resume_deleted' });
    expect((await loadSource(api, ref, 'attachment', signal(), url)).view).toEqual({ mode: 'error', message: DELETED_FILE_MESSAGE });
    expect((await loadSource(api, ref, null, signal(), url)).view).toEqual({ mode: 'error', message: DELETED_FILE_MESSAGE });
    expect(api.getDocumentFile).not.toHaveBeenCalled();
  });

  it('turns a failed request into an error view with the message', async () => {
    const api = mockApi({ getDocumentFile: vi.fn(async () => Promise.reject(new ApiError('The file is not ready.', 409))) });
    expect((await loadSource(api, ref, null, signal(), url)).view).toEqual({ mode: 'error', message: 'The file is not ready.' });
    const tokenless = mockApi({ getViewToken: vi.fn(async () => Promise.reject(new ApiError('Not allowed.', 403))) });
    expect((await loadSource(tokenless, ref, null, signal(), url)).view).toEqual({ mode: 'error', message: 'Not allowed.' });
  });

  it('rejects when aborted, and makes no object URL', async () => {
    const abort = new AbortController();
    const createUrl = vi.fn(url);
    const api = mockApi({
      getDocumentFile: vi.fn(async () => {
        abort.abort();
        return new Blob(['%PDF']);
      }),
    });
    await expect(loadSource(api, ref, null, abort.signal, createUrl)).rejects.toMatchObject({ name: 'AbortError' });
    expect(createUrl).not.toHaveBeenCalled();
  });
});

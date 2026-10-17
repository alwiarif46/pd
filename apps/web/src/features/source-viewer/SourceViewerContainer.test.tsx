// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ApiError, type DocumentDto, type DocumentPagesDto } from '@/api';
import { bidDto, docDto, meDto, orgPayload } from '@/test/fixtures';
import { ShellContext, type ShellContextValue } from '@/features/shell/bid-context';
import { DELETED_FILE_MESSAGE, type SourceApi, type SourceRef } from './controller';
import { SourceViewerContainer, TOKEN_RENEWAL_MS } from './SourceViewerContainer';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

let urls = 0;
const createObjectURL = vi.fn(() => `blob:pdf-${++urls}`);
const revokeObjectURL = vi.fn();
beforeEach(() => {
  urls = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(toast.error).mockClear();
});

function shellValue(over: Partial<ShellContextValue> = {}): ShellContextValue {
  return {
    me: meDto(),
    org: orgPayload(),
    summary: { plan: 'starter', creditsLeft: 5, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 300 },
    bids: [bidDto()],
    bidId: 'bid-1',
    tab: 'compliance',
    bid: bidDto(),
    docs: [docDto()],
    jobs: [],
    links: [],
    bidLoaded: true,
    selectedRowId: null,
    detailHost: null,
    refresh: vi.fn(),
    openRow: vi.fn(),
    openUpgrade: vi.fn(),
    confirm: vi.fn(async () => true),
    ...over,
  };
}

function pages(over: Partial<DocumentPagesDto> = {}): DocumentPagesDto {
  return {
    fileName: 'from-pages.pdf',
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
        text: 'Section L. Proposals are due.',
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

const source: SourceRef = { documentId: 'doc-1', page: 4, pageEnd: null, quote: 'Proposals are due.' };

function renderViewer(opts: { api?: SourceApi; docs?: DocumentDto[]; source?: SourceRef | null } = {}) {
  const api = opts.api ?? mockApi();
  const shell = shellValue();
  const onClose = vi.fn();
  const docs = opts.docs ?? [docDto({ id: 'doc-1', fileName: 'rfp.pdf' })];
  const tree = (s: SourceRef | null) => (
    <ShellContext.Provider value={shell}>
      <SourceViewerContainer source={s} docs={docs} onClose={onClose} api={api} />
    </ShellContext.Provider>
  );
  const view = render(tree(opts.source === undefined ? source : opts.source));
  const show = (s: SourceRef | null) => view.rerender(tree(s));
  return { api, shell, onClose, show, ...view };
}

const viewer = () => screen.findByRole('dialog', { name: 'rfp.pdf' });

describe('SourceViewerContainer', () => {
  it('renders nothing while closed', () => {
    const { api } = renderViewer({ source: null });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.getViewToken).not.toHaveBeenCalled();
  });

  it('shows the PDF page in a dialog named for the file, with the quote above it', async () => {
    renderViewer();
    const dialog = await viewer();
    expect(within(dialog).getByText('Page 4')).toBeTruthy();
    const frame = (await within(dialog).findByTitle('Document page')) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('blob:pdf-1#page=4');
    expect(within(dialog).getByText('Proposals are due.')).toBeTruthy();
  });

  it('names the file from the pages answer when it is not in the bid documents', async () => {
    renderViewer({ docs: [] });
    expect(await screen.findByRole('dialog', { name: 'from-pages.pdf' })).toBeTruthy();
  });

  it('shows the marked page text for a Word file that fell back to text', async () => {
    renderViewer({ api: mockApi({ getDocumentPages: vi.fn(async () => pages({ extractMethod: 'docx_text_fallback' })) }) });
    const dialog = await viewer();
    expect(await within(dialog).findByText('Page estimated')).toBeTruthy();
    expect(within(dialog).getByText('Proposals are due.', { selector: 'mark' })).toBeTruthy();
  });

  it('shows a deleted resume as deleted, and another deleted file as an error', async () => {
    const api = mockApi({ getDocumentPages: vi.fn(async () => pages({ liveStatus: 'deleted', pages: [] })) });
    const { unmount } = renderViewer({ api, docs: [docDto({ id: 'doc-1', fileName: 'rfp.pdf', kind: 'resume' })] });
    expect(await within(await viewer()).findByText('Resume deleted after 90 days')).toBeTruthy();
    unmount();
    renderViewer({ api, docs: [docDto({ id: 'doc-1', fileName: 'rfp.pdf', kind: 'attachment' })] });
    expect((await within(await viewer()).findByRole('alert')).textContent).toBe(DELETED_FILE_MESSAGE);
  });

  it('shows an error with Try again, which loads again', async () => {
    const api = mockApi({
      getDocumentPages: vi.fn().mockRejectedValueOnce(new ApiError('Could not load the page.', 500)).mockResolvedValue(pages()) as SourceApi['getDocumentPages'],
    });
    const user = userEvent.setup();
    renderViewer({ api });
    const dialog = await viewer();
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Could not load the page.');
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByTitle('Document page')).toBeTruthy();
    expect(api.getDocumentPages).toHaveBeenCalledTimes(2);
  });

  it('requests a restore of an archived file, then reloads the viewer and the shell', async () => {
    const getDocumentPages = vi
      .fn()
      .mockResolvedValueOnce(pages({ liveStatus: 'archived' }))
      .mockResolvedValue(pages({ liveStatus: 'restore_requested' })) as SourceApi['getDocumentPages'];
    const api = mockApi({ getDocumentPages });
    const user = userEvent.setup();
    const { shell } = renderViewer({ api });
    const dialog = await viewer();
    expect(await within(dialog).findByText('This file is archived. The stored quote and page text are shown.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Restore file' }));
    expect(api.restoreDocument).toHaveBeenCalledWith('doc-1');
    expect(await within(dialog).findByRole('button', { name: 'Restore requested' })).toBeTruthy();
    expect(shell.refresh).toHaveBeenCalledTimes(1);
  });

  it('opens Upgrade when the restore needs a plan (402), and shows any other refusal', async () => {
    const restoreDocument = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Restores are on a paid plan.', 402, 'plan_required'))
      .mockRejectedValueOnce(new ApiError('No archive copy is left.', 409, 'no_archive_copy')) as SourceApi['restoreDocument'];
    const api = mockApi({ getDocumentPages: vi.fn(async () => pages({ liveStatus: 'archived' })), restoreDocument });
    const user = userEvent.setup();
    const { shell } = renderViewer({ api });
    const restore = await within(await viewer()).findByRole('button', { name: 'Restore file' });
    await user.click(restore);
    await waitFor(() => expect(shell.openUpgrade).toHaveBeenCalledWith('plan'));
    await user.click(restore);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No archive copy is left.'));
    expect(shell.refresh).not.toHaveBeenCalled();
  });

  it('revokes the object URL when the source changes and when the viewer closes', async () => {
    const { show } = renderViewer();
    await within(await viewer()).findByTitle('Document page');
    show({ ...source, page: 5 });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf-1');
    show(null);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pdf-2');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('revokes a URL made after the viewer closed', async () => {
    let finish!: (blob: Blob) => void;
    const api = mockApi({ getDocumentFile: vi.fn(() => new Promise<Blob>((resolve) => (finish = resolve))) });
    const { show } = renderViewer({ api });
    await waitFor(() => expect(api.getDocumentFile).toHaveBeenCalled());
    show(null);
    await act(async () => finish(new Blob(['%PDF'])));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('renews the viewing token every 10 minutes while open, and stops on close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, show } = renderViewer();
    await within(await viewer()).findByTitle('Document page');
    expect(api.getViewToken).toHaveBeenCalledTimes(1);
    vi.mocked(api.getViewToken).mockRejectedValueOnce(new ApiError('Gone.', 500));
    await act(async () => {
      vi.advanceTimersByTime(TOKEN_RENEWAL_MS);
    });
    expect(api.getViewToken).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(TOKEN_RENEWAL_MS);
    });
    expect(api.getViewToken).toHaveBeenCalledTimes(3);
    show(null);
    await act(async () => {
      vi.advanceTimersByTime(3 * TOKEN_RENEWAL_MS);
    });
    expect(api.getViewToken).toHaveBeenCalledTimes(3);
  });

  it('closes from its Close button', async () => {
    const user = userEvent.setup();
    const { onClose } = renderViewer();
    await user.click(within(await viewer()).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

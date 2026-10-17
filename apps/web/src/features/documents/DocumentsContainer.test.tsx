// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import * as realApi from '@/api';
import { ApiError, type DocumentDto } from '@/api';
import { bidDto, complianceRowDto, docDto, jobDto, linkDto, meDto, orgPayload, organizationDto } from '@/test/fixtures';
import { stashUploadNotices } from '@/features/bids/notices';
import { ShellContext, type ShellContextValue } from '@/features/shell/bid-context';
import type { RowDetailApi } from '@/features/row-detail/controller';
import type { SourceApi } from '@/features/source-viewer/controller';
import type { DocumentsApi } from './controller';
import { DocumentsContainer } from './DocumentsContainer';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

beforeEach(() => {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:pdf'), revokeObjectURL: vi.fn() });
  window.location.hash = '';
});

const MB = 1024 * 1024;
const RFP = docDto({ id: 'doc-1', fileName: 'rfp.pdf', kind: 'solicitation', sizeBytes: 2 * MB, liveUntil: '2026-11-03T00:00:00.000Z' });

function shellValue(over: Partial<ShellContextValue> = {}): ShellContextValue {
  return {
    me: meDto(),
    org: orgPayload({ org: organizationDto({ plan: 'free' }), role: 'owner' }),
    summary: { plan: 'free', creditsLeft: 5, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 50 },
    bids: [bidDto()],
    bidId: 'bid-1',
    tab: 'documents',
    bid: bidDto({ keyOverridesLeft: 2 }),
    docs: [RFP],
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

function mockApi(over: Partial<DocumentsApi> = {}): DocumentsApi {
  return {
    uploadFile: vi.fn(async () => ({ duplicate: false as const, sessionId: 's', documentId: 'd', jobId: 'j' })),
    confirmMarking: vi.fn(async () => ({ ok: true as const })),
    deleteDocument: vi.fn(async () => ({ ok: true as const })),
    restoreDocument: vi.fn(async () => ({ status: 'restore_requested' as const })),
    overrideSolicitationKey: vi.fn(async () => ({ ok: true as const, amendmentId: 'a', remaining: 1 })),
    setAmendmentNo: vi.fn(async () => ({ ok: true as const, amendmentNo: 3 })),
    ...over,
  };
}

function rowApi(): RowDetailApi {
  return {
    getRow: vi.fn(async (_bid: string, _table: string, id: string) => ({
      row: complianceRowDto({ id, reqId: id === 'row-new' ? 'C.3.2a' : 'C.3.2' }),
      history: [],
    })) as unknown as RowDetailApi['getRow'],
    updateRow: vi.fn(async () => ({ ok: true as const })) as unknown as RowDetailApi['updateRow'],
  };
}

function sourceApi(): SourceApi {
  return {
    getViewToken: vi.fn(async () => ({ token: 'tok', expiresInSeconds: 900 })),
    resolveViewToken: vi.fn(async () => ({ documentId: 'doc-1' })),
    getDocumentPages: vi.fn(async () => ({
      fileName: 'rfp.pdf',
      liveStatus: 'live' as const,
      pagesEstimated: null,
      extractMethod: 'pdf_text' as const,
      pages: [],
    })) as unknown as SourceApi['getDocumentPages'],
    getDocumentFile: vi.fn(async () => new Blob(['%PDF'])),
    restoreDocument: vi.fn(async () => ({ status: 'restore_requested' as const })),
  };
}

function renderContainer(
  opts: { api?: DocumentsApi; shell?: Partial<ShellContextValue>; selectedRowId?: string | null; rowApi?: RowDetailApi; sourceApi?: SourceApi } = {},
) {
  const api = opts.api ?? mockApi();
  const shell = shellValue(opts.shell);
  const src = opts.sourceApi ?? sourceApi();
  const user = userEvent.setup();
  const tree = (value: ShellContextValue, rowId: string | null = opts.selectedRowId ?? null) => (
    <ShellContext.Provider value={value}>
      <DocumentsContainer bidId={value.bidId ?? 'bid-1'} tab="documents" selectedRowId={rowId} api={api} rowApi={opts.rowApi} sourceApi={src} />
    </ShellContext.Provider>
  );
  const view = render(tree(shell));
  const update = (over: Partial<ShellContextValue>, rowId?: string | null) => view.rerender(tree(shellValue({ ...opts.shell, ...over }), rowId));
  const select = (rowId: string | null) => view.rerender(tree(shell, rowId));
  return { api, shell, user, update, select, sourceApi: src, ...view };
}

const pdf = (name = 'a.pdf') => new File(['%PDF-1.4'], name, { type: 'application/pdf' });
const picker = () => screen.getByLabelText('Files to upload');
const rowOf = (name: string) => screen.getByRole('cell', { name }).closest('tr') as HTMLElement;
const numberField = () => screen.getByRole('textbox', { name: 'Amendment number' });
const withHost = () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
};

const amendment = (over: Partial<DocumentDto> = {}) =>
  docDto({ id: 'amd', fileName: 'amd2.pdf', kind: 'amendment', amendmentNo: 2, keyCheck: 'ok', amendmentStatus: 'applied', ...over });

describe('DocumentsContainer: the list', () => {
  it('shows the bid’s files with their live-until date and size', async () => {
    renderContainer();
    const row = rowOf('rfp.pdf');
    expect(within(row).getByText('Nov 3, 2026')).toBeTruthy();
    expect(within(row).getByText('Live')).toBeTruthy();
    expect(within(row).getByText('2.0 MB')).toBeTruthy();
    expect(screen.getByText('2.0 MB of 50 MB used')).toBeTruthy();
  });

  it('shows a skeleton until the bid has loaded', () => {
    renderContainer({ shell: { bidLoaded: false, docs: [] } });
    expect(screen.getByRole('status', { name: 'Loading documents' })).toBeTruthy();
  });

  it('shows the panel’s empty state when there is no file, never a TabFrame block', () => {
    renderContainer({ shell: { docs: [] } });
    expect(screen.getByText('Upload the solicitation to start.')).toBeTruthy();
    expect(screen.queryByText(/Upgrade to unlock/i)).toBeNull();
  });

  it('opens a file in the source viewer at page 1', async () => {
    const { user, sourceApi: src } = renderContainer();
    await user.click(within(rowOf('rfp.pdf')).getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { description: /^Pages? 1/ });
    expect(dialog.closest('.app-shell')).toBeNull();
    expect(src.getViewToken).toHaveBeenCalled();
  });
});

describe('DocumentsContainer: tab states', () => {
  it('shows processing around the panel, with the file’s queue position', () => {
    const doc = docDto({ id: 'doc-1', fileName: 'rfp.pdf' });
    renderContainer({
      shell: { docs: [doc], jobs: [jobDto({ status: 'running', type: 'scan', stage: 'scan', queuePosition: 3, progress: 40 })] },
    });
    expect(screen.getByRole('heading', { name: 'Processing' })).toBeTruthy();
    expect(within(rowOf('rfp.pdf')).getByText('Processing · Queue position 3')).toBeTruthy();
  });

  it('shows a failed file with its reason, and nothing blocks the tab', () => {
    renderContainer({ shell: { docs: [RFP], jobs: [jobDto({ status: 'failed', type: 'scan', stage: 'scan' })] } });
    expect(within(rowOf('rfp.pdf')).getByText('Failed · We could not read this file.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Files on this bid' })).toBeTruthy();
  });

  it('draws the marking prompt once, under its file, and not in the TabFrame waiting slot', () => {
    const blocked = docDto({ id: 'doc-2', fileName: 'blocked.pdf', kind: 'attachment', markingStatus: 'blocked', markingFound: ['CUI'], markingPage: 2 });
    renderContainer({ shell: { docs: [RFP, blocked] } });
    expect(screen.getAllByRole('button', { name: 'Confirm file is public' })).toHaveLength(1);
    expect(screen.getAllByText(/This file carries the marking CUI on page 2/)).toHaveLength(1);
    expect(within(rowOf('blocked.pdf')).getByText('Paused: CUI')).toBeTruthy();
  });

  it('shows the over-cap banner, and the panel’s Upgrade plan opens Upgrade for the cap', async () => {
    const big = docDto({ id: 'doc-1', fileName: 'big.pdf', sizeBytes: 50 * MB });
    const { user, shell } = renderContainer({ shell: { docs: [big] } });
    expect(screen.getByText(/New files cannot be added/)).toBeTruthy();
    const header = screen.getByRole('heading', { name: 'Documents' }).closest('header') as HTMLElement;
    await user.click(within(header).getByRole('button', { name: 'Upgrade plan' }));
    expect(shell.openUpgrade).toHaveBeenCalledWith('over_cap');
  });

  it('shows an upload refused for no credits as an error notice with the API’s message', async () => {
    const message = 'You have no RFP credits left. They reset on Nov 1.';
    const { user } = renderContainer({ api: mockApi({ uploadFile: vi.fn(async () => Promise.reject(new ApiError(message, 402, 'out_of_credits'))) }) });
    await user.upload(picker(), pdf('rfp2.pdf'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('rfp2.pdf:');
    expect(alert.textContent).toContain(message);
  });

  it('is never locked on the Free plan', () => {
    renderContainer({ shell: { docs: [RFP] } });
    expect(screen.queryByText(/locked|Upgrade to/i)).toBeNull();
  });
});

describe('DocumentsContainer: upload', () => {
  it('uploads a file as the chosen kind, with no amendment number, then reloads the shell', async () => {
    const { api, user, shell } = renderContainer();
    const file = pdf();
    await user.upload(picker(), file);
    await waitFor(() => expect(shell.refresh).toHaveBeenCalled());
    expect(api.uploadFile).toHaveBeenCalledTimes(1);
    const [bidId, sent, kind, options] = vi.mocked(api.uploadFile).mock.calls[0];
    expect([bidId, sent, kind]).toEqual(['bid-1', file, 'attachment']);
    expect(options).not.toHaveProperty('amendmentNo');
  });

  it('uploads Add amendment files with the typed amendment number', async () => {
    const { api, user } = renderContainer();
    await user.type(numberField(), '3');
    await user.click(screen.getByRole('button', { name: 'Add amendment' }));
    await user.upload(picker(), pdf('amd3.pdf'));
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1));
    const [, , kind, options] = vi.mocked(api.uploadFile).mock.calls[0];
    expect(kind).toBe('amendment');
    expect(options).toMatchObject({ amendmentNo: 3 });
  });

  it('uploads an amendment with no number when none is typed', async () => {
    const { api, user } = renderContainer();
    await user.click(screen.getByRole('button', { name: 'Add amendment' }));
    await user.upload(picker(), pdf('amd.pdf'));
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1));
    const [, , kind, options] = vi.mocked(api.uploadFile).mock.calls[0];
    expect(kind).toBe('amendment');
    expect(options).not.toHaveProperty('amendmentNo');
  });

  it('refuses a number outside 1 to 999 before any request, with a notice for the file', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const api = mockApi({ uploadFile: realApi.uploadFile });
    const { user } = renderContainer({ api });
    await user.type(numberField(), '0');
    expect(screen.getByText('Use a number from 1 to 999.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add amendment' }));
    await user.upload(picker(), pdf('amd0.pdf'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('amd0.pdf:');
    expect(alert.textContent).toContain('Amendment number must be 1 to 999');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('uploads several files one at a time, with the percent of the file in flight', async () => {
    let finishFirst: () => void = () => undefined;
    const uploadFile = vi
      .fn()
      .mockImplementationOnce(
        (_bid: string, _file: File, _kind: string, options: { onProgress?: (p: { chunksSent: number; chunkCount: number }) => void }) =>
          new Promise((resolve) => {
            options.onProgress?.({ chunksSent: 1, chunkCount: 2 });
            finishFirst = () => resolve({ duplicate: false, sessionId: 's', documentId: 'd', jobId: 'j' });
          }),
      )
      .mockResolvedValue({ duplicate: false, sessionId: 's', documentId: 'd', jobId: 'j' });
    const { user, shell } = renderContainer({ api: mockApi({ uploadFile: uploadFile as unknown as DocumentsApi['uploadFile'] }) });
    await user.upload(picker(), [pdf('one.pdf'), pdf('two.pdf')]);
    const bar = await screen.findByRole('progressbar', { name: 'Upload progress for one.pdf' });
    expect(screen.getByText('50%')).toBeTruthy();
    expect(bar).toBeTruthy();
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(shell.refresh).not.toHaveBeenCalled();
    await act(async () => finishFirst());
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(shell.refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('progressbar', { name: /Upload progress/ })).toBeNull();
  });

  it('shows the duplicate line as info and a refusal as given, and a taken number in its own words', async () => {
    const uploadFile = vi
      .fn()
      .mockResolvedValueOnce({ duplicate: true })
      .mockRejectedValueOnce(new ApiError('This file belongs to a different solicitation. Start a new bid.', 409, 'key_mismatch'))
      .mockRejectedValueOnce(new ApiError('Number taken', 409, 'amendment_no_taken'));
    const { user } = renderContainer({ api: mockApi({ uploadFile: uploadFile as unknown as DocumentsApi['uploadFile'] }) });
    await user.upload(picker(), [pdf('dup.pdf'), pdf('wrong.pdf'), pdf('taken.pdf')]);
    expect(await screen.findByText('Already uploaded.')).toBeTruthy();
    expect(await screen.findByText('This file belongs to a different solicitation. Start a new bid.')).toBeTruthy();
    expect(await screen.findByText('Another amendment on this bid already has that number.')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(3);
  });

  it('never calls upload with an empty list (a real change event with an empty FileList)', () => {
    const { api } = renderContainer();
    fireEvent.change(picker(), { target: { files: [] } });
    expect(api.uploadFile).not.toHaveBeenCalled();
  });

  it('sends the typed amendment number with the first file only', async () => {
    const { api, user } = renderContainer();
    await user.type(numberField(), '3');
    await user.click(screen.getByRole('button', { name: 'Add amendment' }));
    await user.upload(picker(), [pdf('a1.pdf'), pdf('a2.pdf')]);
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(api.uploadFile).mock.calls;
    expect(calls[0][3]).toMatchObject({ amendmentNo: 3 });
    expect(calls[1][3]).not.toHaveProperty('amendmentNo');
  });

  it('does not move the number on to the second file when the first is refused', async () => {
    const uploadFile = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Amendment number must be 1 to 999', 400))
      .mockResolvedValue({ duplicate: false, sessionId: 's', documentId: 'd', jobId: 'j' });
    const { user } = renderContainer({ api: mockApi({ uploadFile: uploadFile as unknown as DocumentsApi['uploadFile'] }) });
    await user.type(numberField(), '0');
    await user.click(screen.getByRole('button', { name: 'Add amendment' }));
    await user.upload(picker(), [pdf('a1.pdf'), pdf('a2.pdf')]);
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    expect(uploadFile.mock.calls[0][3]).toMatchObject({ amendmentNo: 0 });
    expect(uploadFile.mock.calls[1][3]).not.toHaveProperty('amendmentNo');
  });

  it('keeps uploading after the tab unmounts, and reports each outcome by toast', async () => {
    let finishFirst: () => void = () => undefined;
    const uploadFile = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = () => resolve({ duplicate: true }); }))
      .mockRejectedValueOnce(new ApiError('Upload an unlocked copy.', 422));
    const { user, unmount, shell } = renderContainer({
      api: mockApi({ uploadFile: uploadFile as unknown as DocumentsApi['uploadFile'] }),
      shell: { bid: bidDto({ name: 'Alpha bid', keyOverridesLeft: 2 }) },
    });
    await user.upload(picker(), [pdf('one.pdf'), pdf('two.pdf')]);
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => finishFirst());
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    expect(uploadFile.mock.calls[0][3]).not.toHaveProperty('signal');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Alpha bid')));
    expect(toast.error).toHaveBeenCalledWith('one.pdf: Already uploaded.');
    expect(toast.error).toHaveBeenCalledWith('two.pdf: Upload an unlocked copy.');
    expect(shell.refresh).toHaveBeenCalled();
  });

  it('toasts instead of adding a notice when another bid is shown', async () => {
    let finish: () => void = () => undefined;
    const uploadFile = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ duplicate: true }); }));
    const { user, update } = renderContainer({ api: mockApi({ uploadFile: uploadFile as unknown as DocumentsApi['uploadFile'] }) });
    await user.upload(picker(), pdf('one.pdf'));
    update({ bidId: 'bid-2', bid: bidDto({ id: 'bid-2' }), docs: [] });
    await act(async () => finish());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('one.pdf: Already uploaded.'));
    expect(screen.queryByText('Already uploaded.')).toBeNull();
  });
});

describe('DocumentsContainer: notices', () => {
  it('shows the notices the new-bid screen stashed, once', async () => {
    stashUploadNotices('bid-1', [{ id: 'n1', fileName: 'wrong.pdf', tone: 'error', message: 'Upload an unlocked copy.' }]);
    const first = renderContainer();
    expect(await screen.findByText('Upload an unlocked copy.')).toBeTruthy();
    first.unmount();
    renderContainer();
    expect(screen.queryByText('Upload an unlocked copy.')).toBeNull();
  });

  it('dismisses a notice', async () => {
    const { user } = renderContainer({ api: mockApi({ uploadFile: vi.fn(async () => ({ duplicate: true as const })) }) });
    await user.upload(picker(), pdf('dup.pdf'));
    await screen.findByText('Already uploaded.');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Already uploaded.')).toBeNull();
  });
});

describe('DocumentsContainer: notices per bid', () => {
  it('keeps each bid’s stashed notices and dismissals apart', async () => {
    stashUploadNotices('bid-1', [{ id: 'n1', fileName: 'a.pdf', tone: 'error', message: 'Notice for one.' }]);
    stashUploadNotices('bid-2', [{ id: 'n2', fileName: 'b.pdf', tone: 'error', message: 'Notice for two.' }]);
    const { user, update } = renderContainer();
    expect(await screen.findByText('Notice for one.')).toBeTruthy();
    const two = { bidId: 'bid-2', bid: bidDto({ id: 'bid-2' }), docs: [] };
    const one = { bidId: 'bid-1', bid: bidDto(), docs: [RFP] };
    update(two);
    expect(await screen.findByText('Notice for two.')).toBeTruthy();
    expect(screen.queryByText('Notice for one.')).toBeNull();
    update(one);
    expect(screen.getByText('Notice for one.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    update(two);
    expect(screen.getByText('Notice for two.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    update(one);
    expect(screen.queryByText('Notice for one.')).toBeNull();
    update(two);
    expect(screen.queryByText('Notice for two.')).toBeNull();
  });
});

describe('DocumentsContainer: amendment tabs status', () => {
  it('shows no tabs notice for a deleted amendment', () => {
    renderContainer({ shell: { docs: [RFP, amendment({ amendmentTabsStatus: 'failed', liveStatus: 'deleted' })] } });
    expect(screen.queryByText(/did not update from this amendment/)).toBeNull();
  });

  const noticeFor = (status: DocumentDto['amendmentTabsStatus']) => [RFP, amendment({ amendmentTabsStatus: status })];

  it('shows pending as an info notice, and the file’s status stays Live', () => {
    renderContainer({ shell: { docs: noticeFor('pending') } });
    const alert = screen.getByText('Updating bid facts and dates from this amendment.').closest('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('amd2.pdf:');
    expect(alert.className).not.toMatch(/destructive/);
    expect(within(rowOf('amd2.pdf')).getByText('Live')).toBeTruthy();
    expect(within(rowOf('amd2.pdf')).getByRole('button', { name: 'Open' })).toBeTruthy();
  });

  it('shows failed as an error notice that points to Overview Retry', () => {
    renderContainer({ shell: { docs: noticeFor('failed') } });
    const alert = screen.getByText('Bid facts and dates did not update from this amendment. Open Overview and choose Retry.').closest('[role="alert"]') as HTMLElement;
    expect(alert.className).toMatch(/destructive/);
    expect(within(rowOf('amd2.pdf')).getByText('Live')).toBeTruthy();
  });

  it('shows nothing when applied or unset', () => {
    const view = renderContainer({ shell: { docs: noticeFor('applied') } });
    expect(screen.queryByText(/Updating bid facts|did not update/)).toBeNull();
    view.update({ docs: noticeFor(null) });
    expect(screen.queryByText(/Updating bid facts|did not update/)).toBeNull();
  });

  it('keeps a dismissed notice hidden until that file’s status changes', async () => {
    const { user, update } = renderContainer({ shell: { docs: noticeFor('pending') } });
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Updating bid facts and dates from this amendment.')).toBeNull();
    update({ docs: noticeFor('pending') });
    expect(screen.queryByText('Updating bid facts and dates from this amendment.')).toBeNull();
    update({ docs: noticeFor('failed') });
    expect(screen.getByText(/did not update from this amendment/)).toBeTruthy();
  });
});

describe('DocumentsContainer: the amendment number', () => {
  it('shows an assumed number and saves a new one for that file', async () => {
    const { api, user, shell } = renderContainer({
      shell: { docs: [RFP, amendment({ amendmentNoSource: 'sequence' })] },
    });
    const row = rowOf('amd2.pdf');
    expect(within(row).getByText('Amd 2 (assumed)')).toBeTruthy();
    const field = within(row).getByRole('textbox', { name: 'Amendment number for amd2.pdf' });
    await user.clear(field);
    await user.type(field, '4');
    await user.click(within(row).getByRole('button', { name: 'Save number' }));
    expect(api.setAmendmentNo).toHaveBeenCalledWith('amd', 4);
    await waitFor(() => expect(shell.refresh).toHaveBeenCalled());
  });

  it('says what the file reads when it differs', () => {
    renderContainer({ shell: { docs: [RFP, amendment({ amendmentNoFound: 3 })] } });
    expect(within(rowOf('amd2.pdf')).getByText('The file reads Amendment 3')).toBeTruthy();
  });

  it('asks for a number when the amendment needs one, and sends it for that file only', async () => {
    const { api, user } = renderContainer({
      shell: { docs: [RFP, amendment({ amendmentNo: null, amendmentStatus: 'needs_number' }), amendment({ id: 'amd-b', fileName: 'amd-b.pdf', amendmentNo: 5 })] },
    });
    expect(screen.getByText(/Set the amendment number\. The number in this file is already used on this bid, or the file names two numbers\./)).toBeTruthy();
    const set = screen.getByRole('button', { name: 'Set number' });
    expect(set).toHaveProperty('disabled', true);
    await user.type(screen.getByRole('textbox', { name: 'Amendment number for amd2.pdf' }), '7');
    await user.click(set);
    expect(api.setAmendmentNo).toHaveBeenCalledTimes(1);
    expect(api.setAmendmentNo).toHaveBeenCalledWith('amd', 7);
  });

  it('shows the API’s message when the number is refused, and reloads', async () => {
    const api = mockApi({ setAmendmentNo: vi.fn(async () => Promise.reject(new ApiError('Another amendment on this bid already has that number.', 409, 'amendment_no_taken'))) });
    const { user, shell } = renderContainer({ api, shell: { docs: [RFP, amendment({ amendmentNoSource: 'sequence' })] } });
    const row = rowOf('amd2.pdf');
    await user.click(within(row).getByRole('button', { name: 'Save number' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Another amendment on this bid already has that number.'));
    expect(shell.refresh).toHaveBeenCalled();
  });
});

describe('DocumentsContainer: marking', () => {
  const blocked = docDto({ id: 'doc-2', fileName: 'blocked.pdf', kind: 'attachment', markingStatus: 'blocked', markingFound: ['CUI'], markingPage: 2 });

  it('confirms a marked file and reloads', async () => {
    const { api, user, shell } = renderContainer({ shell: { docs: [RFP, blocked] } });
    await user.click(screen.getByRole('button', { name: 'Confirm file is public' }));
    expect(api.confirmMarking).toHaveBeenCalledWith('doc-2');
    await waitFor(() => expect(shell.refresh).toHaveBeenCalled());
  });

  it('removes a marked file only after the delete confirmation', async () => {
    const { api, user } = renderContainer({ shell: { docs: [RFP, blocked] } });
    await user.click(screen.getByRole('button', { name: 'Remove file' }));
    expect(api.deleteDocument).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Delete file' }));
    expect(api.deleteDocument).toHaveBeenCalledWith('doc-2');
  });

  it('shows a refusal as given', async () => {
    const api = mockApi({ confirmMarking: vi.fn(async () => Promise.reject(new ApiError('Not allowed.', 403))) });
    const { user } = renderContainer({ api, shell: { docs: [RFP, blocked] } });
    await user.click(screen.getByRole('button', { name: 'Confirm file is public' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not allowed.'));
  });

  it('shows a confirmed file as confirmed public', () => {
    renderContainer({ shell: { docs: [RFP, docDto({ id: 'doc-3', fileName: 'ok.pdf', kind: 'attachment', markingStatus: 'confirmed', markingFound: ['CUI'] })] } });
    expect(within(rowOf('ok.pdf')).getByText('Confirmed public')).toBeTruthy();
  });
});

describe('DocumentsContainer: key check and override', () => {
  const mismatch = amendment({ keyCheck: 'mismatch', keyReason: 'mismatch' });

  it('lets the owner override with a reason', async () => {
    const { api, user, shell } = renderContainer({ shell: { docs: [RFP, mismatch] } });
    expect(screen.getByText('The solicitation number on this amendment does not match the bid.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Override' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('2 overrides left on this bid')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Accept amendment' })).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Agency left the number off.');
    await user.click(within(dialog).getByRole('button', { name: 'Accept amendment' }));
    expect(api.overrideSolicitationKey).toHaveBeenCalledWith('amd', 'Agency left the number off.');
    await waitFor(() => expect(shell.refresh).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Override recorded.');
  });

  it('tells a member to ask the owner, with no Override button', () => {
    renderContainer({ shell: { docs: [RFP, mismatch], org: orgPayload({ org: organizationDto({ plan: 'free' }), role: 'member' }) } });
    expect(screen.getByText('Ask the bid owner to override.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Override' })).toBeNull();
  });

  it('with 0 overrides left, says so and cannot accept', async () => {
    const { api, user } = renderContainer({ shell: { docs: [RFP, mismatch], bid: bidDto({ keyOverridesLeft: 0 }) } });
    await user.click(screen.getByRole('button', { name: 'Override' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('No overrides left. Start a new bid for this file.')).toBeTruthy();
    expect(within(dialog).queryByRole('textbox', { name: 'Reason' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Accept amendment' })).toHaveProperty('disabled', true);
    expect(api.overrideSolicitationKey).not.toHaveBeenCalled();
  });

  it('shows the API’s message for override_limit', async () => {
    const api = mockApi({ overrideSolicitationKey: vi.fn(async () => Promise.reject(new ApiError('No overrides left on this bid.', 409, 'override_limit'))) });
    const { user } = renderContainer({ api, shell: { docs: [RFP, mismatch] } });
    await user.click(screen.getByRole('button', { name: 'Override' }));
    await user.type(await screen.findByRole('textbox', { name: 'Reason' }), 'Because.');
    await user.click(screen.getByRole('button', { name: 'Accept amendment' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No overrides left on this bid.'));
  });

  it('offers Bid settings when the bid has no solicitation number yet (set_bid_number_first)', async () => {
    const message = 'This bid has no solicitation number yet. Set it in Bid settings instead of overriding.';
    const api = mockApi({ overrideSolicitationKey: vi.fn(async () => Promise.reject(new ApiError(message, 409, 'set_bid_number_first'))) });
    const { user } = renderContainer({ api, shell: { docs: [RFP, mismatch] } });
    await user.click(screen.getByRole('button', { name: 'Override' }));
    await user.type(await screen.findByRole('textbox', { name: 'Reason' }), 'Because.');
    await user.click(screen.getByRole('button', { name: 'Accept amendment' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [shown, options] = vi.mocked(toast.error).mock.calls[0] as unknown as [string, { action: { label: string; onClick: () => void } }];
    expect(shown).toBe(message);
    expect(options.action.label).toBe('Open Bid settings');
    options.action.onClick();
    expect(window.location.hash).toBe('#/bids/bid-1/settings');
  });

  it('shows an overridden amendment as accepted by override', () => {
    renderContainer({ shell: { docs: [RFP, amendment({ keyCheck: 'overridden' })] } });
    expect(within(rowOf('amd2.pdf')).getByText('Accepted by override')).toBeTruthy();
  });
});

describe('DocumentsContainer: delete', () => {
  it('deletes only after the confirmation', async () => {
    const { api, user, shell } = renderContainer();
    await user.click(within(rowOf('rfp.pdf')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete rfp.pdf?')).toBeTruthy();
    expect(within(dialog).getByText('The rows and quotes this file produced stay. Its MB is freed.')).toBeTruthy();
    expect(api.deleteDocument).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete file' }));
    expect(api.deleteDocument).toHaveBeenCalledWith('doc-1');
    await waitFor(() => expect(shell.refresh).toHaveBeenCalled());
  });

  it('does nothing on Cancel', async () => {
    const { api, user } = renderContainer();
    await user.click(within(rowOf('rfp.pdf')).getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(api.deleteDocument).not.toHaveBeenCalled();
  });

  it('shows the API’s message when the delete fails, and reloads', async () => {
    const api = mockApi({ deleteDocument: vi.fn(async () => Promise.reject(new ApiError('Could not delete.', 500))) });
    const { user, shell } = renderContainer({ api });
    await user.click(within(rowOf('rfp.pdf')).getByRole('button', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete file' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not delete.'));
    expect(shell.refresh).toHaveBeenCalled();
  });

  it('shows a deleted resume as "Deleted after 90 days", with no actions', () => {
    renderContainer({ shell: { docs: [RFP, docDto({ id: 'doc-r', fileName: 'dana.pdf', kind: 'resume', liveStatus: 'deleted', liveUntil: null })] } });
    const row = rowOf('dana.pdf');
    expect(within(row).getByText('Deleted after 90 days')).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
  });
});

describe('DocumentsContainer: restore', () => {
  const archived = docDto({ id: 'doc-a', fileName: 'old.pdf', kind: 'attachment', liveStatus: 'archived' });

  it('requests a restore and reloads', async () => {
    const { api, user, shell } = renderContainer({ shell: { docs: [RFP, archived] } });
    await user.click(within(rowOf('old.pdf')).getByRole('button', { name: 'Restore' }));
    expect(api.restoreDocument).toHaveBeenCalledWith('doc-a');
    await waitFor(() => expect(shell.refresh).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Restore requested.');
  });

  it('opens Upgrade for a restore that needs a plan (402)', async () => {
    const api = mockApi({ restoreDocument: vi.fn(async () => Promise.reject(new ApiError('Restores are on a paid plan.', 402, 'plan_required'))) });
    const { user, shell } = renderContainer({ api, shell: { docs: [RFP, archived] } });
    await user.click(within(rowOf('old.pdf')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(shell.openUpgrade).toHaveBeenCalledWith('plan'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows any other refusal as given', async () => {
    const api = mockApi({ restoreDocument: vi.fn(async () => Promise.reject(new ApiError('No archive copy is left to restore from.', 409, 'no_archive_copy'))) });
    const { user } = renderContainer({ api, shell: { docs: [RFP, archived] } });
    await user.click(within(rowOf('old.pdf')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No archive copy is left to restore from.'));
  });

  it('shows the restore states and the restored-until date', () => {
    renderContainer({
      shell: {
        docs: [
          RFP,
          docDto({ id: 'r1', fileName: 'asked.pdf', kind: 'attachment', liveStatus: 'restore_requested' }),
          docDto({ id: 'r2', fileName: 'busy.pdf', kind: 'attachment', liveStatus: 'restoring' }),
          docDto({ id: 'r3', fileName: 'back.pdf', kind: 'attachment', liveStatus: 'restored', restoredUntil: '2026-11-20T00:00:00.000Z' }),
        ],
      },
    });
    expect(within(rowOf('asked.pdf')).getByText('Restore requested')).toBeTruthy();
    expect(within(rowOf('busy.pdf')).getByText('Restoring (a short wait)')).toBeTruthy();
    expect(within(rowOf('back.pdf')).getByText('Restored until Nov 20, 2026')).toBeTruthy();
    expect(within(rowOf('back.pdf')).getByRole('button', { name: 'Open' })).toBeTruthy();
  });
});

describe('DocumentsContainer: row detail', () => {
  const links = [linkDto()];
  const sourceButtons = () => screen.getAllByRole('button', { name: /^Open source for C\.3\.2, page/ });

  it('renders the row detail in the shell’s host and closes through the shell', async () => {
    const host = withHost();
    const rows = rowApi();
    const { user, shell } = renderContainer({ selectedRowId: 'row-new', rowApi: rows, shell: { detailHost: host } });
    const heading = await within(host).findByRole('heading', { name: 'C.3.2a', level: 2 });
    expect(heading.closest('.app-shell')).toBeNull();
    expect(rows.getRow).toHaveBeenCalledWith('bid-1', 'compliance_rows', 'row-new', expect.anything());
    await user.click(within(host).getByRole('button', { name: 'Close row detail' }));
    expect(shell.openRow).toHaveBeenCalledWith(null);
    host.remove();
  });

  it('draws no slider without a selected row', () => {
    const host = withHost();
    const rows = rowApi();
    renderContainer({ rowApi: rows, shell: { detailHost: host } });
    expect(rows.getRow).not.toHaveBeenCalled();
    expect(host.childElementCount).toBe(0);
    host.remove();
  });

  it('opens a row from a card’s source button, and returns focus to that row’s button by id when the opener is gone', async () => {
    const host = withHost();
    const { user, shell, select } = renderContainer({ rowApi: rowApi(), shell: { detailHost: host, links } });
    // Two rows share the label C.3.2: the old row (page 12) and the new row (page 3).
    const [oldButton, newButton] = sourceButtons();
    expect(oldButton.getAttribute('aria-label')).toContain('page 12');
    expect(newButton.getAttribute('aria-label')).toContain('page 3');
    await user.click(oldButton);
    expect(shell.openRow).toHaveBeenCalledWith('row-old');
    // The slider opens on the new row with nothing focused (the opener is not the new row's): focus goes to its button.
    (document.activeElement as HTMLElement | null)?.blur();
    select('row-new');
    await within(host).findByRole('heading', { name: 'C.3.2a', level: 2 });
    await user.click(within(host).getByRole('button', { name: 'Close row detail' }));
    expect(document.activeElement).toBe(sourceButtons()[1]);
    host.remove();
  });
});

describe('DocumentsContainer: the amendment links', () => {
  it('keeps the amendment cards in the waiting slot', () => {
    renderContainer({ shell: { links: [linkDto()] } });
    expect(screen.getByRole('heading', { name: 'Confirm amendment changes' })).toBeTruthy();
  });
});

describe('DocumentsContainer: bids', () => {
  it('keeps notices and progress with the bid they belong to', async () => {
    const { user, update } = renderContainer({ api: mockApi({ uploadFile: vi.fn(async () => ({ duplicate: true as const })) }) });
    await user.upload(picker(), pdf('dup.pdf'));
    await screen.findByText('Already uploaded.');
    update({ bidId: 'bid-2', bid: bidDto({ id: 'bid-2' }), docs: [] });
    expect(screen.queryByText('Already uploaded.')).toBeNull();
    update({ bidId: 'bid-1' });
    expect(screen.getByText('Already uploaded.')).toBeTruthy();
  });
});

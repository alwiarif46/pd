// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ApiError, type ComplianceRowDto, type RowDetailDto } from '@/api';
import { bidDto, complianceRowDto, docDto, meDto, orgPayload, rowHistoryDto } from '@/test/fixtures';
import { ShellContext, type ShellContextValue } from '@/features/shell/bid-context';
import type { DetailTable, RowDetailApi } from './controller';
import { RowDetailContainer, type RowDetailContainerProps } from './RowDetailContainer';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  host.setAttribute('data-testid', 'detail-host');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
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
    selectedRowId: 'req-1',
    detailHost: host,
    refresh: vi.fn(),
    openRow: vi.fn(),
    openUpgrade: vi.fn(),
    confirm: vi.fn(async () => true),
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const payload = (over: Partial<ComplianceRowDto> = {}): RowDetailDto<'compliance_rows'> => ({
  row: complianceRowDto(over),
  history: [rowHistoryDto()],
});

function mockApi(over: Partial<RowDetailApi> = {}): RowDetailApi {
  return {
    getRow: vi.fn(async (_bid: string, _table: DetailTable, rowId: string) => payload({ id: rowId, reqId: rowId.toUpperCase() })) as RowDetailApi['getRow'],
    updateRow: vi.fn(async () => ({ ok: true as const })) as RowDetailApi['updateRow'],
    ...over,
  };
}

type Props = RowDetailContainerProps<'compliance_rows'>;

function renderContainer(opts: { api?: RowDetailApi; props?: Partial<Props>; shell?: Partial<ShellContextValue> } = {}) {
  const api = opts.api ?? mockApi();
  const callbacks = { onOpenSource: vi.fn(), onSaved: vi.fn(), onJumpToRow: vi.fn(), onClose: vi.fn() };
  const tree = (props: Partial<Props>, shell: Partial<ShellContextValue> = opts.shell ?? {}) => (
    <ShellContext.Provider value={shellValue(shell)}>
      <RowDetailContainer
        bidId="bid-1"
        table="compliance_rows"
        rowId="req-1"
        federal
        docs={[docDto({ id: 'doc-1', fileName: 'rfp.pdf' })]}
        rowIds={new Set(['req-1', 'req-2'])}
        api={api}
        {...callbacks}
        {...opts.props}
        {...props}
      />
    </ShellContext.Provider>
  );
  const view = render(tree({}));
  const update = (props: Partial<Props>) => view.rerender(tree(props));
  return { api, ...callbacks, update, user: userEvent.setup(), ...view };
}

const titled = (name: string) => screen.findByRole('heading', { name, level: 2 });

describe('RowDetailContainer', () => {
  it('shows the skeleton while loading, then the row in the shell host, outside .app-shell', async () => {
    const load = deferred<RowDetailDto<'compliance_rows'>>();
    const api = mockApi({ getRow: vi.fn(() => load.promise) as RowDetailApi['getRow'] });
    renderContainer({ api });
    expect(within(host).getByRole('heading', { name: 'Loading row detail' })).toBeTruthy();
    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy();
    load.resolve(payload({ reqId: 'L.4.2' }));
    await titled('L.4.2');
    expect(api.getRow).toHaveBeenCalledWith('bid-1', 'compliance_rows', 'req-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const panel = within(host);
    expect(panel.getByText('The offeror shall describe its staffing approach.')).toBeTruthy();
    expect(panel.getByText('rfp.pdf')).toBeTruthy();
    expect(panel.getByText('L ref')).toBeTruthy();
    expect(panel.getByText('M factor')).toBeTruthy();
    expect(panel.getByText('92%')).toBeTruthy();
    expect(panel.getByText('Open')).toBeTruthy();
    expect(host.closest('.app-shell')).toBeNull();
  });

  it('renders nothing without a shell host', async () => {
    const { api } = renderContainer({ shell: { detailHost: null } });
    await waitFor(() => expect(api.getRow).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('shows the edit history', async () => {
    renderContainer();
    await titled('REQ-1');
    const entry = within(host).getByText(/changed Owner from empty to Dana/);
    expect(within(entry).getByText('Dana Reyes')).toBeTruthy();
  });

  it('saves only the changed fields, says Saved, reloads the row and tells the tab', async () => {
    const { api, onSaved, user } = renderContainer();
    await titled('REQ-1');
    await user.click(within(host).getByRole('button', { name: 'Edit' }));
    await user.type(within(host).getByLabelText('Owner'), 'Sam');
    await user.click(within(host).getByRole('button', { name: 'Save changes' }));
    expect(api.updateRow).toHaveBeenCalledTimes(1);
    expect(api.updateRow).toHaveBeenCalledWith('bid-1', 'compliance_rows', 'req-1', { owner: 'Sam' });
    expect(await within(host).findByText('Saved.')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.getRow).toHaveBeenCalledTimes(2));
    expect(within(host).queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('keeps the form with the message on a save error (409), and allows a retry', async () => {
    const api = mockApi({
      updateRow: vi.fn().mockRejectedValueOnce(new ApiError('Someone changed this row. Reload it.', 409, 'conflict')).mockResolvedValue({ ok: true }) as RowDetailApi['updateRow'],
    });
    const { onSaved, user } = renderContainer({ api });
    await titled('REQ-1');
    await user.click(within(host).getByRole('button', { name: 'Edit' }));
    await user.type(within(host).getByLabelText('Response section'), '3.1');
    await user.click(within(host).getByRole('button', { name: 'Save changes' }));
    expect((await within(host).findByRole('alert')).textContent).toBe('Someone changed this row. Reload it.');
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.getRow).toHaveBeenCalledTimes(1);
    await user.click(within(host).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.updateRow).toHaveBeenLastCalledWith('bid-1', 'compliance_rows', 'req-1', { responseSection: '3.1' });
  });

  it('jumps to the replacing row', async () => {
    const api = mockApi({
      getRow: vi.fn(async () => payload({ supersedeStatus: 'superseded', changedByAmendment: 2, supersededByRowId: 'req-2' })) as RowDetailApi['getRow'],
    });
    const { onJumpToRow, user } = renderContainer({ api });
    await user.click(await within(host).findByRole('button', { name: 'Superseded by Amd 2' }));
    expect(onJumpToRow).toHaveBeenCalledWith('req-2');
  });

  it('closes on Esc and on Close', async () => {
    const { onClose, user } = renderContainer();
    const heading = await titled('REQ-1');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    fireEvent.keyDown(heading, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(within(host).getByRole('button', { name: 'Close' }));
    await user.click(within(host).getByRole('button', { name: 'Close row detail' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('opens the source, and says when the row has no document', async () => {
    const api = mockApi({
      getRow: vi
        .fn()
        .mockResolvedValueOnce(payload({ sourcePageEnd: 13 }))
        .mockResolvedValueOnce(payload({ id: 'req-2', reqId: 'REQ-2', documentId: null })) as RowDetailApi['getRow'],
    });
    const { onOpenSource, update, user } = renderContainer({ api });
    await titled('L.4.2');
    await user.click(within(host).getByRole('button', { name: 'Open source' }));
    expect(onOpenSource).toHaveBeenCalledWith({
      documentId: 'doc-1',
      page: 12,
      pageEnd: 13,
      quote: 'The offeror shall describe its staffing approach.',
    });
    update({ rowId: 'req-2' });
    await titled('REQ-2');
    await user.click(within(host).getByRole('button', { name: 'Open source' }));
    expect(toast.info).toHaveBeenCalledWith('No source page for this row.');
    expect(onOpenSource).toHaveBeenCalledTimes(1);
  });

  it('drops a late answer for a row no longer selected', async () => {
    const first = deferred<RowDetailDto<'compliance_rows'>>();
    const getRow = vi.fn((_bid: string, _table: DetailTable, rowId: string) =>
      rowId === 'req-1' ? first.promise : Promise.resolve(payload({ id: 'req-2', reqId: 'REQ-2' })),
    );
    const { update } = renderContainer({ api: mockApi({ getRow: getRow as RowDetailApi['getRow'] }) });
    const signal = (getRow.mock.calls[0] as unknown as [string, string, string, { signal: AbortSignal }])[3].signal;
    update({ rowId: 'req-2' });
    expect(signal.aborted).toBe(true);
    await titled('REQ-2');
    first.resolve(payload({ reqId: 'STALE' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('heading', { name: 'STALE' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'REQ-2', level: 2 })).toBeTruthy();
  });

  it('drops a late answer and a save status from the bid the shell switched away from', async () => {
    const save = deferred<{ ok: true }>();
    const loads = new Map<string, ReturnType<typeof deferred<RowDetailDto<'compliance_rows'>>>>();
    const getRow = vi.fn((bidId: string) => {
      const d = deferred<RowDetailDto<'compliance_rows'>>();
      loads.set(bidId, d);
      return d.promise;
    });
    const api = mockApi({ getRow: getRow as RowDetailApi['getRow'], updateRow: vi.fn(() => save.promise) as RowDetailApi['updateRow'] });
    const { onSaved, update, user } = renderContainer({ api });
    loads.get('bid-1')!.resolve(payload({ reqId: 'BID-1 ROW' }));
    await titled('BID-1 ROW');
    await user.click(within(host).getByRole('button', { name: 'Edit' }));
    await user.type(within(host).getByLabelText('Owner'), 'Sam');
    await user.click(within(host).getByRole('button', { name: 'Save changes' }));
    // The same row id on another bid: nothing of bid-1 may show there.
    update({ bidId: 'bid-2' });
    expect(within(host).getByRole('heading', { name: 'Loading row detail' })).toBeTruthy();
    loads.get('bid-2')!.resolve(payload({ reqId: 'BID-2 ROW' }));
    await titled('BID-2 ROW');
    save.resolve({ ok: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(within(host).queryByText('Saved.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'BID-2 ROW', level: 2 })).toBeTruthy();
  });

  it('closes with the message when the row cannot be loaded', async () => {
    const api = mockApi({ getRow: vi.fn(async () => Promise.reject(new ApiError('Row not found.', 404))) as RowDetailApi['getRow'] });
    const { onClose } = renderContainer({ api });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('Row not found.');
  });
});

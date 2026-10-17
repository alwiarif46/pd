// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ApiError, type CheckTheseDto, type ComplianceRowDto } from '@/api';
import { bidDto, complianceRowDto, docDto, jobDto, linkDto, meDto, orgPayload, organizationDto } from '@/test/fixtures';
import { ShellContext, type ShellContextValue } from '@/features/shell/bid-context';
import type { RowDetailApi } from '@/features/row-detail/controller';
import type { SourceApi } from '@/features/source-viewer/controller';
import type { ComplianceApi } from './controller';
import { ComplianceContainer, type ComplianceExporter } from './ComplianceContainer';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

beforeEach(() => {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:pdf'), revokeObjectURL: vi.fn() });
});

const r1 = complianceRowDto({ id: 'req-1', reqId: 'L.4.2', requirementText: 'Describe staffing.', sectionRef: 'Section L.4.2', instrRef: 'L.4.2' });
const r2 = complianceRowDto({
  id: 'req-2',
  reqId: 'L.4.3',
  requirementText: 'Submit pricing.',
  sectionRef: 'Section L.4.3',
  instrRef: 'L.4.3',
  reqType: 'must',
  status: 'assigned',
  owner: 'Sam',
  flags: ['ocr'],
  sourcePage: 13,
  sourcePageEnd: 14,
});
const r3 = complianceRowDto({
  id: 'req-3',
  reqId: 'C.1',
  requirementText: 'Old hours.',
  sectionRef: 'Section C',
  instrRef: null,
  supersedeStatus: 'superseded',
  changedByAmendment: 2,
  supersededByRowId: 'req-4',
});
const r4 = complianceRowDto({ id: 'req-4', reqId: 'C.1a', requirementText: 'New hours.', sectionRef: 'Section C', instrRef: null, amendmentNo: 2 });
const r5 = complianceRowDto({
  id: 'req-5',
  reqId: 'U-1',
  requirementText: 'Hand added.',
  sectionRef: null,
  instrRef: null,
  origin: 'user',
  documentId: null,
  sourcePage: null,
  sourceQuote: null,
});
const ROWS = [r1, r2, r3, r4, r5];
const CHECK: CheckTheseDto[] = [{ id: 'chk-1', documentId: 'doc-1', sentence: 'The vendor will report monthly.', page: 7 }];

function shellValue(over: Partial<ShellContextValue> = {}): ShellContextValue {
  return {
    me: meDto(),
    org: orgPayload({ org: organizationDto({ plan: 'free' }) }),
    summary: { plan: 'free', creditsLeft: 5, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 50 },
    bids: [bidDto()],
    bidId: 'bid-1',
    tab: 'compliance',
    bid: bidDto(),
    docs: [docDto({ id: 'doc-1', fileName: 'rfp.pdf' })],
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

function mockApi(rows: ComplianceRowDto[] = ROWS, over: Partial<ComplianceApi> = {}): ComplianceApi {
  return {
    getTab: vi.fn(async () => ({ rows })) as unknown as ComplianceApi['getTab'],
    addComplianceRow: vi.fn(async () => r5),
    updateComplianceRow: vi.fn(async () => ({ ok: true as const })),
    deleteComplianceRow: vi.fn(async () => ({ ok: true as const })),
    mergeComplianceRows: vi.fn(async () => ({ id: 'req-1' })),
    splitComplianceRow: vi.fn(async () => r5),
    listCheckThese: vi.fn(async () => CHECK),
    promoteCheckThese: vi.fn(async () => r5),
    dismissCheckThese: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

function rowApi(rows: ComplianceRowDto[] = ROWS): RowDetailApi {
  return {
    getRow: vi.fn(async (_bid: string, _table: string, id: string) => ({
      row: rows.find((r) => r.id === id) ?? r1,
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
  opts: {
    api?: ComplianceApi;
    shell?: Partial<ShellContextValue>;
    selectedRowId?: string | null;
    rowApi?: RowDetailApi;
    sourceApi?: SourceApi;
  } = {},
) {
  const api = opts.api ?? mockApi();
  const exporter: ComplianceExporter = { csv: vi.fn(), xlsx: vi.fn() };
  const shell = shellValue(opts.shell);
  const src = opts.sourceApi ?? sourceApi();
  const user = userEvent.setup();
  const tree = (bidId: string, value: ShellContextValue, rowId: string | null = opts.selectedRowId ?? null) => (
    <ShellContext.Provider value={value}>
      <ComplianceContainer bidId={bidId} tab="compliance" selectedRowId={rowId} api={api} exporter={exporter} rowApi={opts.rowApi} sourceApi={src} />
    </ShellContext.Provider>
  );
  const view = render(tree('bid-1', shell));
  const switchTo = (bidId: string, over: Partial<ShellContextValue> = {}) => view.rerender(tree(bidId, shellValue({ bidId, ...over })));
  const select = (rowId: string | null) => view.rerender(tree('bid-1', shell, rowId));
  return { api, exporter, shell, user, switchTo, select, sourceApi: src, ...view };
}

const ready = () => screen.findByRole('region', { name: 'Compliance matrix' });
const showing = (shown: number, total: number) => screen.findByText(`Showing ${shown} of ${total} rows`);
const idButton = (reqId: string) => screen.getByRole('button', { name: reqId });
const sourceViewer = () => screen.findByRole('dialog', { description: /^Pages? \d/ });

async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

function withHost() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

describe('ComplianceContainer: loading', () => {
  it('loads the rows and the check these list, and shows the matrix', async () => {
    const { api } = renderContainer();
    await ready();
    expect(api.getTab).toHaveBeenCalledWith('bid-1', 'compliance', expect.anything());
    expect(api.listCheckThese).toHaveBeenCalledWith('bid-1', expect.anything());
    await showing(5, 5);
    expect(screen.getByText('L ref')).toBeTruthy();
  });

  it('shows a skeleton while loading', () => {
    renderContainer({ api: mockApi(ROWS, { getTab: vi.fn(() => new Promise(() => undefined)) as unknown as ComplianceApi['getTab'] }) });
    expect(screen.getByRole('status', { name: 'Loading compliance matrix' })).toBeTruthy();
  });

  it('shows a load error and tries again', async () => {
    const api = mockApi();
    vi.mocked(api.getTab).mockRejectedValueOnce(new ApiError('Could not load.', 500));
    const { user } = renderContainer({ api });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not load.')).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await ready();
    expect(api.getTab).toHaveBeenCalledTimes(2);
  });

  it('keeps the rows shown when a reload fails, with a toast', async () => {
    const api = mockApi();
    const { user } = renderContainer({ api });
    await ready();
    vi.mocked(api.getTab).mockRejectedValueOnce(new ApiError('Could not load.', 500));
    await user.click(screen.getByRole('button', { name: 'Actions for L.4.2' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete row' }));
    await user.click(await screen.findByRole('button', { name: 'Delete row' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load.'));
    expect(screen.getByRole('region', { name: 'Compliance matrix' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reloads when a job changes', async () => {
    const api = mockApi();
    const { switchTo } = renderContainer({ api });
    await ready();
    switchTo('bid-1', { jobs: [jobDto({ type: 'ai:amendment', status: 'completed' })] });
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });
});

describe('ComplianceContainer: tab states', () => {
  it('shows no solicitation without the matrix', async () => {
    renderContainer({ shell: { docs: [] } });
    expect(await screen.findByText('No solicitation yet')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Compliance matrix' })).toBeNull();
  });

  it('shows processing with the matrix', async () => {
    renderContainer({ shell: { jobs: [jobDto({ type: 'ai:compliance', status: 'running', progress: 40 })] } });
    await ready();
    expect(screen.getByRole('heading', { name: 'Processing' })).toBeTruthy();
  });

  it('blocks on a failed compliance step', async () => {
    renderContainer({ shell: { jobs: [jobDto({ type: 'ai:compliance', status: 'failed' })] } });
    expect(await screen.findByText('This step did not finish')).toBeTruthy();
  });

  it('shows out of credits', async () => {
    renderContainer({
      shell: { bid: bidDto({ creditStatus: null }), summary: { plan: 'free', creditsLeft: 0, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 50 } },
    });
    expect(await screen.findByText('You are out of RFP credits')).toBeTruthy();
  });

  it('is never locked on Free, and shows the draft notice for AI rows', async () => {
    renderContainer();
    await ready();
    expect(screen.queryByText(/upgrade to unlock/i)).toBeNull();
    expect(screen.getByText('Draft. Review every row before you rely on it.')).toBeTruthy();
  });

  it('waits on proposed amendment changes to compliance rows', async () => {
    renderContainer({ shell: { links: [linkDto()] } });
    await ready();
    expect(screen.getByRole('heading', { name: 'Confirm amendment changes' })).toBeTruthy();
  });

  it('shows the empty state with an add button', async () => {
    renderContainer({ api: mockApi([]) });
    expect(await screen.findByText('No requirements found')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add requirement' })).toHaveLength(2);
  });

  it('shows the no-match state, and Clear filters brings the rows back', async () => {
    const { user } = renderContainer();
    await ready();
    await user.type(screen.getByLabelText('Search requirements'), 'zzzz');
    expect(await screen.findByText('No rows match these filters')).toBeTruthy();
    await showing(0, 5);
    const empty = screen.getByText('No rows match these filters').parentElement as HTMLElement;
    await user.click(within(empty).getByRole('button', { name: 'Clear filters' }));
    await showing(5, 5);
  });
});

describe('ComplianceContainer: filters', () => {
  it('filters by search', async () => {
    const { user } = renderContainer();
    await ready();
    await user.type(screen.getByLabelText('Search requirements'), 'PRICING');
    await showing(1, 5);
    expect(idButton('L.4.3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'L.4.2' })).toBeNull();
  });

  it('filters by section', async () => {
    const { user } = renderContainer();
    await ready();
    await pick(user, 'Section', 'Section C');
    await showing(2, 5);
  });

  it('filters by type', async () => {
    const { user } = renderContainer();
    await ready();
    await pick(user, 'Type', 'must');
    await showing(1, 5);
  });

  it('filters by status', async () => {
    const { user } = renderContainer();
    await ready();
    await pick(user, 'Status', 'assigned');
    await showing(1, 5);
  });

  it('filters by owner, from the owners in the rows', async () => {
    const { user } = renderContainer();
    await ready();
    await pick(user, 'Owner', 'Sam');
    await showing(1, 5);
  });

  it('filters by amendment: Amd N and Original', async () => {
    const { user } = renderContainer();
    await ready();
    await pick(user, 'Amendment', 'Amd 2');
    await showing(2, 5);
    await pick(user, 'Amendment', 'Original');
    await showing(3, 5);
  });

  it('filters flagged rows, and hides superseded and withdrawn rows', async () => {
    const { user } = renderContainer();
    await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Flagged' }));
    await showing(1, 5);
    await user.click(screen.getByRole('checkbox', { name: 'Flagged' }));
    await user.click(screen.getByRole('checkbox', { name: 'Hide superseded and withdrawn' }));
    await showing(4, 5);
    expect(screen.queryByRole('button', { name: 'C.1' })).toBeNull();
  });

  it('swaps the table for the check these list', async () => {
    const { user } = renderContainer();
    await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Check these' }));
    expect(await screen.findByText(/The vendor will report monthly\./)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Compliance matrix' })).toBeNull();
  });

  it('resets the filters when the bid changes', async () => {
    const { user, switchTo } = renderContainer();
    await ready();
    await user.type(screen.getByLabelText('Search requirements'), 'pricing');
    await showing(1, 5);
    switchTo('bid-2', { bid: bidDto({ id: 'bid-2' }) });
    await showing(5, 5);
    expect((screen.getByLabelText('Search requirements') as HTMLInputElement).value).toBe('');
  });
});

describe('ComplianceContainer: actions', () => {
  it('exports XLSX and CSV named after the bid, with the sheet grouped by instruction reference', async () => {
    const { user, exporter } = renderContainer();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export XLSX' }));
    expect(exporter.xlsx).toHaveBeenCalledTimes(1);
    const [name, sheet] = vi.mocked(exporter.xlsx).mock.calls[0] as [string, string[][]];
    expect(name).toBe('va-ehr-support-compliance.xlsx');
    expect(sheet.map((r) => r[0])).toContain('Section L L.4.2');
    expect(sheet.map((r) => r[0])).toContain('C.1');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export CSV' }));
    expect(vi.mocked(exporter.csv).mock.calls[0]?.[0]).toBe('va-ehr-support-compliance.csv');
  });

  it('exports every row, whatever the filters', async () => {
    const { user, exporter } = renderContainer();
    await ready();
    await user.type(screen.getByLabelText('Search requirements'), 'pricing');
    await showing(1, 5);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export XLSX' }));
    const sheet = vi.mocked(exporter.xlsx).mock.calls[0]?.[1] as string[][];
    expect(sheet.filter((r) => r[0] === 'L.4.2' || r[0] === 'C.1')).toHaveLength(2);
  });

  it('adds a requirement, then reloads and refreshes the shell', async () => {
    const { api, user, shell } = renderContainer();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add requirement' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add requirement' });
    await user.type(within(dialog).getByLabelText('Requirement'), 'Provide a QA plan.');
    await user.click(within(dialog).getByRole('button', { name: 'Add requirement' }));
    expect(api.addComplianceRow).toHaveBeenCalledWith('bid-1', { requirementText: 'Provide a QA plan.' });
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
    expect(shell.refresh).toHaveBeenCalled();
  });

  it('splits a row', async () => {
    const { api, user } = renderContainer();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Actions for L.4.2' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Split row' }));
    const dialog = await screen.findByRole('dialog', { name: 'Split row' });
    fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '9' } });
    await user.click(within(dialog).getByRole('button', { name: 'Split row' }));
    expect(api.splitComplianceRow).toHaveBeenCalledWith('bid-1', 'req-1', 9);
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });

  it('deletes a row only after the confirmation', async () => {
    const { api, user, shell } = renderContainer();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Actions for L.4.2' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete row' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(api.deleteComplianceRow).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.deleteComplianceRow).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Actions for L.4.2' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete row' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete row' }));
    expect(api.deleteComplianceRow).toHaveBeenCalledWith('bid-1', 'req-1');
    await waitFor(() => expect(shell.refresh).toHaveBeenCalled());
  });

  it('closes the slider when the open row is deleted', async () => {
    const host = withHost();
    const { user, shell } = renderContainer({ selectedRowId: 'req-1', rowApi: rowApi(), shell: { detailHost: host } });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Actions for L.4.2' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete row' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete row' }));
    await waitFor(() => expect(shell.openRow).toHaveBeenCalledWith(null));
    host.remove();
  });

  it('merges the selected rows', async () => {
    const { api, user } = renderContainer();
    await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Select L.4.2' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select L.4.3' }));
    await user.click(screen.getByRole('button', { name: 'Merge selected (2)' }));
    expect(api.mergeComplianceRows).toHaveBeenCalledWith('bid-1', ['req-1', 'req-2']);
  });

  it('edits the owner and the status in the table', async () => {
    const { api, user } = renderContainer();
    await ready();
    await user.click(screen.getByRole('combobox', { name: 'Status for L.4.2' }));
    await user.click(await screen.findByRole('option', { name: 'done' }));
    expect(api.updateComplianceRow).toHaveBeenCalledWith('bid-1', 'req-1', { status: 'done' });
    await user.click(screen.getByRole('combobox', { name: 'Owner for L.4.3' }));
    await user.click(await screen.findByRole('option', { name: 'Unassigned' }));
    expect(api.updateComplianceRow).toHaveBeenCalledWith('bid-1', 'req-2', { owner: null });
  });

  it('toasts the API message and reloads when an edit is refused', async () => {
    const api = mockApi(ROWS, { updateComplianceRow: vi.fn(async () => Promise.reject(new ApiError('Not allowed.', 403))) });
    const { user } = renderContainer({ api });
    await ready();
    await user.click(screen.getByRole('combobox', { name: 'Status for L.4.2' }));
    await user.click(await screen.findByRole('option', { name: 'done' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not allowed.'));
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });

  it('adds a check these sentence as a requirement', async () => {
    const { api, user, shell } = renderContainer();
    await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Check these' }));
    await user.click(await screen.findByRole('button', { name: 'Add as requirement' }));
    expect(api.promoteCheckThese).toHaveBeenCalledWith('chk-1');
    await waitFor(() => expect(api.listCheckThese).toHaveBeenCalledTimes(2));
    expect(shell.refresh).toHaveBeenCalled();
  });

  it('dismisses a check these sentence', async () => {
    const { api, user } = renderContainer();
    await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Check these' }));
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(api.dismissCheckThese).toHaveBeenCalledWith('chk-1');
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });

  it('toasts the message and reloads when a check these sentence was already added (409)', async () => {
    const api = mockApi(ROWS, { promoteCheckThese: vi.fn(async () => Promise.reject(new ApiError('Already added or dismissed.', 409))) });
    const { user } = renderContainer({ api });
    await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Check these' }));
    await user.click(await screen.findByRole('button', { name: 'Add as requirement' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Already added or dismissed.'));
    await waitFor(() => expect(api.listCheckThese).toHaveBeenCalledTimes(2));
  });

  it('ignores a second promote while the first is in flight', async () => {
    let finish!: () => void;
    const api = mockApi(ROWS, {
      promoteCheckThese: vi.fn(() => new Promise((resolve) => (finish = () => resolve(r5)))) as unknown as ComplianceApi['promoteCheckThese'],
    });
    const { user } = renderContainer({ api });
    await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Check these' }));
    const button = await screen.findByRole('button', { name: 'Add as requirement' });
    await user.click(button);
    await user.click(button);
    expect(api.promoteCheckThese).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });
});

describe('ComplianceContainer: rows and sources', () => {
  it('opens a row through the shell, from the ID button and from the actions menu', async () => {
    const { user, shell } = renderContainer();
    await ready();
    await user.click(idButton('L.4.3'));
    expect(shell.openRow).toHaveBeenLastCalledWith('req-2');
    await user.click(screen.getByRole('button', { name: 'Actions for L.4.2' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open details' }));
    expect(shell.openRow).toHaveBeenLastCalledWith('req-1');
  });

  it('jumps to the replacing row of a superseded row', async () => {
    const { user, shell } = renderContainer();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Superseded by Amd 2' }));
    expect(shell.openRow).toHaveBeenCalledWith('req-4');
  });

  it('opens the source of a row in the source viewer, with its page, and closes it', async () => {
    const src = sourceApi();
    const { user } = renderContainer({ sourceApi: src });
    await ready();
    await user.click(screen.getByRole('button', { name: /Open source for L\.4\.3, pages 13 to 14/ }));
    const viewer = await sourceViewer();
    expect(viewer.closest('.app-shell')).toBeNull();
    expect(src.getDocumentPages).toHaveBeenCalledWith('doc-1', expect.objectContaining({ from: 13, to: 14 }), expect.anything());
    await user.click(within(viewer).getAllByRole('button', { name: 'Close' })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog', { description: /^Pages? \d/ })).toBeNull());
  });

  it('says so when a row has a page but no document', async () => {
    const orphan = complianceRowDto({ id: 'req-6', reqId: 'O-1', documentId: null, sourcePage: 5 });
    const { user } = renderContainer({ api: mockApi([orphan]) });
    await ready();
    await user.click(screen.getByRole('button', { name: /Open source for O-1/ }));
    expect(toast.info).toHaveBeenCalledWith('No source page for this row.');
    expect(screen.queryByRole('dialog', { description: /^Pages? \d/ })).toBeNull();
  });

  it('gives every AI row a source control, and no button for a hand-added row', async () => {
    const noPage = complianceRowDto({ id: 'req-7', reqId: 'N-1', sourcePage: null, documentId: null });
    renderContainer({ api: mockApi([r1, noPage, r5]) });
    await ready();
    expect(screen.getByRole('button', { name: /Open source for L\.4\.2/ })).toBeTruthy();
    expect(screen.getAllByText('No source')).toHaveLength(1);
    expect(screen.getAllByText('Added by user').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Open source for U-1/ })).toBeNull();
  });
});

describe('ComplianceContainer: row detail', () => {
  it("renders the row detail in the shell's host, outside .app-shell, and closes through the shell", async () => {
    const host = withHost();
    const rows = rowApi();
    const { user, shell } = renderContainer({ selectedRowId: 'req-2', rowApi: rows, shell: { detailHost: host } });
    const heading = await within(host).findByRole('heading', { name: 'L.4.3', level: 2 });
    expect(heading.closest('.app-shell')).toBeNull();
    expect(rows.getRow).toHaveBeenCalledWith('bid-1', 'compliance_rows', 'req-2', expect.anything());
    await user.click(within(host).getByRole('button', { name: 'Close row detail' }));
    expect(shell.openRow).toHaveBeenCalledWith(null);
    host.remove();
  });

  it('draws no slider without a selected row', async () => {
    const host = withHost();
    const rows = rowApi();
    renderContainer({ rowApi: rows, shell: { detailHost: host } });
    await ready();
    expect(rows.getRow).not.toHaveBeenCalled();
    expect(host.childElementCount).toBe(0);
    host.remove();
  });

  it('saves from the slider, reloads the tab and the shell, then close returns focus to the row’s ID button', async () => {
    const host = withHost();
    const rows = rowApi();
    const { api, user, shell, select } = renderContainer({ rowApi: rows, shell: { detailHost: host } });
    await ready();
    await user.click(idButton('L.4.2'));
    expect(shell.openRow).toHaveBeenCalledWith('req-1');
    select('req-1');
    await within(host).findByRole('heading', { name: 'L.4.2', level: 2 });
    await user.click(within(host).getByRole('button', { name: 'Edit' }));
    await user.type(within(host).getByLabelText('Owner'), 'Pat');
    await user.click(within(host).getByRole('button', { name: 'Save changes' }));
    expect(rows.updateRow).toHaveBeenCalledWith('bid-1', 'compliance_rows', 'req-1', { owner: 'Pat' });
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
    expect(shell.refresh).toHaveBeenCalled();
    await user.click(within(host).getByRole('button', { name: 'Close row detail' }));
    expect(document.activeElement).toBe(idButton('L.4.2'));
    host.remove();
  });

  it('returns focus to the new ID button when the opener was remounted while the slider was open', async () => {
    const host = withHost();
    const { user, select } = renderContainer({ rowApi: rowApi(), shell: { detailHost: host } });
    await ready();
    const opener = idButton('L.4.2');
    await user.click(opener);
    select('req-1');
    await within(host).findByRole('heading', { name: 'L.4.2', level: 2 });
    // Filtering the row out and back remounts its button.
    const search = screen.getByLabelText('Search requirements');
    await user.type(search, 'zzzz');
    await screen.findByText('No rows match these filters');
    await user.clear(search);
    await ready();
    expect(opener.isConnected).toBe(false);
    await user.click(within(host).getByRole('button', { name: 'Close row detail' }));
    expect(document.activeElement).toBe(idButton('L.4.2'));
    expect(document.activeElement).not.toBe(opener);
    host.remove();
  });

  it('returns focus to the shown row’s ID button after a jump to another row', async () => {
    const host = withHost();
    const { user, select } = renderContainer({ rowApi: rowApi(), shell: { detailHost: host } });
    await ready();
    await user.click(idButton('L.4.2'));
    select('req-1');
    await within(host).findByRole('heading', { name: 'L.4.2', level: 2 });
    select('req-4');
    await within(host).findByRole('heading', { name: 'C.1a', level: 2 });
    await user.click(within(host).getByRole('button', { name: 'Close row detail' }));
    expect(document.activeElement).toBe(idButton('C.1a'));
    host.remove();
  });

  it('opens the slider’s source in the viewer', async () => {
    const host = withHost();
    const src = sourceApi();
    const { user } = renderContainer({ selectedRowId: 'req-1', rowApi: rowApi(), sourceApi: src, shell: { detailHost: host } });
    await within(host).findByRole('heading', { name: 'L.4.2', level: 2 });
    await user.click(within(host).getByRole('button', { name: 'Open source' }));
    const viewer = await sourceViewer();
    expect(within(viewer).getByText('Page 12')).toBeTruthy();
    host.remove();
  });
});

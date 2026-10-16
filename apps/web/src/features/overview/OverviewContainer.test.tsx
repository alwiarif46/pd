// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ApiError, type BidFactDto, type TabProposalDto } from '@/api';
import type { Workspace } from '@/screens/Workspace';
import { NEW_ROW_MISSING_MESSAGE, ROW_ALREADY_CLOSED_MESSAGE } from '@/features/proposals/controller';
import { ShellContext, type ShellContextValue } from '@/features/shell/bid-context';
import { jsonResponse, mockFetch } from '@/test/fetch';
import { bidDto, bidFactDto, docDto, jobDto, meDto, orgPayload, organizationDto, tabProposalDto } from '@/test/fixtures';
import { OverviewContainer, type OverviewApi } from './OverviewContainer';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

type LegacyProps = Parameters<typeof Workspace>[0];

const mine = bidFactDto({ id: 'fact-1', field: 'Agency', value: 'VA' });
const next = bidFactDto({ id: 'fact-new', field: 'Agency', value: 'GSA', origin: 'ai', documentId: 'doc-amd', sourcePage: 4 });
const proposal = tabProposalDto(next, { oldRowIds: ['fact-1'], sourceQuote: 'The agency is GSA.' });

function shellValue(over: Partial<ShellContextValue> = {}): ShellContextValue {
  return {
    me: meDto(),
    org: orgPayload({ org: organizationDto({ plan: 'starter' }) }),
    summary: { plan: 'starter', creditsLeft: 5, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 300 },
    bids: [bidDto()],
    bidId: 'bid-1',
    tab: 'overview',
    bid: bidDto(),
    docs: [docDto()],
    jobs: [],
    links: [],
    bidLoaded: true,
    selectedRowId: null,
    refresh: vi.fn(),
    openRow: vi.fn(),
    openUpgrade: vi.fn(),
    confirm: vi.fn(async () => true),
    ...over,
  };
}

function mockApi(proposals: TabProposalDto<BidFactDto>[] = [proposal], over: Partial<OverviewApi> = {}): OverviewApi {
  return {
    getTab: vi.fn(async () => ({ facts: [mine], kickoff: [], proposals })) as unknown as OverviewApi['getTab'],
    confirmAmendmentLink: vi.fn(async () => ({ ok: true as const, status: 'confirmed' as const, amendmentStatus: 'applied' as const })),
    rejectAmendmentLink: vi.fn(async () => ({ ok: true as const, status: 'rejected' as const, amendmentStatus: 'applied' as const })),
    ...over,
  };
}

function renderContainer(opts: { api?: OverviewApi; shell?: Partial<ShellContextValue> } = {}) {
  const api = opts.api ?? mockApi();
  const shell = shellValue(opts.shell);
  const legacy: LegacyProps[] = [];
  const Legacy = ((props: LegacyProps) => {
    legacy.push(props);
    return <p>Legacy overview</p>;
  }) as unknown as typeof Workspace;
  const view = render(
    <ShellContext.Provider value={shell}>
      <OverviewContainer bidId="bid-1" tab="overview" selectedRowId={null} api={api} Legacy={Legacy} />
    </ShellContext.Provider>,
  );
  const last = () => legacy[legacy.length - 1]!;
  return { api, shell, last, user: userEvent.setup(), ...view };
}

const card = () => screen.findByRole('article', { name: 'Amendment 2: Agency' });

describe('OverviewContainer', () => {
  it('draws the proposals panel outside the legacy frame, and the legacy Overview inside it', async () => {
    const { api, last } = renderContainer();
    const article = await card();
    expect(api.getTab).toHaveBeenCalledWith('bid-1', 'overview', expect.anything());
    expect(within(article).getByText('Agency: GSA')).toBeTruthy();
    expect(within(article).getByText('Replaces Agency: VA')).toBeTruthy();
    expect(article.closest('.app-shell')).toBeNull();
    expect(screen.getByText('Legacy overview').closest('.app-shell')).toBeTruthy();
    expect(last()).toMatchObject({ embedded: true, bidId: 'bid-1', tab: 'overview', refreshKey: '' });
  });

  it('inserts, reloads the panel and the shell, and reloads the legacy screen', async () => {
    const { api, shell, last, user } = renderContainer();
    await user.click(within(await card()).getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
    expect(api.confirmAmendmentLink).toHaveBeenCalledWith('link-a');
    expect(toast.success).toHaveBeenCalledWith('Inserted the change from Amendment 2.');
    expect(shell.refresh).toHaveBeenCalled();
    expect(last().refreshKey).toBe('#1');
  });

  it('keeps the shell key until the first decision, then suffixes it', async () => {
    const jobs = [jobDto({ id: 'job-1', status: 'completed' })];
    const { last, user } = renderContainer({ shell: { jobs } });
    await card();
    expect(last().refreshKey).toBe('job-1:completed');
    await user.click(within(await card()).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(last().refreshKey).toBe('job-1:completed#1'));
  });

  it('dismisses', async () => {
    const { api, user } = renderContainer();
    await user.click(within(await card()).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(api.rejectAmendmentLink).toHaveBeenCalledWith('link-a'));
    expect(toast.success).toHaveBeenCalledWith('Dismissed the change from Amendment 2. Your row stays.');
  });

  it.each([
    ['row_already_closed', ROW_ALREADY_CLOSED_MESSAGE],
    ['new_row_missing', NEW_ROW_MISSING_MESSAGE],
  ])('shows the web wording for 409 %s, and reloads', async (code, message) => {
    const api = mockApi([proposal], { confirmAmendmentLink: vi.fn(async () => Promise.reject(new ApiError('API text.', 409, code))) });
    const { user } = renderContainer({ api });
    await user.click(within(await card()).getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });

  it('shows no panel when the load fails, and the legacy screen still renders', async () => {
    const api = mockApi([proposal], { getTab: vi.fn(async () => Promise.reject(new ApiError('No.', 500))) as unknown as OverviewApi['getTab'] });
    renderContainer({ api });
    await waitFor(() => expect(api.getTab).toHaveBeenCalled());
    expect(screen.getByText('Legacy overview')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Changes from amendments' })).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("refetches the panel after the legacy screen's own change, without changing its key", async () => {
    const { api, shell, last } = renderContainer();
    await card();
    last().onChanged?.();
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
    expect(shell.refresh).toHaveBeenCalled();
    expect(last().refreshKey).toBe('');
  });

  it('opens a proposal source, and says when there is none', async () => {
    const fetchMock = mockFetch();
    const { user } = renderContainer({
      api: mockApi([proposal, tabProposalDto({ ...next, id: 'fact-x', field: 'NAICS', documentId: null }, { linkId: 'link-b' })]),
    });
    await user.click(within(await card()).getByRole('button', { name: 'Open source for Agency, page 4' }));
    expect(document.querySelector('.app-shell [aria-label="Source viewer"]')).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/documents/doc-amd/view-token'))).toBe(true));
    const other = screen.getByRole('article', { name: 'Amendment 2: NAICS' });
    await user.click(within(other).getByRole('button', { name: 'Open source for NAICS, page 4' }));
    expect(toast.info).toHaveBeenCalledWith('No source page for this row.');
  });

  it('reloads the real legacy Overview after a decision', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/api\/bids\/[^/]+$/.test(url)) return jsonResponse(200, bidDto());
      if (/\/tabs\/overview$/.test(url)) return jsonResponse(200, { facts: [], kickoff: [], proposals: [] });
      return jsonResponse(200, []);
    });
    vi.stubGlobal('fetch', fetchMock);
    const jobLoads = () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/jobs')).length;
    const api = mockApi();
    const user = userEvent.setup();
    render(
      <ShellContext.Provider value={shellValue({ jobs: [jobDto({ id: 'job-1', status: 'completed' })] })}>
        <OverviewContainer bidId="bid-1" tab="overview" selectedRowId={null} api={api} />
      </ShellContext.Provider>,
    );
    await card();
    await waitFor(() => expect(jobLoads()).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 30)); // the mount load and the seed reload settle
    const before = jobLoads();
    await user.click(within(await card()).getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(jobLoads()).toBe(before + 1));
  });
});

// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getToken, setToken } from '@/api';
import { bidDto, docDto, jobDto, linkDto, meDto, orgPayload, organizationDto } from '@/test/fixtures';
import { jsonResponse } from '@/test/fetch';
import { TabFrameContainer } from '@/features/tab-frame/TabFrameContainer';
import type { TabFrameApi } from '@/features/tab-frame/actions';
import { AppRoot } from './AppRoot';
import { ShellContext, type ShellContextValue } from './bid-context';
import type { ShellApi } from './controller';
import { LegacyFrame } from './LegacyFrame';
import { ShellContainer } from './ShellContainer';

function mockApi(over: Partial<ShellApi> = {}): ShellApi {
  return {
    getMe: vi.fn(async () => meDto()),
    getOrg: vi.fn(async () => orgPayload()),
    listBids: vi.fn(async () => [bidDto(), bidDto({ id: 'bid-2', name: 'Navy IT' })]),
    getBid: vi.fn(async () => bidDto()),
    listDocuments: vi.fn(async () => [docDto()]),
    listJobs: vi.fn(async () => [jobDto()]),
    listAmendmentLinks: vi.fn(async () => []),
    startCheckout: vi.fn(async () => ({ url: 'https://checkout.stripe.com/c/1' })),
    openBillingPortal: vi.fn(async () => ({ url: 'https://billing.stripe.com/p/1' })),
    logOut: vi.fn(async () => undefined),
    ...over,
  };
}

const outline = { kind: 'tab', bidId: 'bid-1', tab: 'outline', rowId: null } as const;

afterEach(() => {
  vi.useRealTimers();
  window.location.hash = '';
});

describe('LegacyFrame', () => {
  it('keeps the legacy class so legacy CSS applies and the scoped preflight does not', () => {
    const { container } = render(
      <LegacyFrame>
        <p>Legacy</p>
      </LegacyFrame>,
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).toBe('app-shell legacy-embed');
    expect(frame.textContent).toBe('Legacy');
  });
});

describe('ShellContainer', () => {
  it('draws a paid tab on Free as locked, and its upgrade opens the dialog and Checkout', async () => {
    const api = mockApi({
      startCheckout: vi.fn(async () => Promise.reject(new ApiError('Billing is not available yet.', 503, 'billing_unavailable'))),
    });
    render(<ShellContainer route={outline} api={api} />);
    expect(await screen.findByText('outline is on a paid plan')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Outline (locked)' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('navigation', { name: 'Account and bid' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /Upgrade plan/ }));
    expect(await screen.findByText('This tab is on a paid plan.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose Starter' }));
    expect(api.startCheckout).toHaveBeenCalledWith('starter');
    await waitFor(() => expect(screen.queryByText('This tab is on a paid plan.')).toBeNull());
  });

  it('switches bids and tabs through the hash', async () => {
    render(<ShellContainer route={outline} api={mockApi()} />);
    await screen.findByText('outline is on a paid plan');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Bid' }), 'bid-2');
    expect(window.location.hash).toBe('#/bids/bid-2/outline');
    await userEvent.click(screen.getByRole('button', { name: 'Compliance' }));
    expect(window.location.hash).toBe('#/bids/bid-1/compliance');
    await userEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(window.location.hash).toBe('#/account');
  });

  it('polls every 3 s while a job runs and stops when the bid is idle', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let running = true;
    const api = mockApi({ listJobs: vi.fn(async () => [jobDto({ status: running ? 'running' : 'completed' })]) });
    render(<ShellContainer route={outline} api={api} />);
    await screen.findByText('outline is on a paid plan');
    await waitFor(() => expect(api.listJobs).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => expect(api.listJobs).toHaveBeenCalledTimes(2));
    running = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => expect(api.listJobs).toHaveBeenCalledTimes(3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(api.listJobs).toHaveBeenCalledTimes(3);
  });

  it('shows the API message and a way back when the bid cannot be loaded', async () => {
    const api = mockApi({ getBid: vi.fn(async () => Promise.reject(new ApiError('Bid not found', 404))) });
    render(<ShellContainer route={{ kind: 'tab', bidId: 'nope', tab: 'overview', rowId: null }} api={api} />);
    expect(await screen.findByText('Bid not found')).toBeTruthy();
  });

  it('signs out through the API and goes to log in', async () => {
    const api = mockApi();
    render(<ShellContainer route={outline} api={api} />);
    await screen.findByText('outline is on a paid plan');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(api.logOut).toHaveBeenCalled();
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
  });
});

describe('AppRoot', () => {
  it('signs out on a 401 and shows log in', async () => {
    setToken('expired');
    window.location.hash = '#/bids';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'Sign in again' })));
    render(<AppRoot />);
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
    expect(getToken()).toBeNull();
    expect(await screen.findByRole('button', { name: /log in/i })).toBeTruthy();
  });
});

describe('TabFrameContainer', () => {
  function shellValue(over: Partial<ShellContextValue> = {}): ShellContextValue {
    return {
      me: meDto(),
      org: orgPayload({ org: organizationDto({ plan: 'starter' }) }),
      summary: { plan: 'starter', creditsLeft: 5, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 300 },
      bids: [bidDto()],
      bidId: 'bid-1',
      tab: 'compliance',
      bid: bidDto(),
      docs: [docDto({ markingStatus: 'blocked', markingFound: ['CUI'], markingPage: 2 })],
      jobs: [],
      links: [linkDto()],
      bidLoaded: true,
      selectedRowId: null,
      refresh: vi.fn(),
      openRow: vi.fn(),
      openUpgrade: vi.fn(),
      confirm: vi.fn(async () => true),
      ...over,
    };
  }
  function tabApi(): TabFrameApi {
    return {
      retryJob: vi.fn(async () => ({ id: 'j2' })),
      confirmMarking: vi.fn(async () => ({ ok: true as const })),
      deleteDocument: vi.fn(async () => ({ ok: true as const })),
      confirmAmendmentLink: vi.fn(async () => ({ ok: true as const, status: 'confirmed' as const, amendmentStatus: 'applied' as const })),
      rejectAmendmentLink: vi.fn(async () => ({ ok: true as const, status: 'rejected' as const, amendmentStatus: 'applied' as const })),
    };
  }

  it('wires the marking prompt and the amendment cards, refreshing after each', async () => {
    const value = shellValue();
    const api = tabApi();
    render(
      <ShellContext.Provider value={value}>
        <TabFrameContainer tab="compliance" title="Compliance" api={api}>
          <p>Rows</p>
        </TabFrameContainer>
      </ShellContext.Provider>,
    );
    expect(screen.getByText('Rows')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm file is public' }));
    await waitFor(() => expect(api.confirmMarking).toHaveBeenCalledWith('doc-1'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith('doc-1'));
    expect(value.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove rfp.pdf?' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.rejectAmendmentLink).toHaveBeenCalledWith('link-1'));
    await userEvent.click(screen.getByRole('button', { name: 'Open source for C.3.2, page 12' }));
    expect(value.openRow).toHaveBeenCalledWith('row-old');
    await waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(3));
  });

  it('does not delete when the confirm dialog is cancelled', async () => {
    const value = shellValue({ confirm: vi.fn(async () => false), links: [] });
    const api = tabApi();
    render(
      <ShellContext.Provider value={value}>
        <TabFrameContainer tab="overview" title="Overview" api={api}>
          {null}
        </TabFrameContainer>
      </ShellContext.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(value.confirm).toHaveBeenCalled());
    expect(api.deleteDocument).not.toHaveBeenCalled();
  });

  it('retries the failed job and sends uploads to Documents', async () => {
    const value = shellValue({
      docs: [docDto()],
      links: [],
      jobs: [jobDto({ id: 'job-x', type: 'file', status: 'failed' })],
    });
    const api = tabApi();
    render(
      <ShellContext.Provider value={value}>
        <TabFrameContainer tab="overview" title="Overview" api={api}>
          {null}
        </TabFrameContainer>
      </ShellContext.Provider>,
    );
    expect(screen.getByText('We could not read this file.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.retryJob).toHaveBeenCalledWith('job-x'));
  });

  it('opens the upgrade dialog for the over-cap banner', async () => {
    const value = shellValue({
      summary: { plan: 'free', creditsLeft: 1, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 50 },
      docs: [docDto({ sizeBytes: 60 * 1024 * 1024 })],
      links: [],
    });
    render(
      <ShellContext.Provider value={value}>
        <TabFrameContainer tab="documents" title="Documents" api={tabApi()}>
          {null}
        </TabFrameContainer>
      </ShellContext.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade plan' }));
    expect(value.openUpgrade).toHaveBeenCalledWith('over_cap');
  });
});

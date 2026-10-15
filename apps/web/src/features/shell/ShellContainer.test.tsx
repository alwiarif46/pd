// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getToken, setToken } from '@/api';
import { bidDto, creditDto, docDto, jobDto, linkDto, meDto, orgPayload, organizationDto } from '@/test/fixtures';
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

const realTz = process.env.TZ;
const outline = { kind: 'tab', bidId: 'bid-1', tab: 'outline', rowId: null } as const;

afterEach(() => {
  vi.useRealTimers();
  window.location.hash = '';
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
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
    // The interim bar is gone: v0's shell has the account menu and the bid switcher.
    expect(screen.queryByRole('navigation', { name: 'Account and bid' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Upgrade plan/ }));
    expect(await screen.findByText('This tab is on a paid plan.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose Starter' }));
    expect(api.startCheckout).toHaveBeenCalledWith('starter');
    await waitFor(() => expect(screen.queryByText('This tab is on a paid plan.')).toBeNull());
  });

  it('opens the upgrade dialog when a locked tab is clicked in the tab list, and does not navigate', async () => {
    render(<ShellContainer route={{ kind: 'tab', bidId: 'bid-1', tab: 'overview', rowId: null }} api={mockApi()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reviews (locked)' }));
    expect(await screen.findByText('This tab is on a paid plan.')).toBeTruthy();
    expect(window.location.hash).toBe('');
  });

  it('switches bids from the bid switcher, keeping the tab, and tabs through the tab list', async () => {
    render(<ShellContainer route={outline} api={mockApi()} />);
    await screen.findByText('outline is on a paid plan');
    await userEvent.click(screen.getByRole('button', { name: /VA EHR Support/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Navy IT' }));
    expect(window.location.hash).toBe('#/bids/bid-2/outline');
    await userEvent.click(screen.getByRole('button', { name: 'Compliance' }));
    expect(window.location.hash).toBe('#/bids/bid-1/compliance');
  });

  it('opens Account and Privacy from the account menu', async () => {
    render(<ShellContainer route={outline} api={mockApi()} />);
    await screen.findByText('outline is on a paid plan');
    await userEvent.click(screen.getByRole('button', { name: 'Account menu for Dana Reyes' }));
    expect(await screen.findByText('dana@northbridge.example')).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Account' }));
    expect(window.location.hash).toBe('#/account');
    await userEvent.click(screen.getByRole('button', { name: 'Account menu for Dana Reyes' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Privacy' }));
    expect(window.location.hash).toBe('#/privacy');
  });

  it('links to Bids and Organization outside a bid', async () => {
    render(<ShellContainer route={{ kind: 'page', page: 'privacy' }} api={mockApi()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Organization' }));
    expect(window.location.hash).toBe('#/org');
    await userEvent.click(screen.getByRole('button', { name: 'Bids' }));
    expect(window.location.hash).toBe('#/bids');
    expect(screen.queryByRole('navigation', { name: 'Bid tabs' })).toBeNull();
  });

  it('opens the mobile tab list from the Menu button', async () => {
    render(<ShellContainer route={outline} api={mockApi()} />);
    await screen.findByText('outline is on a paid plan');
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('navigation', { name: 'Bid tabs' })).toBeTruthy();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Schedule' }));
    expect(window.location.hash).toBe('#/bids/bid-1/schedule');
  });

  it.each([
    ['processing', [jobDto({ status: 'running', type: 'scan' })], [docDto()]],
    ['waiting', [], [docDto({ markingStatus: 'blocked', markingFound: ['CUI'], markingPage: 2 })]],
  ] as const)('shows the %s signal on the Documents tab with its label', async (signal, jobs, docs) => {
    const api = mockApi({ listJobs: vi.fn(async () => [...jobs]), listDocuments: vi.fn(async () => [...docs]) });
    render(<ShellContainer route={{ kind: 'tab', bidId: 'bid-1', tab: 'documents', rowId: null }} api={api} />);
    const documents = await screen.findByRole('button', { name: 'Documents' });
    await waitFor(() => expect(within(documents).getByLabelText(signal)).toBeTruthy());
  });

  it('writes the due date and the credit reset as the right calendar days in Los Angeles', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const api = mockApi({
      getOrg: vi.fn(async () =>
        orgPayload({ credits: creditDto({ periodEnd: '2026-11-08T20:00:00.000Z' }) }),
      ),
    });
    render(<ShellContainer route={{ kind: 'tab', bidId: 'bid-1', tab: 'overview', rowId: null }} api={api} />);
    // Due 2026-11-03 stored as midnight UTC: Nov 3, not Nov 2.
    expect(await screen.findByText('Due Nov 3, 2026 at 14:00 (America/New_York)')).toBeTruthy();
    expect(screen.getByText(/resets Nov 8, 2026/)).toBeTruthy();
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

  it('keeps polling after a failed poll, waiting longer, and resets the wait on success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = [jobDto({ status: 'running' })];
    const listJobs = vi
      .fn<ShellApi['listJobs']>()
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new ApiError('The API is not reachable', 0))
      .mockResolvedValue(running);
    const api = mockApi({ listJobs });
    render(<ShellContainer route={outline} api={api} />);
    await screen.findByText('outline is on a paid plan');
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(2)); // fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(listJobs).toHaveBeenCalledTimes(2); // backing off: 6 s after a failure
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(3)); // succeeds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(4)); // back to 3 s
    expect(screen.getByText('outline is on a paid plan')).toBeTruthy();
  });

  it('shows the API message and a way back when the bid cannot be loaded', async () => {
    const api = mockApi({ getBid: vi.fn(async () => Promise.reject(new ApiError('Bid not found', 404))) });
    render(<ShellContainer route={{ kind: 'tab', bidId: 'nope', tab: 'overview', rowId: null }} api={api} />);
    expect(await screen.findByText('Bid not found')).toBeTruthy();
    expect(screen.getByText('Bid not available')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open the bid list' }));
    expect(window.location.hash).toBe('#/bids');
  });

  it('leaves for Checkout once, however often the plan is chosen', async () => {
    let finish: (value: { url: string }) => void = () => undefined;
    const api = mockApi({ startCheckout: vi.fn(() => new Promise<{ url: string }>((resolve) => (finish = resolve))) });
    const leaveTo = vi.fn();
    render(<ShellContainer route={outline} api={api} leaveTo={leaveTo} />);
    await userEvent.click(await screen.findByRole('button', { name: /Upgrade plan/ }));
    const choose = await screen.findByRole('button', { name: 'Choose Growth' });
    await userEvent.click(choose);
    await userEvent.click(choose);
    expect(api.startCheckout).toHaveBeenCalledTimes(1);
    finish({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    await waitFor(() => expect(leaveTo).toHaveBeenCalledExactlyOnceWith('https://checkout.stripe.com/c/pay/cs_1'));
  });

  it('does not leave for a URL that is not Stripe', async () => {
    const api = mockApi({ startCheckout: vi.fn(async () => ({ url: 'https://evil.example/pay' })) });
    const leaveTo = vi.fn();
    render(<ShellContainer route={outline} api={api} leaveTo={leaveTo} />);
    await userEvent.click(await screen.findByRole('button', { name: /Upgrade plan/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Starter' }));
    await waitFor(() => expect(screen.queryByText('This tab is on a paid plan.')).toBeNull());
    expect(leaveTo).not.toHaveBeenCalled();
  });

  it('says Orals is off instead of opening it on a bid without orals', async () => {
    const api = mockApi({
      getOrg: vi.fn(async () => orgPayload({ org: organizationDto({ plan: 'starter' }) })),
      getBid: vi.fn(async () => bidDto({ oralsEnabled: false })),
    });
    render(<ShellContainer route={{ kind: 'tab', bidId: 'bid-1', tab: 'orals', rowId: null }} api={api} />);
    expect(await screen.findByText('Orals is off for this bid')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(window.location.hash).toBe('#/bids/bid-1/settings');
  });

  it('signs out from the account menu through the API and goes to log in', async () => {
    const api = mockApi();
    render(<ShellContainer route={outline} api={api} />);
    await screen.findByText('outline is on a paid plan');
    await userEvent.click(screen.getByRole('button', { name: 'Account menu for Dana Reyes' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(api.logOut).toHaveBeenCalled();
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
  });

  it('draws the organization page inside the shell when the user has no organization', async () => {
    const api = mockApi({ getOrg: vi.fn(async () => Promise.reject(new ApiError('No organization', 403))) });
    render(<ShellContainer route={{ kind: 'page', page: 'bids' }} api={api} />);
    expect(await screen.findByRole('button', { name: 'Account menu for Dana Reyes' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Bid tabs' })).toBeNull();
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

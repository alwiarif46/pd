// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getToken, notifySeatLocked, setToken } from '@/api';
import { bidDto, creditDto, docDto, jobDto, linkDto, meDto, orgPayload, organizationDto } from '@/test/fixtures';
import { jsonResponse } from '@/test/fetch';
import { TabFrameContainer } from '@/features/tab-frame/TabFrameContainer';
import type { TabFrameApi } from '@/features/tab-frame/actions';
import { AppRoot } from './AppRoot';
import { ShellContext, type ShellContextValue } from './bid-context';
import type { ShellApi } from './controller';
import { LegacyFrame } from './LegacyFrame';
import { collectRoutes, type TabScreenProps } from './registry';
import { useDetailPortal } from '@/features/row-detail/use-detail-portal';
import { ShellContainer } from './ShellContainer';
import { savePendingInvite } from '@/features/membership/pending-invite';

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
    // With credits left the top bar has no Upgrade plan button: the locked tab's own button opens the dialog.
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: 'Upgrade plan' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Upgrade plan' }));
    expect(await screen.findByText('This tab is on a paid plan.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose Starter' }));
    expect(api.startCheckout).toHaveBeenCalledWith('starter');
    await waitFor(() => expect(screen.queryByText('This tab is on a paid plan.')).toBeNull());
  });

  it('navigates to a locked tab, shows the locked state, and its Upgrade plan opens the dialog', async () => {
    render(<ShellContainer route={{ kind: 'tab', bidId: 'bid-1', tab: 'overview', rowId: null }} api={mockApi()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reviews (locked)' }));
    expect(window.location.hash).toBe('#/bids/bid-1/reviews');
    expect(screen.queryByText('This tab is on a paid plan.')).toBeNull();
    // The route is a prop, so the click only navigates; draw the state it leads to.
    cleanup();
    render(<ShellContainer route={{ kind: 'tab', bidId: 'bid-1', tab: 'reviews', rowId: null }} api={mockApi()} />);
    expect(await screen.findByText('reviews is on a paid plan')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade plan' }));
    expect(await screen.findByText('This tab is on a paid plan.')).toBeTruthy();
  });

  it('shows the out-of-credits dialog with the reset as a calendar day, without throwing', async () => {
    process.env.TZ = 'America/New_York';
    const api = mockApi({
      getOrg: vi.fn(async () =>
        orgPayload({ credits: creditDto({ allowed: 2, used: 2, reserved: 0, periodEnd: '2026-11-01T04:00:00.000Z' }) }),
      ),
    });
    render(<ShellContainer route={{ kind: 'tab', bidId: 'bid-1', tab: 'compliance', rowId: null }} api={api} />);
    await userEvent.click(within(await screen.findByRole('banner')).getByRole('button', { name: 'Upgrade plan' }));
    expect(await screen.findByText(/They reset on Nov 1\./)).toBeTruthy();
  });

  it('switches bids from the bid switcher, keeping the tab, and tabs through the tab list', async () => {
    render(<ShellContainer route={outline} api={mockApi()} />);
    await screen.findByText('outline is on a paid plan');
    await userEvent.click(screen.getByRole('combobox', { name: 'Bid' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Navy IT' }));
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
    ['processing', 'Processing', [jobDto({ status: 'running', type: 'scan' })], [docDto()]],
    ['waiting', 'Needs you', [], [docDto({ markingStatus: 'blocked', markingFound: ['CUI'], markingPage: 2 })]],
  ] as const)('shows the %s signal on the Documents tab with its label', async (_signal, label, jobs, docs) => {
    const api = mockApi({ listJobs: vi.fn(async () => [...jobs]), listDocuments: vi.fn(async () => [...docs]) });
    render(<ShellContainer route={{ kind: 'tab', bidId: 'bid-1', tab: 'documents', rowId: null }} api={api} />);
    expect(await screen.findByRole('button', { name: `Documents, ${label}` })).toBeTruthy();
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
    expect(await screen.findByText('Due Nov 3, 2:00 PM ET')).toBeTruthy();
    expect(screen.getByText(/resets Nov 8/)).toBeTruthy();
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
    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade plan' }));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade plan' }));
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

describe('ShellContainer seat-locked member', () => {
  const locked = () => new ApiError('Your plan has no seat for you.', 403, 'seat_locked');
  const bids = { kind: 'page', page: 'bids' } as const;

  it('draws the seat-locked screen full page, without the shell navigation', async () => {
    const api = mockApi({ getOrg: vi.fn(async () => Promise.reject(locked())) });
    render(<ShellContainer route={bids} api={api} />);
    expect(await screen.findByRole('heading', { name: 'You have no seat right now' })).toBeTruthy();
    expect(screen.getByText('Your plan has no seat for you.')).toBeTruthy();
    expect(screen.getByText('Signed in as dana@northbridge.example.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Account menu for Dana Reyes' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Bid tabs' })).toBeNull();
  });

  it('Check again reloads the organization and returns to the app when a seat is free', async () => {
    const getOrg = vi.fn().mockRejectedValueOnce(locked()).mockResolvedValue(orgPayload());
    render(<ShellContainer route={bids} api={mockApi({ getOrg })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: 'Account menu for Dana Reyes' })).toBeTruthy();
    expect(getOrg).toHaveBeenCalledTimes(2);
  });

  it('Check again keeps the screen when there is still no seat', async () => {
    const getOrg = vi.fn(async () => Promise.reject(locked()));
    render(<ShellContainer route={bids} api={mockApi({ getOrg })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(getOrg).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('Sign out calls the API and goes to log in', async () => {
    const api = mockApi({ getOrg: vi.fn(async () => Promise.reject(locked())) });
    render(<ShellContainer route={bids} api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(api.logOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
  });

  it('a plain 403 still means no organization', async () => {
    const api = mockApi({ getOrg: vi.fn(async () => Promise.reject(new ApiError('No organization', 403))) });
    render(<ShellContainer route={bids} api={api} />);
    expect(await screen.findByRole('button', { name: 'Account menu for Dana Reyes' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'You have no seat right now' })).toBeNull();
  });

  it('reloads once, without looping, when a seat is lost while the app is open', async () => {
    let lost = false;
    const getOrg = vi.fn(async () => {
      if (!lost) return orgPayload();
      // The api client tells listeners about every 403 seat_locked, as the real request core does.
      notifySeatLocked();
      return Promise.reject(locked());
    });
    render(<ShellContainer route={bids} api={mockApi({ getOrg })} />);
    expect(await screen.findByRole('button', { name: 'Account menu for Dana Reyes' })).toBeTruthy();
    expect(getOrg).toHaveBeenCalledTimes(1);
    lost = true;
    act(() => notifySeatLocked());
    expect(await screen.findByRole('heading', { name: 'You have no seat right now' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getOrg).toHaveBeenCalledTimes(2);
    act(() => notifySeatLocked());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getOrg).toHaveBeenCalledTimes(2);
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
      detailHost: null,
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

describe('invite hand-off', () => {
  const CODE = `${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}.${'b'.repeat(64)}`;
  const bids = { kind: 'page', page: 'bids' } as const;
  const noOrg = () => new ApiError('No organization', 403);

  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    setToken(null);
    vi.unstubAllGlobals();
  });

  it('a signed-in user with no organization and a waiting code goes to #/invite once per session', async () => {
    savePendingInvite(CODE);
    const api = mockApi({ getOrg: vi.fn(async () => Promise.reject(noOrg())) });
    render(<ShellContainer route={bids} api={api} />);
    await waitFor(() => expect(window.location.hash).toBe('#/invite'));
    cleanup();
    window.location.hash = '#/bids';
    render(<ShellContainer route={bids} api={api} />);
    expect(await screen.findByRole('button', { name: 'Account menu for Dana Reyes' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.location.hash).toBe('#/bids');
  });

  it('without a waiting code, no organization stays on the organization page', async () => {
    const api = mockApi({ getOrg: vi.fn(async () => Promise.reject(noOrg())) });
    render(<ShellContainer route={bids} api={api} />);
    expect(await screen.findByRole('button', { name: 'Account menu for Dana Reyes' })).toBeTruthy();
    expect(window.location.hash).toBe('');
  });

  it('AppRoot sends a user who logs in with a waiting code to #/invite', async () => {
    savePendingInvite(CODE);
    window.location.hash = '#/login';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/api/auth/login')
      ? jsonResponse(200, { token: 'tok' })
      : jsonResponse(200, meDto()))));
    render(<AppRoot />);
    await userEvent.type(await screen.findByLabelText('Work email'), 'dana@northbridge.example');
    await userEvent.type(screen.getByLabelText('Password'), 'a long enough password');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(window.location.hash).toBe('#/invite'));
  });
});

describe('ShellContainer seat-locked on a bid', () => {
  it('loads no bid and does not poll while the member has no seat', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getBid = vi.fn(async () => bidDto());
    const listJobs = vi.fn(async () => [jobDto({ status: 'running' })]);
    const api = mockApi({
      getOrg: vi.fn(async () => Promise.reject(new ApiError('Your plan has no seat for you.', 403, 'seat_locked'))),
      getBid,
      listJobs,
    });
    render(<ShellContainer route={outline} api={api} />);
    expect(await screen.findByRole('heading', { name: 'You have no seat right now' })).toBeTruthy();
    // The first bid load starts with the shell's, before the 403 is known; after it, nothing more.
    const bidCalls = getBid.mock.calls.length;
    const jobCalls = listJobs.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getBid.mock.calls.length).toBe(bidCalls);
    expect(listJobs.mock.calls.length).toBe(jobCalls);
  });
});

describe('ShellContainer row detail host', () => {
  /** A tab that opted in: it portals its detail into the shell's host. */
  function DetailTab({ tab, selectedRowId }: TabScreenProps) {
    const detail = useDetailPortal(<p>Detail for {selectedRowId}</p>);
    return (
      <>
        <p>{tab} body</p>
        {selectedRowId && detail}
      </>
    );
  }
  /** A registered tab that did not opt in: it gets no host, so its portal renders nothing. */
  function PlainTab({ tab, selectedRowId }: TabScreenProps) {
    const detail = useDetailPortal(<p>Plain detail</p>);
    return (
      <>
        <p>{tab} body</p>
        {selectedRowId && detail}
      </>
    );
  }
  const registry = collectRoutes({
    '../a/route.tsx': {
      routes: [
        { tab: 'compliance', Component: DetailTab, rowDetail: true },
        { tab: 'overview', Component: PlainTab },
      ],
    },
  });
  const detailAsides = () => screen.queryAllByRole('complementary', { name: 'Row detail' });
  const at = (tab: 'compliance' | 'overview' | 'documents', rowId: string | null) => ({ kind: 'tab', bidId: 'bid-1', tab, rowId }) as const;

  it('renders one host for an opted-in tab with a row selected, and the detail lands in it, outside .app-shell', async () => {
    const api = mockApi();
    const { rerender } = render(<ShellContainer route={at('compliance', 'req-1')} api={api} registry={registry} />);
    const detail = await screen.findByText('Detail for req-1');
    expect(detailAsides()).toHaveLength(1);
    expect(detailAsides()[0]!.contains(detail)).toBe(true);
    expect(detail.closest('.app-shell')).toBeNull();
    expect(document.querySelector('.app-shell')).toBeNull();
    // Another row keeps the one host.
    rerender(<ShellContainer route={at('compliance', 'req-2')} api={api} registry={registry} />);
    expect(await screen.findByText('Detail for req-2')).toBeTruthy();
    expect(detailAsides()).toHaveLength(1);
    expect(screen.queryByText('Detail for req-1')).toBeNull();
    // No row: no host.
    rerender(<ShellContainer route={at('compliance', null)} api={api} registry={registry} />);
    await waitFor(() => expect(detailAsides()).toHaveLength(0));
    expect(screen.getByText('compliance body')).toBeTruthy();
  });

  it('gives no host to a registered tab that did not opt in', async () => {
    render(<ShellContainer route={at('overview', 'fact-1')} api={mockApi()} registry={registry} />);
    expect(await screen.findByText('overview body')).toBeTruthy();
    expect(detailAsides()).toHaveLength(0);
    expect(screen.queryByText('Plain detail')).toBeNull();
  });

  it('leaves legacy tabs (Workspace) without a host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, [])));
    render(<ShellContainer route={at('documents', 'doc-1')} api={mockApi()} registry={registry} />);
    await waitFor(() => expect(document.querySelector('.app-shell')).toBeTruthy());
    expect(detailAsides()).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('draws no host while the bid could not be loaded', async () => {
    const api = mockApi({ getBid: vi.fn(async () => Promise.reject(new ApiError('Bid not found.', 404))) });
    render(<ShellContainer route={at('compliance', 'req-1')} api={api} registry={registry} />);
    expect(await screen.findByText('Bid not found.')).toBeTruthy();
    expect(detailAsides()).toHaveLength(0);
  });
});

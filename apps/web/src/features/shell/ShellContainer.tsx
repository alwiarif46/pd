import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { isAbortError } from '@/api';
import { Button } from '@/components/ui/button';
import type { OutsidePage, Tab, UpgradeReason } from '@/types';
import { EmptyState } from '@/ui/common/EmptyState';
import { AppShell } from '@/ui/shell/AppShell';
import { ConfirmDialog } from '@/ui/shell/ConfirmDialog';
import { UpgradeDialog } from '@/ui/shell/UpgradeDialog';
import { Account, BidsHome, NewBid, Organization, Privacy } from '@/screens/Outside';
import { Workspace } from '@/screens/Workspace';
import { summarizeOrg, type OrgSummary } from '@/features/shared/credits';
import { messageOf } from '@/features/shared/messages';
import { TabFrameContainer } from '@/features/tab-frame/TabFrameContainer';
import { tabSignals } from '@/features/tab-frame/derive';
import { ShellContext, type ConfirmOptions, type ShellContextValue } from './bid-context';
import {
  jobsKey,
  loadBid,
  placeholderShellBid,
  loadShell,
  localDayOf,
  needsPolling,
  pollDelay,
  shellApi,
  toShellBid,
  upgradeAction,
  userOf,
  type BidData,
  type ShellApi,
  type ShellData,
} from './controller';
import { LegacyFrame } from './LegacyFrame';
import type { PageKey } from './registry';
import { activePageOf, isPaidTab, pageHref, TAB_TITLES, tabHref, type AppRoute } from './routes';
import { screens } from './screens';

type ShellState = { kind: 'loading' } | { kind: 'error'; message: string } | ShellData;
type BidState = { bidId: string; data: BidData | null; error: string | null; failures: number };
type ConfirmState = { open: boolean; options: ConfirmOptions; key: number };

interface Props {
  route: Exclude<AppRoute, { kind: 'auth' }>;
  /** Test seam; defaults to the typed client. */
  api?: ShellApi;
  /** Test seam: leaves the app for Stripe. Defaults to `window.location.assign`. */
  leaveTo?: (url: string) => void;
}

function go(hash: string) {
  window.location.hash = hash;
}

function assign(url: string) {
  window.location.assign(url);
}

/**
 * Changes the hash without a history entry (selecting a row should not make Back walk through rows), then
 * tells AppRoot, which follows `hashchange`, that the route changed.
 */
function replaceHash(hash: string) {
  window.history.replaceState(window.history.state, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Padding for v0 pages outside a bid (the bids list and new bid). */
function PageFrame({ children }: { children: ReactNode }) {
  return <div className="p-6">{children}</div>;
}

/**
 * The signed-in app: loads the user, the organization and the bids, and inside a bid the bid, its files,
 * jobs and amendment links; renders v0's AppShell around the screen for the route, and owns the upgrade
 * dialog, the confirm dialog and the session. Polls every 3 s while anything on the bid is queued or
 * running, never when idle; reloads on window focus and after every change (`refresh`).
 */
export function ShellContainer({ route, api = shellApi, leaveTo = assign }: Props) {
  const [shell, setShell] = useState<ShellState>({ kind: 'loading' });
  const [shellVersion, setShellVersion] = useState(0);
  const [bidState, setBidState] = useState<BidState | null>(null);
  const [bidVersion, setBidVersion] = useState(0);
  const [upgrade, setUpgrade] = useState<{ open: boolean; reason: UpgradeReason }>({ open: false, reason: 'plan' });
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    open: false,
    options: { title: '', body: '', confirmLabel: '' },
    key: 0,
  });
  const resolveConfirm = useRef<((ok: boolean) => void) | null>(null);

  const bidId = route.kind === 'tab' ? route.bidId : null;
  const tab: Tab | null = route.kind === 'tab' ? route.tab : null;
  const rowId = route.kind === 'tab' ? route.rowId : null;

  // The organization, the user and the bid list. Reloaded on refresh and when the open bid changes (a
  // new bid then joins the switcher). A failed reload keeps what is shown.
  useEffect(() => {
    const abort = new AbortController();
    loadShell(api, abort.signal).then(
      (data) => {
        if (!abort.signal.aborted) setShell(data);
      },
      (error: unknown) => {
        if (abort.signal.aborted || isAbortError(error)) return;
        setShell((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', message: messageOf(error) }));
      },
    );
    return () => abort.abort();
  }, [api, shellVersion, bidId]);

  // The open bid. Requests for a bid the user has left are aborted. A failed reload keeps the data shown
  // and counts the failure, which re-arms polling with a longer wait.
  useEffect(() => {
    if (!bidId) return;
    const abort = new AbortController();
    loadBid(api, bidId, abort.signal).then(
      (data) => {
        if (!abort.signal.aborted) setBidState({ bidId, data, error: null, failures: 0 });
      },
      (error: unknown) => {
        if (abort.signal.aborted || isAbortError(error)) return;
        setBidState((prev) =>
          prev && prev.bidId === bidId && prev.data
            ? { ...prev, failures: prev.failures + 1 }
            : { bidId, data: null, error: messageOf(error), failures: 0 },
        );
      },
    );
    return () => abort.abort();
  }, [api, bidId, bidVersion]);

  const bidData = bidState && bidState.bidId === bidId ? bidState.data : null;
  const bidError = bidState && bidState.bidId === bidId ? bidState.error : null;
  const pollFailures = bidState && bidState.bidId === bidId ? bidState.failures : 0;

  const refresh = useCallback(() => {
    setShellVersion((n) => n + 1);
    setBidVersion((n) => n + 1);
  }, []);

  // Poll while something is queued or running: one request set at a time, 3 s after the last answer
  // (longer after failed polls, up to 10 s). A success or a failure each re-arms the timer.
  const polling = needsPolling(bidData);
  useEffect(() => {
    if (!polling) return;
    const timer = window.setTimeout(() => setBidVersion((n) => n + 1), pollDelay(pollFailures));
    return () => window.clearTimeout(timer);
  }, [polling, bidData, pollFailures]);

  // When processing ends, credits may have been consumed: reload the organization once.
  const wasPolling = useRef(false);
  useEffect(() => {
    if (wasPolling.current && !polling) setShellVersion((n) => n + 1);
    wasPolling.current = polling;
  }, [polling]);

  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const openUpgrade = useCallback((reason: UpgradeReason) => setUpgrade({ open: true, reason }), []);

  const confirm = useCallback((options: ConfirmOptions) => {
    resolveConfirm.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveConfirm.current = resolve;
      // A new key per opening remounts v0's ConfirmDialog, which otherwise keeps the text typed last time.
      setConfirmState((prev) => ({ open: true, options, key: prev.key + 1 }));
    });
  }, []);

  /** v0's AlertDialogAction also closes the dialog, which calls onCancel after onConfirm: the first answer wins. */
  function answerConfirm(ok: boolean) {
    const resolve = resolveConfirm.current;
    resolveConfirm.current = null;
    resolve?.(ok);
    setConfirmState((prev) => ({ ...prev, open: false }));
  }

  // A confirm still open when the shell goes away (sign out, 401) answers "cancel".
  useEffect(
    () => () => {
      resolveConfirm.current?.(false);
      resolveConfirm.current = null;
    },
    [],
  );

  const signOut = useCallback(() => {
    void api.logOut().finally(() => go('#/login'));
  }, [api]);

  // One Checkout or portal request at a time: a double click must not open two Checkout sessions.
  const upgrading = useRef(false);
  function choosePlan(plan: 'starter' | 'growth') {
    if (upgrading.current) return;
    upgrading.current = true;
    void upgradeAction(api, plan).then((outcome) => {
      if (outcome.kind === 'redirect') {
        leaveTo(outcome.url);
        return;
      }
      upgrading.current = false;
      setUpgrade((prev) => ({ ...prev, open: false }));
      toast.info(outcome.message);
    });
  }

  const openRow = useCallback(
    (id: string | null) => {
      if (bidId && tab) replaceHash(tabHref(bidId, tab, id));
    },
    [bidId, tab],
  );

  const ready = shell.kind === 'ready' ? shell : null;
  const summary = useMemo(() => (ready ? summarizeOrg(ready.org, new Date()) : null), [ready]);

  const context = useMemo<ShellContextValue | null>(() => {
    if (!ready || !summary) return null;
    return {
      me: ready.me,
      org: ready.org,
      summary,
      bids: ready.bids,
      bidId,
      tab,
      bid: bidData?.bid ?? null,
      docs: bidData?.docs ?? [],
      jobs: bidData?.jobs ?? [],
      links: bidData?.links ?? [],
      bidLoaded: bidData !== null,
      selectedRowId: rowId,
      refresh,
      openRow,
      openUpgrade,
      confirm,
    };
  }, [ready, summary, bidId, tab, bidData, rowId, refresh, openRow, openUpgrade, confirm]);

  const dialogs = (
    <ConfirmDialog
      key={confirmState.key}
      open={confirmState.open}
      title={confirmState.options.title}
      body={confirmState.options.body}
      confirmLabel={confirmState.options.confirmLabel}
      typeToConfirm={confirmState.options.typeToConfirm ?? null}
      busy={false}
      onConfirm={() => answerConfirm(true)}
      onCancel={() => answerConfirm(false)}
    />
  );

  if (shell.kind === 'loading') {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        Loading...
      </p>
    );
  }
  if (shell.kind === 'error') {
    return (
      <div role="alert" className="flex max-w-md flex-col items-start gap-3 p-6 text-ink">
        <p className="text-sm text-due">{shell.message}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setShell({ kind: 'loading' });
            setShellVersion((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  function legacyPage(page: PageKey): ReactNode {
    switch (page) {
      case 'organization':
        return <Organization onChanged={refresh} />;
      case 'account':
        return <Account />;
      case 'privacy':
        return <Privacy />;
      case 'new_bid':
        return <NewBid onCreated={(id) => go(tabHref(id, 'documents'))} />;
      case 'bids':
        return <BidsHome onOpen={(id) => go(tabHref(id, 'overview'))} />;
    }
  }

  // Signed in without an organization: the legacy organization page creates one (v0's lands in PR6).
  if (shell.kind === 'no_org') {
    const page = route.kind === 'page' && (route.page === 'account' || route.page === 'privacy') ? route.page : 'organization';
    return (
      <AppShell
        bid={null}
        bids={[]}
        activeTab={null}
        activePage={page}
        plan="free"
        creditsLeft={0}
        creditsResetOn=""
        oralsEnabled={false}
        tabSignals={[]}
        user={userOf(shell.me)}
        detail={null}
        onSelectTab={() => undefined}
        onSwitchBid={() => undefined}
        onOpenPage={(next: OutsidePage) => go(pageHref(next))}
        onUpgrade={() => undefined}
        onSignOut={signOut}
      >
        <LegacyFrame>{legacyPage(page)}</LegacyFrame>
      </AppShell>
    );
  }

  const current = shell;
  const ctx = context as ShellContextValue;
  const org = summary as OrgSummary;
  const listed = bidId ? (current.bids.find((bid) => bid.id === bidId) ?? null) : null;
  const bidDto = bidData?.bid ?? listed;
  const signals = bidData ? tabSignals(bidData.docs, bidData.jobs, bidData.links) : [];
  const oralsEnabled = bidDto?.oralsEnabled ?? false;

  function content(): ReactNode {
    if (route.kind !== 'tab') {
      const key: PageKey = route.kind === 'new_bid' ? 'new_bid' : route.page;
      const Registered = screens.pages.get(key);
      if (Registered) {
        return (
          <PageFrame>
            <Registered />
          </PageFrame>
        );
      }
      return <LegacyFrame>{legacyPage(key)}</LegacyFrame>;
    }
    if (bidError) {
      return (
        <PageFrame>
          <div role="alert" className="flex max-w-md flex-col items-start gap-3 text-ink">
            <p className="text-sm text-due">{bidError}</p>
            <Button type="button" variant="outline" onClick={() => go(pageHref('bids'))}>
              Open the bid list
            </Button>
          </div>
        </PageFrame>
      );
    }
    // A paid tab on Free: the shell draws the locked state; no tab screen loads.
    if (org.plan === 'free' && isPaidTab(route.tab)) {
      return (
        <TabFrameContainer tab={route.tab} title={TAB_TITLES[route.tab]}>
          {null}
        </TabFrameContainer>
      );
    }
    // Orals is hidden from the tab list while it is off for the bid; a typed or stale link says so.
    if (route.tab === 'orals' && bidDto && !bidDto.oralsEnabled) {
      const settings = tabHref(route.bidId, 'settings');
      return (
        <PageFrame>
          <EmptyState
            title="Orals is off for this bid"
            text="Turn on Orals in the bid's settings to plan the oral presentation."
            action={{ label: 'Open settings', onClick: () => go(settings) }}
          />
        </PageFrame>
      );
    }
    const Registered = screens.tabs.get(route.tab);
    if (Registered) return <Registered bidId={route.bidId} tab={route.tab} selectedRowId={route.rowId} />;
    return (
      <LegacyFrame>
        <Workspace
          embedded
          bidId={route.bidId}
          tab={route.tab}
          bids={[]}
          org={current.org}
          onTab={(next) => go(tabHref(route.bidId, next))}
          onSwitch={(id) => go(tabHref(id, route.tab))}
          onChanged={refresh}
          refreshKey={jobsKey(bidData)}
        />
      </LegacyFrame>
    );
  }

  const switcherBids = current.bids.map((bid) => ({ id: bid.id, name: bid.name }));

  return (
    <ShellContext.Provider value={ctx}>
      <AppShell
        bid={bidId ? (bidDto ? toShellBid(bidDto) : placeholderShellBid(bidId, bidError !== null)) : null}
        bids={switcherBids}
        activeTab={tab}
        activePage={activePageOf(route)}
        plan={org.plan}
        creditsLeft={org.creditsLeft}
        creditsResetOn={localDayOf(org.creditsResetOn)}
        oralsEnabled={oralsEnabled}
        tabSignals={signals}
        user={userOf(current.me)}
        detail={null}
        onSelectTab={(next) => {
          if (bidId) go(tabHref(bidId, next));
        }}
        onSwitchBid={(id) => go(tabHref(id, tab ?? 'overview'))}
        onOpenPage={(page: OutsidePage) => go(pageHref(page))}
        onUpgrade={() => openUpgrade('locked_tab')}
        onSignOut={signOut}
      >
        {content()}
      </AppShell>
      <UpgradeDialog
        open={upgrade.open}
        reason={upgrade.reason}
        plan={org.plan}
        creditsLeft={org.creditsLeft}
        creditsResetOn={org.creditsResetOn}
        onChoosePlan={choosePlan}
        onClose={() => setUpgrade((prev) => ({ ...prev, open: false }))}
      />
      {dialogs}
    </ShellContext.Provider>
  );
}

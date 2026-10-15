import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { isAbortError } from '@/api';
import { Button } from '@/components/ui/button';
import type { OutsidePage, Tab, UpgradeReason } from '@/types';
import { AppShell } from '@/ui/shell/AppShell';
import { ConfirmDialog } from '@/ui/shell/ConfirmDialog';
import { UpgradeDialog } from '@/ui/shell/UpgradeDialog';
import { Account, BidsHome, NewBid, Organization, Privacy } from '@/screens/Outside';
import { Workspace } from '@/screens/Workspace';
import { summarizeOrg, type OrgSummary } from '@/features/shared/credits';
import { messageOf } from '@/features/shared/messages';
import { TabFrameContainer } from '@/features/tab-frame/TabFrameContainer';
import { SIGNAL_LABELS, tabSignals } from '@/features/tab-frame/derive';
import { ShellContext, type ConfirmOptions, type ShellContextValue } from './bid-context';
import {
  jobsKey,
  loadBid,
  placeholderShellBid,
  loadShell,
  needsPolling,
  POLL_MS,
  shellApi,
  toShellBid,
  upgradeAction,
  userOf,
  type BidData,
  type ShellApi,
  type ShellData,
} from './controller';
import { InterimUserBar, type InterimTab } from './InterimUserBar';
import { LegacyFrame } from './LegacyFrame';
import type { PageKey } from './registry';
import { activePageOf, isPaidTab, pageHref, TAB_TITLES, TABS, tabHref, type AppRoute } from './routes';
import { screens } from './screens';

type ShellState = { kind: 'loading' } | { kind: 'error'; message: string } | ShellData;
type BidState = { bidId: string; data: BidData | null; error: string | null };
type ConfirmState = { open: boolean; options: ConfirmOptions; key: number };

interface Props {
  route: Exclude<AppRoute, { kind: 'auth' }>;
  /** Test seam; defaults to the typed client. */
  api?: ShellApi;
}

function go(hash: string) {
  window.location.hash = hash;
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
export function ShellContainer({ route, api = shellApi }: Props) {
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
    loadShell(api, abort.signal).then(setShell, (error: unknown) => {
      if (isAbortError(error)) return;
      setShell((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', message: messageOf(error) }));
    });
    return () => abort.abort();
  }, [api, shellVersion, bidId]);

  // The open bid. Requests for a bid the user has left are aborted.
  useEffect(() => {
    if (!bidId) return;
    const abort = new AbortController();
    loadBid(api, bidId, abort.signal).then(
      (data) => setBidState({ bidId, data, error: null }),
      (error: unknown) => {
        if (isAbortError(error)) return;
        setBidState((prev) =>
          prev && prev.bidId === bidId && prev.data ? prev : { bidId, data: null, error: messageOf(error) },
        );
      },
    );
    return () => abort.abort();
  }, [api, bidId, bidVersion]);

  const bidData = bidState && bidState.bidId === bidId ? bidState.data : null;
  const bidError = bidState && bidState.bidId === bidId ? bidState.error : null;

  const refresh = useCallback(() => {
    setShellVersion((n) => n + 1);
    setBidVersion((n) => n + 1);
  }, []);

  // Poll while something is queued or running: one request set at a time, 3 s after the last answer.
  const polling = needsPolling(bidData);
  useEffect(() => {
    if (!polling) return;
    const timer = window.setTimeout(() => setBidVersion((n) => n + 1), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [polling, bidData]);

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

  const signOut = useCallback(() => {
    void api.logOut().finally(() => go('#/login'));
  }, [api]);

  const openRow = useCallback(
    (id: string | null) => {
      if (bidId && tab) go(tabHref(bidId, tab, id));
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
      <div className="min-h-screen bg-canvas">
        <InterimUserBar
          inBid={null}
          signalLabels={SIGNAL_LABELS}
          onSwitchBid={() => undefined}
          onSelectTab={() => undefined}
          onOpenPage={(p) => go(pageHref(p))}
          onUpgrade={null}
          onSignOut={signOut}
        />
        <LegacyFrame>{legacyPage(page)}</LegacyFrame>
      </div>
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

  const interimTabs: InterimTab[] = TABS.filter((item) => oralsEnabled || item !== 'orals').map((item) => ({
    tab: item,
    label: TAB_TITLES[item],
    locked: org.plan === 'free' && isPaidTab(item),
    signal: signals.find((s) => s.tab === item)?.signal ?? null,
  }));
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
        creditsResetOn={org.creditsResetOn}
        oralsEnabled={oralsEnabled}
        tabSignals={signals}
        user={userOf(current.me)}
        detail={null}
        onSelectTab={(next) => {
          if (bidId) go(tabHref(bidId, next));
        }}
        onSwitchBid={(id) => go(tabHref(id, tab ?? 'overview'))}
        onOpenPage={(page: OutsidePage) => go(pageHref(page))}
        onUpgrade={() => openUpgrade('plan')}
        onSignOut={signOut}
      >
        <InterimUserBar
          inBid={bidId && tab ? { bids: switcherBids, bidId, tab, tabs: interimTabs } : null}
          signalLabels={SIGNAL_LABELS}
          onSwitchBid={(id) => go(tabHref(id, tab ?? 'overview'))}
          onSelectTab={(next) => {
            if (bidId) go(tabHref(bidId, next));
          }}
          onOpenPage={(page) => go(pageHref(page))}
          onUpgrade={org.plan === 'free' ? () => openUpgrade('plan') : null}
          onSignOut={signOut}
        />
        {content()}
      </AppShell>
      <UpgradeDialog
        open={upgrade.open}
        reason={upgrade.reason}
        plan={org.plan}
        creditsLeft={org.creditsLeft}
        creditsResetOn={org.creditsResetOn}
        onChoosePlan={(plan) => {
          void upgradeAction(api, plan).then((outcome) => {
            if (outcome.kind === 'redirect') {
              window.location.assign(outcome.url);
              return;
            }
            setUpgrade((prev) => ({ ...prev, open: false }));
            toast.info(outcome.message);
          });
        }}
        onClose={() => setUpgrade((prev) => ({ ...prev, open: false }))}
      />
      {dialogs}
    </ShellContext.Provider>
  );
}

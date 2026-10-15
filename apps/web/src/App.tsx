import { useEffect, useState } from 'react';
import { ApiError, api, setToken, token } from './legacy-api';
import type { Bid, OrgPayload, TabId } from './models';
import { AuthContainer } from './features/auth/AuthContainer';
import { BidsContainer } from './features/bids/BidsContainer';
import { NewBidContainer } from './features/bids/NewBidContainer';
import { TempFrame } from './features/bids/TempFrame';
import { Toaster } from './components/ui/sonner';
import { Account, Organization, Privacy } from './screens/Outside';
import { Workspace } from './screens/Workspace';

type Route =
  | { name: 'login' | 'signup' | 'verify' | 'reset' | 'privacy' | 'bids' | 'new' | 'org' | 'account' }
  | { name: 'bid'; id: string; tab: TabId };

const TAB_IDS: TabId[] = ['overview', 'schedule', 'compliance', 'outline', 'resumes', 'reviews', 'production', 'orals', 'lessons', 'documents', 'settings'];

function isTab(value: string | undefined): value is TabId {
  return TAB_IDS.includes(value as TabId);
}

function parseRoute(): Route {
  const parts = window.location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const [head, second, third] = parts;
  if (head === 'signup' || head === 'verify' || head === 'reset' || head === 'privacy') return { name: head };
  if (head === 'org') return { name: 'org' };
  if (head === 'account') return { name: 'account' };
  if (head === 'bids' && second === 'new') return { name: 'new' };
  if (head === 'bids' && second) return { name: 'bid', id: second, tab: isTab(third) ? third : 'overview' };
  if (head === 'bids') return { name: 'bids' };
  if (head === 'login') return { name: 'login' };
  return token() ? { name: 'bids' } : { name: 'login' };
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [org, setOrg] = useState<OrgPayload | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const signedIn = Boolean(token());

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!signedIn || route.name === 'login') return;
    api<OrgPayload>('/api/org').then(setOrg).catch((err: Error) => {
      if (err instanceof ApiError && err.status === 403) {
        setOrg({ org: null, credits: null, role: 'owner' });
      } else {
        setOrg(null);
      }
    });
    api<Bid[]>('/api/bids').then(setBids).catch(() => setBids([]));
  }, [signedIn, route.name]);

  function logout() {
    api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setToken(null);
    window.location.hash = '#/login';
  }

  const isAuthRoute = route.name === 'login' || route.name === 'signup' || route.name === 'verify' || route.name === 'reset';
  // Auth screens render outside `.app-shell` (v0 styles, no legacy CSS). Signed-out visitors
  // see them everywhere except the privacy page.
  if (isAuthRoute || (!signedIn && route.name !== 'privacy')) {
    return <AuthContainer onSignedIn={() => { window.location.hash = '#/bids'; }} />;
  }

  const credits = org?.credits;
  const left = credits ? credits.allowed - credits.used - credits.reserved : null;

  // The v0 bids screens render outside `.app-shell`, in TempFrame, until the shell replaces both. Only the
  // legacy header stays in `.app-shell` on those routes.
  const v0Page = signedIn && (route.name === 'bids' || route.name === 'new');

  return (
    <>
    {/* Toasts from the v0 screens' containers; outside .app-shell so the reset and v0 tokens apply. */}
    <Toaster />
    <div className="app-shell" style={v0Page ? { minHeight: 0 } : undefined}>
      <header className="topbar">
        <a className="brand" href={signedIn ? '#/bids' : '#/login'}>Proposal Development</a>
        <span className="grow" />
        {signedIn && left !== null ? <span className="num small">RFP credits left {left}</span> : null}
        {signedIn ? (
          <nav className="row" aria-label="Account">
            <a href="#/org">Organization</a>
            <a href="#/account">Account</a>
            <button type="button" onClick={logout}>Log out</button>
          </nav>
        ) : null}
      </header>
      {route.name === 'privacy' ? <Privacy /> : null}
      {signedIn && route.name === 'org' ? <Organization /> : null}
      {signedIn && route.name === 'account' ? <Account /> : null}
      {signedIn && route.name === 'bid' ? (
        <Workspace
          bidId={route.id}
          tab={route.tab}
          bids={bids}
          org={org}
          onTab={(tab) => { window.location.hash = `#/bids/${route.id}/${tab}`; }}
          onSwitch={(id) => { window.location.hash = `#/bids/${id}/${route.tab}`; }}
        />
      ) : null}
    </div>
    {v0Page ? (
      <TempFrame>{route.name === 'bids' ? <BidsContainer /> : <NewBidContainer />}</TempFrame>
    ) : null}
    </>
  );
}

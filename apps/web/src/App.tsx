import Preview from './Preview';
import { useEffect, useState } from 'react';
import { ApiError, api, setToken, token } from './api';
import type { Bid, OrgPayload, TabId } from './models';
import { Account, AuthPage, BidsHome, NewBid, Organization, Privacy } from './screens/Outside';
import { Workspace } from './screens/Workspace';

type Route =
  | { name: 'login' | 'signup' | 'verify' | 'reset' | 'privacy' | 'bids' | 'new' | 'org' | 'account' }
  | { name: 'bid'; id: string; tab: TabId };

const TAB_IDS: TabId[] = ['overview', 'schedule', 'compliance', 'outline', 'resumes', 'reviews', 'production', 'orals', 'lessons', 'documents', 'settings'];

function isTab(value: string | undefined): value is TabId {
  return TAB_IDS.includes(value as TabId);
}

function parseRoute(): Route {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
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
  return <Preview />;
  /*
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

  const credits = org?.credits;
  const left = credits ? credits.allowed - credits.used - credits.reserved : null;

  return (
    <div className="app-shell">
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
      {route.name === 'login' || route.name === 'signup' || route.name === 'verify' || route.name === 'reset' ? (
        <AuthPage mode={route.name} onDone={() => { window.location.hash = '#/bids'; }} />
      ) : null}
      {route.name === 'privacy' ? <Privacy /> : null}
      {!signedIn && route.name !== 'login' && route.name !== 'signup' && route.name !== 'verify' && route.name !== 'reset' && route.name !== 'privacy' ? (
        <AuthPage mode="login" onDone={() => { window.location.hash = '#/bids'; }} />
      ) : null}
      {signedIn && route.name === 'bids' ? <BidsHome onOpen={(id) => { window.location.hash = `#/bids/${id}/overview`; }} /> : null}
      {signedIn && route.name === 'new' ? <NewBid onCreated={(id) => { window.location.hash = `#/bids/${id}/documents`; }} /> : null}
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
  );
  */
}

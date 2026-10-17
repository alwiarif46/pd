import type { OutsidePage, Plan, Tab } from '@/types';

/**
 * The app's hash routes. The hashes are the ones the app has always used:
 *   #/login #/signup #/verify #/reset          auth (AuthContainer parses its own token)
 *   #/invite[?token=<code>]                    join an organization from an invite (signed in or out)
 *   #/bids #/bids/new #/org #/account #/privacy outside a bid
 *   #/bids/:id/:tab[?row=<rowId>]              inside a bid; `row` is the selected row
 * Pure: no window access, so it is tested in node.
 */
export type AppRoute =
  | { kind: 'auth' }
  | { kind: 'invite' }
  | { kind: 'page'; page: OutsidePage }
  | { kind: 'new_bid' }
  | { kind: 'tab'; bidId: string; tab: Tab; rowId: string | null };

export const TABS: readonly Tab[] = [
  'overview',
  'schedule',
  'compliance',
  'outline',
  'resumes',
  'reviews',
  'production',
  'orals',
  'lessons',
  'documents',
  'settings',
];

export const TAB_TITLES: Record<Tab, string> = {
  overview: 'Overview',
  schedule: 'Schedule',
  compliance: 'Compliance',
  outline: 'Outline',
  resumes: 'Resumes',
  reviews: 'Reviews',
  production: 'Production',
  orals: 'Orals',
  lessons: 'Lessons',
  documents: 'Documents',
  settings: 'Settings',
};

/** 09 s5.1 `PAID_TABS`: locked on the free plan. */
export const PAID_TABS: readonly Tab[] = ['outline', 'resumes', 'reviews', 'production', 'orals', 'lessons'];

export function isTab(value: string | undefined): value is Tab {
  return TABS.includes(value as Tab);
}

export function isPaidTab(tab: Tab): boolean {
  return PAID_TABS.includes(tab);
}

const AUTH_HEADS = new Set(['login', 'signup', 'verify', 'reset']);

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parses a location hash. An unknown or empty hash goes to the bids list when signed in and to log in
 * otherwise. An unknown tab inside a bid falls back to `overview`.
 */
export function parseRoute(hash: string, signedIn: boolean): AppRoute {
  const body = hash.replace(/^#\/?/, '');
  const queryAt = body.indexOf('?');
  const path = queryAt === -1 ? body : body.slice(0, queryAt);
  const query = new URLSearchParams(queryAt === -1 ? '' : body.slice(queryAt + 1));
  const [head, second, third] = path.split('/').filter(Boolean);

  if (head === 'invite') return { kind: 'invite' };
  if (head && AUTH_HEADS.has(head)) return { kind: 'auth' };
  if (head === 'privacy') return { kind: 'page', page: 'privacy' };
  if (head === 'org') return { kind: 'page', page: 'organization' };
  if (head === 'account') return { kind: 'page', page: 'account' };
  if (head === 'bids' && second === 'new') return { kind: 'new_bid' };
  if (head === 'bids' && second) {
    const row = query.get('row');
    return { kind: 'tab', bidId: decode(second), tab: isTab(third) ? third : 'overview', rowId: row ? row : null };
  }
  if (head === 'bids') return { kind: 'page', page: 'bids' };
  return signedIn ? { kind: 'page', page: 'bids' } : { kind: 'auth' };
}

const PAGE_HASH: Record<OutsidePage, string> = {
  bids: '#/bids',
  organization: '#/org',
  account: '#/account',
  privacy: '#/privacy',
};

export function hrefFor(route: AppRoute): string {
  switch (route.kind) {
    case 'auth':
      return '#/login';
    case 'invite':
      return '#/invite';
    case 'page':
      return PAGE_HASH[route.page];
    case 'new_bid':
      return '#/bids/new';
    case 'tab': {
      const base = `#/bids/${encodeURIComponent(route.bidId)}/${route.tab}`;
      return route.rowId ? `${base}?row=${encodeURIComponent(route.rowId)}` : base;
    }
  }
}

export function tabHref(bidId: string, tab: Tab, rowId: string | null = null): string {
  return hrefFor({ kind: 'tab', bidId, tab, rowId });
}

export function pageHref(page: OutsidePage): string {
  return hrefFor({ kind: 'page', page });
}

/** The outside page a route belongs to (the new-bid screen counts as Bids), or null inside a bid. */
export function activePageOf(route: AppRoute): OutsidePage | null {
  if (route.kind === 'page') return route.page;
  if (route.kind === 'new_bid') return 'bids';
  return null;
}

/** What the shell draws as a tab's content (ShellContainer's content() and its row detail host both use it). */
export type TabBody = 'bid_error' | 'locked' | 'orals_off' | 'registered' | 'legacy';

/**
 * In order: the bid could not be loaded; a paid tab on Free (the locked state, 09 s5.1); Orals turned off for
 * the bid; the tab's registered screen; else the legacy Workspace.
 */
export function tabBodyOf(input: { tab: Tab; plan: Plan; bidError: string | null; oralsOff: boolean; registered: boolean }): TabBody {
  if (input.bidError) return 'bid_error';
  if (input.plan === 'free' && isPaidTab(input.tab)) return 'locked';
  if (input.tab === 'orals' && input.oralsOff) return 'orals_off';
  return input.registered ? 'registered' : 'legacy';
}

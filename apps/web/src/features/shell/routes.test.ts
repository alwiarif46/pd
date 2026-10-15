import { describe, expect, it } from 'vitest';
import { activePageOf, hrefFor, parseRoute, tabHref, type AppRoute } from './routes';

describe('parseRoute', () => {
  it.each([
    ['#/login', { kind: 'auth' }],
    ['#/signup', { kind: 'auth' }],
    ['#/verify?token=abc', { kind: 'auth' }],
    ['#/reset?token=abc', { kind: 'auth' }],
    ['#/bids', { kind: 'page', page: 'bids' }],
    ['#/bids/new', { kind: 'new_bid' }],
    ['#/org', { kind: 'page', page: 'organization' }],
    ['#/account', { kind: 'page', page: 'account' }],
    ['#/privacy', { kind: 'page', page: 'privacy' }],
    ['#/bids/b1/compliance', { kind: 'tab', bidId: 'b1', tab: 'compliance', rowId: null }],
    ['#/bids/b1/compliance?row=r9', { kind: 'tab', bidId: 'b1', tab: 'compliance', rowId: 'r9' }],
    ['#/bids/b1', { kind: 'tab', bidId: 'b1', tab: 'overview', rowId: null }],
    ['#/bids/b1/nonsense', { kind: 'tab', bidId: 'b1', tab: 'overview', rowId: null }],
    ['#/bids/a%20b/documents?row=', { kind: 'tab', bidId: 'a b', tab: 'documents', rowId: null }],
  ] as [string, AppRoute][])('%s', (hash, route) => {
    expect(parseRoute(hash, true)).toEqual(route);
  });

  it('sends an empty or unknown hash to the bids list when signed in, to log in otherwise', () => {
    expect(parseRoute('', true)).toEqual({ kind: 'page', page: 'bids' });
    expect(parseRoute('#/what', true)).toEqual({ kind: 'page', page: 'bids' });
    expect(parseRoute('', false)).toEqual({ kind: 'auth' });
    expect(parseRoute('#/what', false)).toEqual({ kind: 'auth' });
  });
});

describe('hrefFor', () => {
  it('round-trips every route', () => {
    const routes: AppRoute[] = [
      { kind: 'page', page: 'bids' },
      { kind: 'page', page: 'organization' },
      { kind: 'page', page: 'account' },
      { kind: 'page', page: 'privacy' },
      { kind: 'new_bid' },
      { kind: 'tab', bidId: 'b/1', tab: 'schedule', rowId: null },
      { kind: 'tab', bidId: 'b1', tab: 'compliance', rowId: 'row 7' },
    ];
    for (const route of routes) expect(parseRoute(hrefFor(route), true)).toEqual(route);
  });

  it('keeps the hashes the app has always used', () => {
    expect(hrefFor({ kind: 'page', page: 'organization' })).toBe('#/org');
    expect(hrefFor({ kind: 'auth' })).toBe('#/login');
    expect(tabHref('b1', 'documents')).toBe('#/bids/b1/documents');
    expect(tabHref('b1', 'compliance', 'r1')).toBe('#/bids/b1/compliance?row=r1');
  });
});

describe('activePageOf', () => {
  it('names the outside page; new bid counts as Bids; null inside a bid', () => {
    expect(activePageOf({ kind: 'page', page: 'account' })).toBe('account');
    expect(activePageOf({ kind: 'new_bid' })).toBe('bids');
    expect(activePageOf({ kind: 'tab', bidId: 'b', tab: 'overview', rowId: null })).toBeNull();
  });
});

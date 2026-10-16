import { describe, expect, it } from 'vitest';
import { collectRoutes } from './registry';
import { screens } from './screens';

const A = () => null;
const B = () => null;

describe('collectRoutes', () => {
  it('maps tabs and pages to their components', () => {
    const registry = collectRoutes({
      '../a/route.tsx': { routes: [{ tab: 'compliance', Component: A }] },
      '../b/route.tsx': { routes: [{ page: 'bids', Component: B }] },
      '../c/route.tsx': {},
    });
    expect(registry.tabs.get('compliance')).toBe(A);
    expect(registry.pages.get('bids')).toBe(B);
    expect(registry.tabs.has('overview')).toBe(false);
  });

  it('refuses a tab or page registered twice', () => {
    expect(() =>
      collectRoutes({
        '../a/route.tsx': { routes: [{ page: 'bids', Component: A }] },
        '../b/route.tsx': { routes: [{ page: 'bids', Component: B }] },
      }),
    ).toThrow(/registered twice/);
  });
});

describe('screens', () => {
  it('finds the bids, schedule, overview and settings screens through import.meta.glob', () => {
    expect(screens.pages.has('bids')).toBe(true);
    expect(screens.pages.has('new_bid')).toBe(true);
    expect(screens.tabs.has('schedule')).toBe(true);
    expect(screens.tabs.has('overview')).toBe(true);
    expect(screens.tabs.has('settings')).toBe(true);
  });
});

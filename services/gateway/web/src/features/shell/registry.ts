import type { ComponentType } from 'react';
import type { OutsidePage, Tab } from '@/types';

/**
 * Screen registry without a shared file: each `features/<screen>/route.tsx` exports
 * `routes: ScreenRoute[]`, and the shell collects them (screens.ts, `import.meta.glob`). A tab or page with
 * no registered route renders the legacy screen in a LegacyFrame, so each screen PR adds its route.tsx
 * and touches no shared file.
 */
export interface TabScreenProps {
  bidId: string;
  tab: Tab;
  /** The row named by `?row=`, or null. */
  selectedRowId: string | null;
}

export type PageKey = OutsidePage | 'new_bid';

export type ScreenRoute =
  | { tab: Tab; Component: ComponentType<TabScreenProps> }
  | { page: PageKey; Component: ComponentType };

export interface ScreenRegistry {
  tabs: Map<Tab, ComponentType<TabScreenProps>>;
  pages: Map<PageKey, ComponentType>;
}

/** Builds the registry from the route modules. Two modules registering the same tab or page is a bug. */
export function collectRoutes(modules: Record<string, { routes?: ScreenRoute[] }>): ScreenRegistry {
  const registry: ScreenRegistry = { tabs: new Map(), pages: new Map() };
  for (const [file, module] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    for (const route of module.routes ?? []) {
      if ('tab' in route) {
        if (registry.tabs.has(route.tab)) throw new Error(`${file}: tab "${route.tab}" is registered twice`);
        registry.tabs.set(route.tab, route.Component);
      } else {
        if (registry.pages.has(route.page)) throw new Error(`${file}: page "${route.page}" is registered twice`);
        registry.pages.set(route.page, route.Component);
      }
    }
  }
  return registry;
}

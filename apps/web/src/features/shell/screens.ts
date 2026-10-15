import { collectRoutes, type ScreenRoute } from './registry';

/** Every `features/<screen>/route.tsx`, collected at build time (see registry.ts). */
export const screens = collectRoutes(import.meta.glob<{ routes?: ScreenRoute[] }>('../*/route.tsx', { eager: true }));

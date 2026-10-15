import type { ReactNode } from 'react';

/**
 * Hosts a legacy screen (src/screens, src/components/*.tsx) inside the v0 shell until v0 replaces it.
 * The `app-shell` class keeps the legacy CSS (src/index.css) and keeps Tailwind's scoped preflight
 * (ui-preflight.css) off the legacy markup; `legacy-embed` drops the legacy full-page sizing
 * (index.css). Delete with the last legacy screen.
 */
export function LegacyFrame({ children }: { children: ReactNode }) {
  return <div className="app-shell legacy-embed">{children}</div>;
}

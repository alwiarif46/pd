import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from '@/features/shell/bid-context';

/**
 * Renders `node` into the shell's row detail host (09 s5.17; ShellContainer, `detailHost`), or nothing while
 * there is no host (the tab did not opt in with `rowDetail`, no row is selected, or outside the shell). The
 * node stays in the calling tab's React tree, so its state and callbacks are the tab's; only its DOM moves
 * into AppShell's aside, outside `.app-shell`.
 */
export function useDetailPortal(node: ReactNode): ReactNode {
  const host = useShell()?.detailHost ?? null;
  return host ? createPortal(node, host) : null;
}

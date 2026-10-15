import type { ReactNode } from 'react';

/**
 * Temporary page frame for the v0 bids screens until the shell exists (09 s5.1). It sits outside
 * `.app-shell` so Tailwind's reset and the v0 styles apply. The shell PR deletes this file. (Toasts: the
 * `<Toaster />` is in App.tsx, so a toast raised before a route change survives it.)
 */
export function TempFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas p-6">
      {children}
    </div>
  );
}

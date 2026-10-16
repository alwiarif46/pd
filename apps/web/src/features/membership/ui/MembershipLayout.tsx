import { useId, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

/** A centred card under a "Shaavir PD" bar. Built here, not by v0; render it outside `.app-shell`. */
export function MembershipLayout({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <div className="flex min-h-dvh w-full min-w-0 flex-col bg-canvas font-sans text-ink">
      <header className="bg-ink px-4 py-3 text-paper">
        <span className="text-lg font-semibold tracking-tight">Shaavir PD</span>
      </header>
      <main className="flex min-w-0 flex-1 justify-center px-4 py-8 sm:items-center">
        <section
          aria-labelledby={titleId}
          className="w-full max-w-[400px] rounded-lg border border-line bg-paper p-6 shadow-sm sm:p-8"
        >
          <h1 id={titleId} className="text-pretty text-2xl font-semibold tracking-tight text-ink">
            {title}
          </h1>
          <div className="mt-6 flex flex-col gap-5">{children}</div>
        </section>
      </main>
    </div>
  );
}

export function StatusLine({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-due/30 bg-due/5 px-3 py-2.5 text-sm leading-relaxed text-due"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

import { Button } from '@/components/ui/button';
import { EmptyState } from './EmptyState';
import { LockedTab } from './LockedTab';
import { ProcessingBanner } from './ProcessingBanner';
import type { TabFrameProps } from './types';
export function TabFrame(p: TabFrameProps) {
  if (p.block)
    return (
      <main className="space-y-4 p-4">
        {p.block.kind === 'no_solicitation' && (
          <EmptyState
            title="No solicitation yet"
            text="Upload the solicitation to fill this tab."
            action={{ label: 'Upload solicitation', onClick: p.onUploadSolicitation }}
          />
        )}
        {p.block.kind === 'failed' && (
          <div role="alert" className="rounded-lg border border-due/30 bg-paper p-6">
            <h2>This step did not finish</h2>
            <p className="my-3 text-sm">{p.block.reason}</p>
            <Button onClick={p.onRetry}>Try again</Button>
          </div>
        )}
        {p.block.kind === 'locked' && (
          <LockedTab tab={p.tab} title={p.title} description={p.block.description} onUpgrade={p.onUpgrade} />
        )}{' '}
        {p.block.kind === 'out_of_credits' && (
          <div className="rounded-lg border border-line bg-paper p-6">
            <h2>You are out of RFP credits</h2>
            <p className="my-3">
              {p.block.creditsLeft} credits left. Credits reset on{' '}
              {new Date(p.block.creditsResetOn).toLocaleDateString()}.
            </p>
            <Button onClick={p.onUpgrade}>Upgrade plan</Button>
          </div>
        )}
      </main>
    );
  return (
    <main className="space-y-4 p-4">
      {p.overCap && (
        <div className="rounded border border-warning bg-holiday p-3 text-sm">
          {(p.overCap.usedBytes / 1048576).toFixed(1)} MB of {p.overCap.capMb} MB used. New files cannot be added.
          {p.plan === 'free' && (
            <Button variant="link" onClick={p.onUpgrade}>
              Upgrade plan
            </Button>
          )}
        </div>
      )}
      {p.processing && <ProcessingBanner processing={p.processing} />}{' '}
      {p.waiting && (
        <section>
          <h2 className="mb-2 font-semibold">Needs you</h2>
          {p.waiting}
        </section>
      )}
      {p.draftNotice && (
        <div className="rounded border border-line bg-paper p-3 text-sm">
          Draft. Review every row before you rely on it.
        </div>
      )}
      {p.children}
    </main>
  );
}

import { useState, type ReactNode } from 'react';
import { AmendmentConfirm } from './AmendmentConfirm';
import { EmptyState } from './EmptyState';
import { LockedTab } from './LockedTab';
import { MarkingPrompt } from './MarkingPrompt';
import { ProcessingBanner } from './ProcessingBanner';
import { SourceLink } from './SourceLink';
import { TabFrame } from './TabFrame';
import { SAMPLE_AMENDMENTS, SAMPLE_MARKINGS, SAMPLE_PROCESSING } from './sample-data';
import type { Tab } from '@/types';

const tabs: Tab[] = ['overview', 'outline', 'resumes', 'reviews', 'production', 'orals', 'lessons'];

export default function Preview() {
  const [active, setActive] = useState('processing');
  const [lastAction, setLastAction] = useState('None yet');
  const action = (name: string) => setLastAction(name);
  const tab = tabs[0];

  return (
    <div className="flex min-h-screen flex-col gap-6 bg-canvas p-4 font-sans text-ink sm:p-8">
      <header className="flex flex-col gap-3 border-b border-line pb-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shared states preview</p>
          <h1 className="text-2xl font-semibold">Tab states and shared pieces</h1>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Preview state">
          {['processing', 'waiting', 'no_solicitation', 'failed', 'locked', 'out_of_credits', 'over_cap', 'draft'].map((state) => (
            <button
              key={state}
              type="button"
              aria-pressed={active === state}
              onClick={() => setActive(state)}
              className="rounded-md border border-line bg-paper px-3 py-2 text-sm capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary data-[active=true]:bg-primary data-[active=true]:text-primary-foreground"
              data-active={active === state}
            >
              {state.replaceAll('_', ' ')}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">Last callback: <span className="font-mono text-ink">{lastAction}</span></p>
      </header>

      {active === 'processing' && <TabFrame tab={tab} title="Overview" plan="starter" block={null} processing={SAMPLE_PROCESSING} waiting={null} overCap={null} draftNotice={false} onUploadSolicitation={() => action('upload')} onRetry={() => action('retry')} onUpgrade={() => action('upgrade')}><SampleContent /></TabFrame>}
      {active === 'waiting' && <TabFrame tab="compliance" title="Compliance" plan="starter" block={null} processing={null} waiting={<div className="flex flex-col gap-4"><MarkingPrompt fileName="solicitation.pdf" markings={SAMPLE_MARKINGS} page={12} busy={false} onConfirm={() => action('confirm file')} onRemoveFile={() => action('remove file')} /><AmendmentConfirm proposals={SAMPLE_AMENDMENTS} busyIds={[]} onConfirm={(id) => action(`confirm ${id}`)} onReject={(id) => action(`reject ${id}`)} onOpenSource={(id) => action(`source ${id}`)} /></div>} overCap={null} draftNotice={false} onUploadSolicitation={() => action('upload')} onRetry={() => action('retry')} onUpgrade={() => action('upgrade')}><SampleContent /></TabFrame>}
      {active === 'no_solicitation' && <StateFrame><TabFrame tab={tab} title="Overview" plan="free" block={{ kind: 'no_solicitation' }} processing={null} waiting={null} overCap={null} draftNotice={false} onUploadSolicitation={() => action('upload')} onRetry={() => action('retry')} onUpgrade={() => action('upgrade')}><SampleContent /></TabFrame></StateFrame>}
      {active === 'failed' && <StateFrame><TabFrame tab={tab} title="Overview" plan="free" block={{ kind: 'failed', reason: 'The solicitation could not be read. Upload an unlocked copy and try again.' }} processing={null} waiting={null} overCap={null} draftNotice={false} onUploadSolicitation={() => action('upload')} onRetry={() => action('retry')} onUpgrade={() => action('upgrade')}><SampleContent /></TabFrame></StateFrame>}
      {active === 'locked' && <StateFrame><LockedTab tab="resumes" title="Resumes" description="Roles and requirements beside candidate resumes, with gaps called out." onUpgrade={() => action('upgrade')} /></StateFrame>}
      {active === 'out_of_credits' && <StateFrame><TabFrame tab="compliance" title="Compliance" plan="free" block={{ kind: 'out_of_credits', creditsLeft: 0, creditsResetOn: '2026-11-01' }} processing={null} waiting={null} overCap={null} draftNotice={false} onUploadSolicitation={() => action('upload')} onRetry={() => action('retry')} onUpgrade={() => action('upgrade')}><SampleContent /></TabFrame></StateFrame>}
      {active === 'over_cap' && <TabFrame tab={tab} title="Overview" plan="free" block={null} processing={null} waiting={null} overCap={{ usedBytes: 48 * 1024 * 1024, capMb: 50 }} draftNotice={false} onUploadSolicitation={() => action('upload')} onRetry={() => action('retry')} onUpgrade={() => action('upgrade')}><SampleContent /></TabFrame>}
      {active === 'draft' && <TabFrame tab="compliance" title="Compliance" plan="starter" block={null} processing={null} waiting={null} overCap={null} draftNotice onUploadSolicitation={() => action('upload')} onRetry={() => action('retry')} onUpgrade={() => action('upgrade')}><SampleContent /></TabFrame>}

      <section className="flex flex-col gap-3 rounded-md border border-line bg-paper p-4" aria-label="Individual components">
        <h2 className="font-semibold">Individual components</h2>
        <div className="flex flex-wrap items-center gap-4"><EmptyState title="No items found" text="Add one by hand." action={{ label: 'Add requirement', onClick: () => action('add requirement') }} /><SourceLink page={12} pageEnd={13} rowLabel="Requirement" onOpen={() => action('open source')} /><SourceLink page={null} pageEnd={null} rowLabel="Missing source" onOpen={() => action('open source')} /></div>
      </section>
    </div>
  );
}

function StateFrame({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-line bg-paper">{children}</div>;
}

function SampleContent() {
  return <div className="rounded-md border border-line bg-paper p-6"><h2 className="text-lg font-semibold">Sample tab content</h2><p className="mt-2 text-sm text-muted-foreground">The container renders the tab content here.</p></div>;
}

import { useState } from 'react';
import { AppShell } from './AppShell';

export default function Preview() {
  const [lastAction, setLastAction] = useState('None yet');
  const action = (name: string) => setLastAction(name);

  return (
    <div className="min-h-screen bg-canvas font-sans text-ink">
      <AppShell
        bid={{ id: '1', name: 'VA EHR Support Services', agency: 'Department of Veterans Affairs', dueDate: '2026-11-03', dueTime: '14:00', timeZone: 'America/New_York' }}
        bids={[{ id: '1', name: 'VA EHR Support Services' }, { id: '2', name: 'Navy Logistics Modernization' }]}
        activeTab="overview"
        activePage={null}
        plan="free"
        creditsLeft={1}
        creditsResetOn="2026-11-01"
        oralsEnabled={false}
        tabSignals={[{ tab: 'compliance', signal: 'processing' }, { tab: 'documents', signal: 'waiting' }, { tab: 'settings', signal: 'failed' }]}
        user={{ name: 'Dana Reyes', email: 'dana.reyes@northbridge-gov.com' }}
        detail={<div><h2 className="font-semibold">Row detail</h2><p className="text-sm text-muted-foreground">Selected requirement</p></div>}
        onSelectTab={(tab) => action(`onSelectTab("${tab}")`)}
        onSwitchBid={(id) => action(`onSwitchBid("${id}")`)}
        onOpenPage={(page) => action(`onOpenPage("${page}")`)}
        onUpgrade={() => action('onUpgrade()')}
        onSignOut={() => action('onSignOut()')}
      >
        <section className="flex flex-col gap-4 p-6">
          <header><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shell preview</p><h1 className="text-2xl font-semibold">Overview</h1></header>
          <p className="rounded-md border border-line bg-paper p-3 text-sm text-muted-foreground" aria-live="polite">Last callback: <code className="font-mono text-ink">{lastAction}</code></p>
        </section>
      </AppShell>
    </div>
  );
}

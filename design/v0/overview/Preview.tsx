import { useState } from 'react';
import { AppShell } from '../shell/AppShell';
import { OverviewTab } from './OverviewTab';
import type { BidFact, KickoffItem } from './types';

const initialFacts: BidFact[] = [
  { id: 'sol', field: 'Solicitation number', value: 'VA-26-001', confirmed: true, origin: 'ai', sourcePage: 2, sourcePageEnd: null, sourceQuote: 'Solicitation VA-26-001', amendment: { kind: 'original' } },
  { id: 'agency', field: 'Agency', value: 'Department of Veterans Affairs', confirmed: false, origin: 'ai', sourcePage: 1, sourcePageEnd: 2, sourceQuote: 'Department of Veterans Affairs', amendment: { kind: 'original' } },
];

const initialKickoff: KickoffItem[] = [
  { id: 'roles', label: 'Assign proposal roles', owner: 'Dana', done: true, note: 'Confirm the lead writer.' },
  { id: 'questions', label: 'Collect clarification questions', owner: null, done: false, note: null },
];

export default function Preview() {
  const [facts, setFacts] = useState(initialFacts);
  const [kickoff, setKickoff] = useState(initialKickoff);
  const [lastAction, setLastAction] = useState('None yet');
  const action = (message: string) => setLastAction(message);

  return (
    <AppShell
      bid={{ id: '1', name: 'VA EHR Support Services', agency: 'Department of Veterans Affairs', dueDate: '2026-11-03', dueTime: '14:00', timeZone: 'America/New_York' }}
      bids={[{ id: '1', name: 'VA EHR Support Services' }]}
      activeTab="overview"
      activePage={null}
      plan="starter"
      creditsLeft={3}
      creditsResetOn="2026-11-01"
      oralsEnabled={false}
      tabSignals={[{ tab: 'compliance', signal: 'processing' }, { tab: 'documents', signal: 'waiting' }]}
      user={{ name: 'Dana Reyes', email: 'dana.reyes@northbridge-gov.com' }}
      detail={null}
      onSelectTab={(tab) => action(`select ${tab}`)}
      onSwitchBid={(id) => action(`switch bid ${id}`)}
      onOpenPage={(page) => action(`open ${page}`)}
      onUpgrade={() => action('upgrade')}
      onSignOut={() => action('sign out')}
    >
      <section className="flex flex-col gap-4 p-4 sm:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Overview</p><h1 className="text-2xl font-semibold text-balance">Bid overview and kickoff</h1></div>
          <p className="text-sm text-muted-foreground" aria-live="polite">Last callback: <span className="font-mono text-ink">{lastAction}</span></p>
        </header>
        <OverviewTab
          facts={facts}
          kickoff={kickoff}
          countdown={{ dueDate: '2026-11-03', dueTime: '2:00 PM', timeZone: 'ET', daysLeft: 12, workdaysLeft: 8 }}
          selectedRowId="agency"
          onOpenRow={(id) => action(`open row ${id}`)}
          onOpenSource={(id) => action(`open source ${id}`)}
          onEditFact={(id, value) => { setFacts((items) => items.map((item) => item.id === id ? { ...item, value } : item)); action(`edit fact ${id}`); }}
          onConfirmFact={(id, confirmed) => { setFacts((items) => items.map((item) => item.id === id ? { ...item, confirmed } : item)); action(`confirm fact ${id}`); }}
          onAddFact={(field, value) => { setFacts((items) => [...items, { id: crypto.randomUUID(), field, value, confirmed: false, origin: 'user', sourcePage: null, sourcePageEnd: null, sourceQuote: null, amendment: { kind: 'original' } }]); action('add fact'); }}
          onToggleKickoff={(id, done) => { setKickoff((items) => items.map((item) => item.id === id ? { ...item, done } : item)); action(`toggle kickoff ${id}`); }}
          onSetKickoffOwner={(id, owner) => setKickoff((items) => items.map((item) => item.id === id ? { ...item, owner } : item))}
          onAddKickoff={(label) => { setKickoff((items) => [...items, { id: crypto.randomUUID(), label, owner: null, done: false, note: null }]); action('add kickoff'); }}
          onJumpToRow={(id) => action(`jump to ${id}`)}
        />
      </section>
    </AppShell>
  );
}

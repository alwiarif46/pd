import { useState } from 'react';
import AppShell, { type Tab } from './components/AppShell';
import EmptyState from './components/EmptyState';
import ProcessingBanner from './components/ProcessingBanner';

export default function Preview() {
  const [activeTab, setActiveTab] = useState<Tab>('compliance');
  const [bannerVisible, setBannerVisible] = useState(true);
  return <AppShell bid={{ id: 'nrc', name: 'NRC FEDPASS Support', agency: 'National Research Council', dueDate: 'October 24, 2026', dueTime: '5:00 PM', timeZone: 'ET' }} bids={[{ id: 'nrc', name: 'NRC FEDPASS Support' }, { id: 'sample', name: 'DHS Cloud Operations' }]} activeTab={activeTab} plan="free" creditsLeft={2} creditsResetOn="Nov 1, 2026" oralsEnabled user={{ name: 'Alex Morgan', email: 'alex@shaavir.com' }} onSelectTab={setActiveTab} onSwitchBid={() => undefined} onUpgrade={() => window.alert('Upgrade to Starter')} onSignOut={() => undefined}>
    <div className="pd-page-heading"><div><div className="pd-eyebrow">Proposal workspace / {activeTab}</div><h1>Compliance matrix</h1><p>Track every requirement from the RFP and keep your response accountable.</p></div><div className="pd-due-card"><span>Proposal due</span><strong>Oct 24, 2026</strong><small>5:00 PM ET</small></div></div>
    {bannerVisible && <ProcessingBanner state={{ stage: 'verify', percent: 60, etaSeconds: 42 }} onDismiss={() => setBannerVisible(false)} />}
    <div className="pd-content-grid"><section className="pd-panel pd-panel-main"><div className="pd-panel-header"><div><h2>Compliance matrix</h2><p>Requirements will appear here once processing is complete.</p></div><span className="pd-status-pill">Draft</span></div><EmptyState title="Your matrix is being prepared" text="We are reviewing the source documents and extracting requirements. You can start reviewing rows when processing is complete." /></section><aside className="pd-panel pd-context-panel"><div className="pd-panel-header"><div><h2>Bid details</h2><p>At a glance</p></div></div><dl className="pd-details"><div><dt>Agency</dt><dd>National Research Council</dd></div><div><dt>Plan</dt><dd>Free <button type="button" onClick={() => window.alert('Upgrade to Starter')}>Upgrade</button></dd></div><div><dt>Last updated</dt><dd>Just now</dd></div></dl></aside></div>
  </AppShell>;
}

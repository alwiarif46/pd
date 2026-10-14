import { useState, type ReactNode } from 'react';

export type Tab = 'overview' | 'schedule' | 'compliance' | 'outline' | 'resumes' | 'reviews' | 'production' | 'orals' | 'lessons' | 'documents' | 'settings';

export interface AppShellProps {
  bid: { id: string; name: string; agency?: string; dueDate?: string; dueTime?: string; timeZone?: string };
  bids: { id: string; name: string }[];
  activeTab: Tab;
  plan: 'free' | 'starter' | 'growth';
  creditsLeft: number;
  creditsResetOn: string;
  oralsEnabled: boolean;
  user: { name: string; email: string };
  onSelectTab: (t: Tab) => void;
  onSwitchBid: (id: string) => void;
  onUpgrade: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

const primaryItems: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'overview', label: 'Overview', icon: 'O' },
  { tab: 'schedule', label: 'Schedule', icon: 'S' },
  { tab: 'compliance', label: 'Compliance matrix', icon: 'C' },
];
const paidItems: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'outline', label: 'Outline', icon: 'L' },
  { tab: 'resumes', label: 'Resumes', icon: 'R' },
  { tab: 'reviews', label: 'Reviews', icon: 'V' },
  { tab: 'production', label: 'Production', icon: 'P' },
  { tab: 'orals', label: 'Orals', icon: 'A' },
  { tab: 'lessons', label: 'Lessons', icon: 'E' },
];
const bottomItems: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'documents', label: 'Documents', icon: 'D' },
  { tab: 'settings', label: 'Settings', icon: 'T' },
];

export default function AppShell({ bid, bids, activeTab, plan, creditsLeft, creditsResetOn, oralsEnabled, user, onSelectTab, onSwitchBid, onUpgrade, onSignOut, children }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isPaid = plan !== 'free';
  const renderItem = (item: { tab: Tab; label: string; icon: string }, locked = false) => (
    <button className="pd-nav-item" type="button" key={item.tab} aria-current={activeTab === item.tab ? 'page' : undefined} onClick={() => onSelectTab(item.tab)}>
      <span className="pd-nav-icon" aria-hidden="true">{item.icon}</span><span className="pd-nav-label">{item.label}</span>
      {locked && <span className="pd-lock" aria-label="Locked">Lock</span>}
    </button>
  );
  return <div className="pd-shell">
    <header className="pd-topbar">
      <button className="pd-menu-button" type="button" aria-label="Open navigation" onClick={() => setMenuOpen(!menuOpen)}>Menu</button>
      <div className="pd-brand">Shaavir <span>PD</span></div>
      <label className="pd-bid-switcher"> <span className="sr-only">Select bid</span><select value={bid.id} onChange={(e) => onSwitchBid(e.target.value)}>{bids.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="pd-topbar-spacer" />
      <div className="pd-credits"><strong>RFP credits left: {creditsLeft}</strong><span>Resets {creditsResetOn}</span></div>
      <details className="pd-user-menu"><summary><span className="pd-avatar">{user.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><span className="pd-user-name">{user.name}</span></summary><div className="pd-user-popover"><span>{user.email}</span><button type="button" onClick={onSignOut}>Sign out</button></div></details>
    </header>
    <div className="pd-layout">
      <aside className={`pd-sidebar ${menuOpen ? 'is-open' : ''}`} aria-label="Proposal navigation">
        <nav className="pd-nav">{primaryItems.map((item) => renderItem(item))}<div className="pd-section-label">Paid</div>{paidItems.filter((item) => oralsEnabled || item.tab !== 'orals').map((item) => renderItem(item, !isPaid))}<div className="pd-nav-gap" />{bottomItems.map((item) => renderItem(item))}</nav>
        {!isPaid && <button className="pd-upgrade-card" type="button" onClick={onUpgrade}><strong>Unlock your proposal plan</strong><span>Get the tools to build, review, and produce.</span><b>Upgrade</b></button>}
      </aside>
      <main className="pd-content">{children}</main>
    </div>
  </div>;
}

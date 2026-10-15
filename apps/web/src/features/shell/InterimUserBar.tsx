import type { OutsidePage, Tab, TabSignal } from '@/types';

/*
 * INTERIM: delete when v0's shell has a user menu, a bid switcher and a tab menu below 1,024 px.
 *
 * v0's current AppShell renders an account button with no menu (Account, Privacy and Sign out are
 * unreachable), leaves `bids`/`onSwitchBid` unused (no bid switcher, and no way back to the bid list from
 * inside a bid), and hides the sidebar below 1,024 px with no icon rail or sheet. This plain bar, mounted
 * by the shell container at the top of the content, stands in for those until the v0 follow-up lands.
 */

const button =
  'rounded px-2 py-1 hover:bg-weekend focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const select =
  'rounded border border-line bg-paper px-2 py-1 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export interface InterimTab {
  tab: Tab;
  label: string;
  locked: boolean;
  signal: TabSignal | null;
}

export interface InterimUserBarProps {
  /** Inside a bid: the bid list for the switcher and the open bid and tab. Null outside a bid. */
  inBid: { bids: { id: string; name: string }[]; bidId: string; tab: Tab; tabs: InterimTab[] } | null;
  signalLabels: Record<TabSignal, string>;
  onSwitchBid: (id: string) => void;
  onSelectTab: (tab: Tab) => void;
  onOpenPage: (page: OutsidePage) => void;
  /** Free plan only: compare plans. */
  onUpgrade: (() => void) | null;
  onSignOut: () => void;
}

export function InterimUserBar({ inBid, signalLabels, onSwitchBid, onSelectTab, onOpenPage, onUpgrade, onSignOut }: InterimUserBarProps) {
  return (
    <nav
      aria-label="Account and bid"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-paper px-4 py-2 text-sm text-ink"
    >
      {inBid ? (
        <>
          <button type="button" className={button} onClick={() => onOpenPage('bids')}>
            All bids
          </button>
          <label className="flex items-center gap-2">
            <span>Bid</span>
            <select className={`${select} max-w-[14rem]`} value={inBid.bidId} onChange={(event) => onSwitchBid(event.target.value)}>
              {inBid.bids.some((bid) => bid.id === inBid.bidId) ? null : <option value={inBid.bidId}>This bid</option>}
              {inBid.bids.map((bid) => (
                <option key={bid.id} value={bid.id}>
                  {bid.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 lg:hidden">
            <span>Tab</span>
            <select className={select} value={inBid.tab} onChange={(event) => onSelectTab(event.target.value as Tab)}>
              {inBid.tabs.map((item) => (
                <option key={item.tab} value={item.tab}>
                  {item.label}
                  {item.locked ? ' (locked)' : ''}
                  {item.signal ? ` · ${signalLabels[item.signal]}` : ''}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      <span className="ml-auto flex flex-wrap items-center gap-1">
        {onUpgrade ? (
          <button type="button" className={button} onClick={onUpgrade}>
            Compare plans
          </button>
        ) : null}
        {inBid ? (
          <button type="button" className={button} onClick={() => onOpenPage('organization')}>
            Organization
          </button>
        ) : null}
        <button type="button" className={button} onClick={() => onOpenPage('account')}>
          Account
        </button>
        <button type="button" className={button} onClick={() => onOpenPage('privacy')}>
          Privacy
        </button>
        <button type="button" className={button} onClick={onSignOut}>
          Sign out
        </button>
      </span>
    </nav>
  );
}

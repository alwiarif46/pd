import { useState } from 'react';
import {
  CalendarDays,
  ClipboardCheck,
  FileStack,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  ListTree,
  Lock,
  Menu,
  Mic,
  PackageCheck,
  Settings,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { Tab } from '@/types';
import type { AppShellProps, OutsidePage, TabSignal } from './types';
import { PAID_TABS } from './types';

const tabs: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'schedule', label: 'Schedule', icon: CalendarDays },
  { id: 'compliance', label: 'Compliance', icon: ListChecks },
  { id: 'outline', label: 'Outline', icon: ListTree },
  { id: 'resumes', label: 'Resumes', icon: Users },
  { id: 'reviews', label: 'Reviews', icon: ClipboardCheck },
  { id: 'production', label: 'Production', icon: PackageCheck },
  { id: 'orals', label: 'Orals', icon: Mic },
  { id: 'lessons', label: 'Lessons', icon: Lightbulb },
  { id: 'documents', label: 'Documents', icon: FileStack },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function localDate(value: string | null, withYear = false) {
  if (!value) return 'To be confirmed';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(year, month - 1, day));
}

function timeLabel(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour = hours % 12 || 12;
  return `${hour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function zoneLabel(zone: string) {
  return (
    (
      {
        'America/New_York': 'ET',
        'America/Chicago': 'CT',
        'America/Denver': 'MT',
        'America/Los_Angeles': 'PT',
        'America/Anchorage': 'AKT',
        'Pacific/Honolulu': 'HT',
      } as Record<string, string>
    )[zone] ?? zone
  );
}

function signalText(signal: TabSignal) {
  return signal === 'processing' ? 'Processing' : signal === 'waiting' ? 'Needs you' : 'Failed';
}
function signalClass(signal: TabSignal) {
  return signal === 'processing' ? 'bg-today' : signal === 'waiting' ? 'bg-warning' : 'bg-due';
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function AppShell(props: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const signalFor = (tab: Tab) => props.tabSignals.find((item) => item.tab === tab)?.signal;
  const navigateTab = (tab: Tab) => {
    setMenuOpen(false);
    props.onSelectTab(tab);
  };
  const navigatePage = (page: OutsidePage) => {
    setMenuOpen(false);
    props.onOpenPage(page);
  };
  const nav = (
    <nav aria-label="Bid tabs" className="flex flex-col gap-1">
      {tabs
        .filter(({ id }) => props.oralsEnabled || id !== 'orals')
        .map(({ id, label, icon: Icon }, index) => {
          const locked = props.plan === 'free' && PAID_TABS.includes(id);
          const signal = signalFor(id);
          const active = props.activeTab === id;
          return (
            <div
              key={id}
              className={
                index === 3 ? 'mt-2 border-t border-line pt-2' : index === 9 ? 'mt-2 border-t border-line pt-2' : ''
              }
            >
              {index === 3 && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Paid</p>}
              {index === 9 && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Documents</p>}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    aria-label={`${label}${locked ? ' (locked)' : ''}${signal ? `, ${signalText(signal)}` : ''}`}
                    onClick={() => navigateTab(id)}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-weekend focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${active ? 'bg-weekend font-semibold' : ''}`}
                  >
                    <span className="relative shrink-0">
                      <Icon aria-hidden="true" />
                      {locked && <Lock aria-hidden="true" className="absolute -right-2 -top-1 size-3" />}
                      {signal && (
                        <span
                          aria-hidden="true"
                          className={`absolute -right-1 -top-1 size-2 rounded-full ${signalClass(signal)}`}
                        />
                      )}
                    </span>
                    <span className="sr-only min-[1024px]:not-sr-only">
                      {label}
                      {locked && <span className="sr-only"> (locked)</span>}
                    </span>
                    {signal && (
                      <span className="sr-only min-[1024px]:not-sr-only text-xs text-muted-foreground">
                        {signalText(signal)}
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {label}
                  {locked ? ' — locked' : ''}
                  {signal ? `: ${signalText(signal)}` : ''}
                </TooltipContent>
              </Tooltip>
            </div>
          );
        })}
    </nav>
  );
  const creditsLabel =
    props.creditsLeft === 0
      ? '0 RFP credits left'
      : `${props.creditsLeft} RFP credit${props.creditsLeft === 1 ? '' : 's'} left`;
  const due = props.bid?.dueDate
    ? `Due ${localDate(props.bid.dueDate)}${props.bid.dueTime && props.bid.timeZone ? `, ${timeLabel(props.bid.dueTime)} ${zoneLabel(props.bid.timeZone)}` : ''}`
    : 'Due date to be confirmed';

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col bg-canvas text-ink">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-paper focus:p-2"
        >
          Skip to content
        </a>
        <header className="flex h-14 shrink-0 items-center gap-2 overflow-hidden bg-ink px-3 text-paper sm:gap-3 sm:px-4">
          <div className="flex shrink-0 items-center gap-2" aria-label="Shaavir PD">
            <img src="/shaavir-mark.png" alt="" className="size-7 shrink-0" />
            <strong className="hidden sm:inline">Shaavir PD</strong>
            <span className="sr-only">Shaavir PD</span>
          </div>
          {props.bid ? (
            <>
              <Select
                value={props.bid.id}
                onValueChange={(value) => (value === '__all__' ? navigatePage('bids') : props.onSwitchBid(value))}
              >
                <SelectTrigger aria-label="Bid" className="h-9 min-w-0 max-w-56 shrink text-paper">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All bids</SelectItem>
                  {props.bids.map((bid) => (
                    <SelectItem key={bid.id} value={bid.id}>
                      {bid.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="hidden min-w-0 truncate font-numeric text-xs text-paper/75 sm:inline">{due}</span>
            </>
          ) : (
            <div className="flex shrink-0 gap-1 text-sm">
              <Button
                variant="link"
                className="text-paper hover:text-paper"
                aria-current={props.activePage === 'bids' ? 'page' : undefined}
                onClick={() => navigatePage('bids')}
              >
                Bids
              </Button>
              <Button
                variant="link"
                className="hidden text-paper hover:text-paper sm:inline-flex"
                aria-current={props.activePage === 'organization' ? 'page' : undefined}
                onClick={() => navigatePage('organization')}
              >
                Organization
              </Button>
            </div>
          )}
          <span
            className={`ml-auto shrink-0 truncate font-numeric text-xs ${props.creditsLeft === 0 ? 'text-warning' : 'text-paper/75'}`}
          >
            <span className="sm:hidden">{props.creditsLeft} credits</span>
            <span className="hidden sm:inline">
              {creditsLabel} · resets {localDate(props.creditsResetOn)}
            </span>
          </span>
          {props.creditsLeft === 0 && (
            <Button size="sm" variant="secondary" className="hidden shrink-0 sm:inline-flex" onClick={props.onUpgrade}>
              Upgrade plan
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-9 shrink-0 rounded-full p-0 text-paper hover:bg-paper/10 hover:text-paper"
                aria-label={`Account menu for ${props.user.name}`}
              >
                {initials(props.user.name)}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                <span className="block">{props.user.name}</span>
                <span className="font-normal text-muted-foreground">{props.user.email}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigatePage('account')}>Account</DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigatePage('organization')}>Organization</DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigatePage('privacy')}>Privacy</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={props.onSignOut}>Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {props.bid && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-paper hover:bg-paper/10 hover:text-paper min-[640px]:hidden"
              aria-label="Menu"
              onClick={() => setMenuOpen(true)}
            >
              <Menu aria-hidden="true" />
            </Button>
          )}
        </header>
        <div className="relative flex min-h-0 flex-1">
          {props.bid && (
            <aside className="hidden w-16 shrink-0 border-r border-line p-2 min-[640px]:block min-[1024px]:w-56 min-[1024px]:p-3">
              {nav}
            </aside>
          )}
          <main
            id="content"
            className={`flex min-h-0 min-w-0 flex-1 flex-col${props.bid ? '' : ' mx-auto w-full max-w-[1100px]'}`}
          >
            {props.children}
          </main>
          {props.detail && (
            <aside
              aria-label="Row detail"
              className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-auto border-t border-line bg-paper p-4 min-[1024px]:static min-[1024px]:max-h-none min-[1024px]:w-[420px] min-[1024px]:shrink-0 min-[1024px]:border-l min-[1024px]:border-t-0"
            >
              {props.detail}
            </aside>
          )}
        </div>
        {props.bid && (
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetContent side="left">
              <SheetTitle>Bid navigation</SheetTitle>
              {nav}
            </SheetContent>
          </Sheet>
        )}
      </div>
    </TooltipProvider>
  );
}

export default AppShell;

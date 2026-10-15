import { useState } from 'react';
import {
  Archive,
  BookOpen,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  FileText,
  FolderKanban,
  LayoutDashboard,
  Lock,
  Menu,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { Tab } from '@/types';
import type { AppShellProps, OutsidePage, TabSignal } from './types';
import { PAID_TABS } from './types';

const tabs: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'schedule', label: 'Schedule', icon: Clock3 },
  { id: 'compliance', label: 'Compliance', icon: ShieldCheck },
  { id: 'outline', label: 'Outline', icon: BookOpen },
  { id: 'resumes', label: 'Resumes', icon: Users },
  { id: 'reviews', label: 'Reviews', icon: CheckCircle2 },
  { id: 'production', label: 'Production', icon: BriefcaseBusiness },
  { id: 'orals', label: 'Orals', icon: FolderKanban },
  { id: 'lessons', label: 'Lessons', icon: Archive },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'settings', label: 'Settings', icon: Settings },
];

function formatDate(value: string | null): string {
  if (!value) return 'To be confirmed';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(year, month - 1, day));
}

function formatDueDate(bid: AppShellProps['bid']): string {
  if (!bid?.dueDate) return 'Due date to be confirmed';
  const date = `Due ${formatDate(bid.dueDate)}`;
  if (!bid.dueTime || !bid.timeZone) return date;
  return `${date} at ${bid.dueTime} (${bid.timeZone})`;
}

function signalText(signal: TabSignal): string {
  if (signal === 'processing') return 'Processing';
  if (signal === 'waiting') return 'Needs you';
  return 'Failed';
}

function signalIcon(signal: TabSignal) {
  if (signal === 'failed') return <CircleAlert aria-hidden="true" className="size-4 text-due" />;
  if (signal === 'waiting') return <Clock3 aria-hidden="true" className="size-4 text-warning" />;
  return <CheckCircle2 aria-hidden="true" className="size-4 text-today" />;
}

export function AppShell(props: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const signalFor = (tab: Tab) => props.tabSignals.find((item) => item.tab === tab)?.signal;
  const navigateTab = (tab: Tab) => {
    setMenuOpen(false);
    if (props.plan === 'free' && PAID_TABS.includes(tab)) {
      props.onUpgrade();
      return;
    }
    props.onSelectTab(tab);
  };
  const navigatePage = (page: OutsidePage) => {
    setMenuOpen(false);
    props.onOpenPage(page);
  };
  const nav = (
    <nav aria-label="Bid tabs" className="flex flex-col gap-1">
      {tabs.filter(({ id }) => props.oralsEnabled || id !== 'orals').map(({ id, label, icon: Icon }, index) => {
        const locked = props.plan === 'free' && PAID_TABS.includes(id);
        const signal = signalFor(id);
        const active = props.activeTab === id;
        return (
          <div key={id} className={index === 3 ? 'mt-2 border-t border-line pt-2' : ''}>
            {index === 3 && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Paid</p>}
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-current={active ? 'page' : undefined} aria-label={`${label}${locked ? ' (locked)' : ''}${signal ? `, ${signalText(signal)}` : ''}`} onClick={() => navigateTab(id)} className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-weekend focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${active ? 'bg-weekend font-semibold' : ''}`}>
                  <span className="relative shrink-0">{locked ? <Lock aria-hidden="true" className="size-4" /> : <Icon aria-hidden="true" className="size-4" />}{signal && <span className="absolute -right-1 -top-1" aria-hidden="true">{signalIcon(signal)}</span>}</span>
                  <span className="sr-only min-[1024px]:not-sr-only">{label}</span>
                  {signal && <span className="sr-only min-[1024px]:not-sr-only text-xs text-muted-foreground">{signalText(signal)}</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{locked ? `${label} — locked` : label}{signal ? `: ${signalText(signal)}` : ''}</TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </nav>
  );
  const creditsLabel = `${props.creditsLeft} RFP credit${props.creditsLeft === 1 ? '' : 's'} left`;

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col bg-canvas text-ink">
        <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-paper focus:p-2">Skip to content</a>
        <header className="flex min-h-14 flex-wrap items-center gap-3 bg-ink px-4 py-2 text-paper">
          <strong className="shrink-0">Shaavir PD</strong>
          {props.bid ? <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" className="max-w-64 justify-start gap-1 text-paper hover:bg-paper/10 hover:text-paper"><span className="flex min-w-0 flex-col items-start"><span className="truncate">{props.bid.name}</span><span className="max-w-full truncate text-xs font-normal text-paper/70">{props.bid.agency ?? 'Agency to be confirmed'}</span></span><ChevronDown aria-hidden="true" className="size-4 shrink-0" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start"><DropdownMenuLabel>Switch bid</DropdownMenuLabel>{props.bids.map((bid) => <DropdownMenuItem key={bid.id} onClick={() => props.onSwitchBid(bid.id)}>{bid.name}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>
            <Button variant="link" className="text-paper hover:text-paper" onClick={() => navigatePage('bids')}>Bids</Button>
            <span className="min-w-0 truncate text-xs text-paper/75">{formatDueDate(props.bid)}</span>
          </> : <div className="flex gap-2 text-sm"><Button variant="link" className={props.activePage === 'bids' ? 'text-paper underline' : 'text-paper'} aria-current={props.activePage === 'bids' ? 'page' : undefined} onClick={() => navigatePage('bids')}>Bids</Button><Button variant="link" className={props.activePage === 'organization' ? 'text-paper underline' : 'text-paper'} aria-current={props.activePage === 'organization' ? 'page' : undefined} onClick={() => navigatePage('organization')}>Organization</Button></div>}
          <span className="ml-auto text-xs text-paper/75">{creditsLabel} · resets {formatDate(props.creditsResetOn)}</span>
          {props.plan === 'free' ? <Button size="sm" variant="secondary" onClick={props.onUpgrade}>Upgrade plan</Button> : <span className="rounded border border-paper/30 px-2 py-1 text-xs">{props.plan === 'starter' ? 'Starter' : 'Growth'}</span>}
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="gap-2 text-paper hover:bg-paper/10 hover:text-paper" aria-label={`Account menu for ${props.user.name}`}><UserRound aria-hidden="true" className="size-4" /><span className="hidden md:inline">{props.user.name}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel><span className="block">{props.user.name}</span><span className="font-normal text-muted-foreground">{props.user.email}</span></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onClick={() => navigatePage('account')}>Account</DropdownMenuItem><DropdownMenuItem onClick={() => navigatePage('organization')}>Organization</DropdownMenuItem><DropdownMenuItem onClick={() => navigatePage('privacy')}>Privacy</DropdownMenuItem><DropdownMenuItem onClick={props.onSignOut}>Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          {props.bid && <Button variant="ghost" size="icon" className="text-paper hover:bg-paper/10 hover:text-paper min-[640px]:hidden" aria-label="Menu" onClick={() => setMenuOpen(true)}><Menu aria-hidden="true" /></Button>}
        </header>
        <div className="flex min-h-0 flex-1">
          {props.bid && <aside className="hidden w-16 shrink-0 border-r border-line p-2 min-[640px]:block min-[1024px]:w-56 min-[1024px]:p-3">{nav}</aside>}
          <main id="content" className="min-w-0 flex-1">
            {props.detail && <div className="flex justify-end p-3 min-[1024px]:hidden"><Button variant="outline" size="sm" onClick={() => setDetailOpen(true)}>View row detail</Button></div>}
            {props.children}
          </main>
          {props.detail && <aside className="hidden w-80 shrink-0 border-l border-line p-4 min-[1024px]:block">{props.detail}</aside>}
        </div>
        {props.bid && <Sheet open={menuOpen} onOpenChange={setMenuOpen}><SheetContent side="left"><SheetTitle>Bid navigation</SheetTitle>{nav}</SheetContent></Sheet>}
        {props.detail && <Sheet open={detailOpen} onOpenChange={setDetailOpen}><SheetContent side="bottom" className="min-[1024px]:hidden"><SheetTitle>Row detail</SheetTitle><SheetClose asChild><Button variant="outline">Close</Button></SheetClose>{props.detail}</SheetContent></Sheet>}
      </div>
    </TooltipProvider>
  );
}

export default AppShell;

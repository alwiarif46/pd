import { ChevronDown, CircleAlert, CircleCheck, Clock3, Lock, Menu, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { AppShellProps, TabSignal } from './types';
import { PAID_TABS } from './types';

const tabs = [
  ['overview', 'Overview'], ['schedule', 'Schedule'], ['compliance', 'Compliance'],
  ['outline', 'Outline'], ['resumes', 'Resumes'], ['reviews', 'Reviews'],
  ['production', 'Production'], ['orals', 'Orals'], ['lessons', 'Lessons'],
  ['documents', 'Documents'], ['settings', 'Settings'],
] as const;

function formatDate(value: string | null) {
  if (!value) return 'To be confirmed';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(year, month - 1, day));
}

function signalIcon(signal: TabSignal) {
  if (signal === 'failed') return <CircleAlert aria-label="failed" className="size-4 text-due" />;
  if (signal === 'waiting') return <Clock3 aria-label="waiting" className="size-4 text-warning" />;
  return <CircleCheck aria-label="processing" className="size-4 text-today" />;
}

export function AppShell(p: AppShellProps) {
  const signalFor = (tab: string) => p.tabSignals.find((item) => item.tab === tab)?.signal;
  const nav = (
    <nav aria-label="Bid tabs" className="flex flex-col gap-1">
      {tabs.filter(([id]) => p.oralsEnabled || id !== 'orals').map(([id, label], index) => {
        const locked = p.plan === 'free' && PAID_TABS.includes(id as never);
        const signal = signalFor(id);
        return <div key={id} className={id === 'documents' ? 'mt-2 border-t border-line pt-2' : ''}>
          {index === 3 && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Paid features</p>}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-current={p.activeTab === id ? 'page' : undefined} aria-label={locked ? `${label} (locked)` : label} onClick={() => locked ? p.onUpgrade() : p.onSelectTab(id)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-weekend focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {locked ? <Lock className="size-4" aria-hidden="true" /> : signal ? signalIcon(signal) : <span className="size-4" aria-hidden="true" />}
                <span className="truncate lg:inline">{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{locked ? `${label} — upgrade to unlock` : label}</TooltipContent>
          </Tooltip>
        </div>;
      })}
    </nav>
  );

  return <TooltipProvider>
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex min-h-14 items-center gap-3 bg-ink px-4 text-paper">
        <strong className="shrink-0">Shaavir PD</strong>
        {p.bid ? <>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="max-w-64 justify-start gap-1 truncate text-paper hover:bg-paper/10 hover:text-paper"><span className="truncate">{p.bid.name}</span><ChevronDown className="size-4 shrink-0" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuLabel>Switch bid</DropdownMenuLabel>{p.bids.map((bid) => <DropdownMenuItem key={bid.id} onClick={() => p.onSwitchBid(bid.id)}>{bid.name}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
          <span className="hidden text-xs text-paper/75 md:inline">Due {formatDate(p.bid.dueDate)}{p.bid.dueTime ? ` at ${p.bid.dueTime}` : ''}{p.bid.timeZone ? ` (${p.bid.timeZone})` : ''}</span>
        </> : <div className="flex gap-2 text-sm"><button type="button" onClick={() => p.onOpenPage('bids')}>Bids</button><button type="button" onClick={() => p.onOpenPage('organization')}>Organization</button></div>}
        <span className="ml-auto hidden text-xs text-paper/75 xl:inline">{p.creditsLeft} RFP credits left · resets {formatDate(p.creditsResetOn)}</span>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="gap-2 text-paper hover:bg-paper/10 hover:text-paper" aria-label={`Account menu for ${p.user.name}`}><UserRound className="size-4" /><span className="hidden md:inline">{p.user.name}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel><span className="block">{p.user.name}</span><span className="font-normal text-muted-foreground">{p.user.email}</span></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onClick={() => p.onOpenPage('account')}>Account</DropdownMenuItem><DropdownMenuItem onClick={() => p.onOpenPage('privacy')}>Privacy</DropdownMenuItem><DropdownMenuItem onClick={p.onSignOut}>Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        {p.bid && <Sheet><SheetTrigger asChild><Button variant="ghost" size="icon" className="text-paper hover:bg-paper/10 hover:text-paper lg:hidden" aria-label="Menu"><Menu /></Button></SheetTrigger><SheetContent side="left"><SheetTitle className="sr-only">Bid navigation</SheetTitle><div className="pt-6">{nav}</div></SheetContent></Sheet>}
      </header>
      <div className="flex min-h-0 flex-1">
        {p.bid && <aside className="hidden w-16 shrink-0 border-r border-line p-2 lg:block xl:w-56 xl:p-3">{nav}</aside>}
        <main className="min-w-0 flex-1">{p.children}</main>
        {p.detail && <aside className="hidden w-80 shrink-0 border-l border-line p-4 xl:block">{p.detail}</aside>}
      </div>
    </div>
  </TooltipProvider>;
}

export { formatDate };

void CircleAlert;
void Menu;
void Lock;
void UserRound;
void ChevronDown;
void Clock3;
void CircleCheck;
void Tooltip;
void TooltipContent;
void TooltipTrigger;
void DropdownMenu;
void DropdownMenuContent;
void DropdownMenuItem;
void DropdownMenuLabel;
void DropdownMenuSeparator;
void Sheet;
void SheetContent;
void SheetTitle;
void SheetTrigger;
void Button;
export default AppShell;

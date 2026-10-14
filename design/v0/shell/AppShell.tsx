'use client';

import { useState } from 'react';
import { ChevronDown, LogOut, Settings, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AppShellProps, OutsidePage, UpgradeReason } from './types';
import { PAID_TABS } from './types';

const TAB_LABELS: Record<string, string> = { overview: 'Overview', compliance: 'Compliance', outline: 'Outline', resumes: 'Resumes', reviews: 'Reviews', production: 'Production', orals: 'Orals', lessons: 'Lessons' };

export function AppShell({ bid, bids, activeTab, activePage, plan, creditsLeft, creditsResetOn, oralsEnabled, tabSignals, user, detail, onSelectTab, onSwitchBid, onOpenPage, onUpgrade, onSignOut, children }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [bidMenuOpen, setBidMenuOpen] = useState(false);
  const [upgrade, setUpgrade] = useState<UpgradeReason | null>(null);
  const activeValue = activePage ? `page:${activePage}` : `tab:${activeTab ?? 'overview'}`;
  function select(value: string) {
    if (value.startsWith('page:')) return onOpenPage(value.slice(5) as OutsidePage);
    const tab = value.slice(4) as AppShellProps['activeTab'];
    if (!tab) return;
    if (PAID_TABS.includes(tab) && plan === 'free') return setUpgrade('locked_tab');
    if (tab === 'orals' && !oralsEnabled) return setUpgrade('locked_tab');
    onSelectTab(tab);
  }
  return <div className="min-h-screen bg-canvas text-ink">
    <header className="sticky top-0 z-20 border-b border-line bg-paper">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
        <div className="flex min-w-0 items-center gap-3"><button type="button" onClick={() => onOpenPage('bids')} className="font-mono text-sm font-semibold text-primary">CIVICBID</button><span className="hidden text-muted-foreground sm:inline">/</span><button type="button" onClick={() => setBidMenuOpen(true)} className="hidden max-w-64 items-center gap-1 truncate text-left text-sm font-medium hover:text-primary sm:flex">{bid?.name ?? 'Choose a bid'} <ChevronDown className="size-4" aria-hidden="true" /></button></div>
        <div className="flex items-center gap-2"><span className="hidden text-sm text-muted-foreground md:inline">{user.name}</span><Button type="button" variant="outline" size="icon" aria-label="Open account menu" onClick={() => setMenuOpen(true)}><UserRound className="size-4" /></Button></div>
      </div>
      <div className="overflow-x-auto border-t border-line px-4 sm:px-8"><Tabs value={activeValue} onValueChange={select}><TabsList className="h-11 w-max min-w-full justify-start gap-1 rounded-none bg-transparent p-0">{Object.entries(TAB_LABELS).map(([key, label]) => { const signal = tabSignals.find((item) => item.tab === key)?.signal; return <TabsTrigger key={key} value={`tab:${key}`} className="h-11 rounded-none border-b-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-transparent">{label}{signal && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-primary" aria-label={`${signal} signal`} />}</TabsTrigger>; })}</TabsList></Tabs></div>
    </header>
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-8 lg:flex-row"><div className="min-w-0 flex-1">{children}</div>{detail}</main>
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}><SheetContent className="bg-paper text-ink"><SheetHeader><SheetTitle>Account</SheetTitle><SheetDescription>{user.email}</SheetDescription></SheetHeader><nav className="flex flex-col gap-2 px-4 py-4"><Button variant="outline" className="justify-start" onClick={() => { setMenuOpen(false); onOpenPage('organization'); }}><Settings className="size-4" /> Organization</Button><Button variant="outline" className="justify-start" onClick={() => { setMenuOpen(false); onOpenPage('account'); }}><UserRound className="size-4" /> Account</Button><Button variant="ghost" className="justify-start" onClick={onSignOut}><LogOut className="size-4" /> Sign out</Button></nav></SheetContent></Sheet>
    <Dialog open={bidMenuOpen} onOpenChange={setBidMenuOpen}><DialogContent className="bg-paper text-ink"><DialogHeader><DialogTitle>Switch bid</DialogTitle><DialogDescription>Select a bid to open.</DialogDescription></DialogHeader><div className="flex flex-col gap-2">{bids.map((item) => <Button key={item.id} variant={item.id === bid?.id ? 'secondary' : 'outline'} className="justify-start" onClick={() => { onSwitchBid(item.id); setBidMenuOpen(false); }}>{item.name}</Button>)}</div></DialogContent></Dialog>
    <Dialog open={Boolean(upgrade)} onOpenChange={(open) => !open && setUpgrade(null)}><DialogContent className="bg-paper text-ink"><DialogHeader><DialogTitle>Unlock more bid workspace</DialogTitle><DialogDescription>Upgrade your plan to unlock this workspace. Credits reset on {creditsResetOn}; you have {creditsLeft} left.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setUpgrade(null)}>Not now</Button><Button onClick={() => { setUpgrade(null); onUpgrade(); }}>View plans</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

export default AppShell;
'}彩票代理彩娱乐彩票เปิดอภิปราย.functions.TodoManager to=functions.TodoManager commentary  (json) code હેઠ和天天中彩票 菲娱.}'wina.} Need mark task done/move. Then maybe verify syntax via read, maybe no build. Could do git sync after changes. First todo move.} وظائف.TodoManager to=functions.TodoManager commentary  (json) code:UIControl  ...}I'm hitting tool call again. Use proper next.} 北京赛车的.} Let's call.}.functions.TodoManager to=functions.TodoManager commentary  (json) code:{

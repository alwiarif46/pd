import type { Tab, AuthStatus } from '@/types';
import type React from 'react';
export type OutsidePage = 'bids' | 'organization' | 'account' | 'privacy';
export type TabSignal = 'processing' | 'waiting' | 'failed';
export interface ShellBid { id:string; name:string; agency:string|null; dueDate:string|null; dueTime:string|null; timeZone:string|null }
export type Plan = 'free'|'starter'|'growth';
export interface AppShellProps { bid:ShellBid|null; bids:{id:string;name:string}[]; activeTab:Tab|null; activePage:OutsidePage|null; plan:Plan; creditsLeft:number; creditsResetOn:string; oralsEnabled:boolean; tabSignals:{tab:Tab;signal:TabSignal}[]; user:{name:string;email:string}; detail:React.ReactNode; onSelectTab:(t:Tab)=>void; onSwitchBid:(id:string)=>void; onOpenPage:(p:OutsidePage)=>void; onUpgrade:()=>void; onSignOut:()=>void; children:React.ReactNode }
export const PAID_TABS: Tab[] = ['outline','resumes','reviews','production','orals','lessons'];
export type UpgradeReason='locked_tab'|'out_of_credits'|'over_cap'|'seats'|'plan';
export interface UpgradeDialogProps { open:boolean; reason:UpgradeReason; plan:Plan; creditsLeft:number; creditsResetOn:string; onChoosePlan:(p:'starter'|'growth')=>void; onClose:()=>void }
export interface ConfirmDialogProps { open:boolean; title:string; body:string; confirmLabel:string; typeToConfirm:string|null; busy:boolean; onConfirm:()=>void; onCancel:()=>void }
export type { Tab, AuthStatus };

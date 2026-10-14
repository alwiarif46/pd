'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface SettingsTabProps { workspaceName: string; retentionDays: number; aiEnabled: boolean; onSave: (settings: { workspaceName: string; retentionDays: number; aiEnabled: boolean }) => void }
export function SettingsTab({ workspaceName, retentionDays, aiEnabled, onSave }: SettingsTabProps) { return <main className="flex w-full max-w-3xl flex-col gap-5 font-sans text-ink"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Settings</p><h1 className="text-2xl font-semibold">Workspace controls</h1><p className="text-sm text-muted-foreground">Manage naming, retention, and assistive features for this bid.</p></div><section className="flex flex-col gap-4 rounded-md border border-line bg-paper p-5"><label className="flex flex-col gap-2 text-sm font-medium">Workspace name<Input defaultValue={workspaceName} /></label><label className="flex flex-col gap-2 text-sm font-medium">Resume retention days<Input type="number" defaultValue={retentionDays} /></label><label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" defaultChecked={aiEnabled} className="size-4" /> Enable AI extraction suggestions</label><Button onClick={() => onSave({ workspaceName, retentionDays, aiEnabled })}>Save settings</Button></section><p className="text-xs text-muted-foreground">AI suggestions remain reviewable and do not replace reviewer decisions.</p></main>; }
export default SettingsTab;

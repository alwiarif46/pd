'use client';

import { Check, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';

export interface ProductionItem { id: string; category: string; rule: string; owner: string | null; done: boolean; origin: 'ai' | 'user' | 'standard'; sourcePage: number | null }
export interface ProductionTabProps { items: ProductionItem[]; selectedRowId: string | null; onToggle: (id: string, done: boolean) => void; onEdit: (id: string, edit: { rule?: string; owner?: string | null }) => void; onAdd: (category: string, rule: string) => void; onDelete: (id: string) => void; onOpenRow: (id: string) => void; onOpenSource: (id: string) => void }

export function ProductionTab({ items, onToggle, onAdd, onOpenSource }: ProductionTabProps) {
 const complete = items.filter((item) => item.done).length; const percent = items.length ? Math.round((complete / items.length) * 100) : 0;
 return <main className="flex w-full flex-col gap-5 font-sans text-ink"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Production</p><h1 className="text-2xl font-semibold">Submission checklist</h1><p className="text-sm text-muted-foreground">Track format, files, submission, and copies before delivery.</p></div><section className="rounded-md border border-line bg-paper p-4"><div className="flex items-center justify-between gap-3"><div><p className="font-semibold">{complete} of {items.length} complete</p><p className={complete === items.length && items.length > 0 ? 'text-sm text-success' : 'text-sm text-muted-foreground'}>{complete === items.length && items.length > 0 ? 'Ready to submit' : 'Keep working through the requirements'}</p></div><span className="font-mono text-sm">{percent}%</span></div><Progress className="mt-3" value={percent} /></section><div className="flex flex-col gap-3">{['format', 'files', 'submission', 'copies', 'other'].map((category) => { const group = items.filter((item) => item.category === category); return <section key={category} className="rounded-md border border-line bg-paper"><div className="flex items-center justify-between border-b border-line p-4"><h2 className="font-semibold capitalize">{category}</h2><span className="text-xs text-muted-foreground">{group.filter((item) => item.done).length}/{group.length}</span></div>{group.map((item) => <label key={item.id} className="flex items-start gap-3 border-b border-line p-4 last:border-0"><Checkbox checked={item.done} onCheckedChange={(checked) => onToggle(item.id, checked === true)} /><span className="flex-1 text-sm">{item.rule}<span className="mt-1 block text-xs text-muted-foreground">{item.origin === 'standard' ? 'Standard' : item.sourcePage ? <button type="button" className="underline" onClick={() => onOpenSource(item.id)}>Source · page {item.sourcePage}</button> : 'User added'}</span></span></label>)}</section>; })}</div><Button variant="outline" onClick={() => onAdd('other', 'New production requirement')}><Plus className="size-4" /> Add checklist item</Button></main>;
}

export default ProductionTab;

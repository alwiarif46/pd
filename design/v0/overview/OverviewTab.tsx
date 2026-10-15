import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { EmptyState } from '../common/EmptyState'
import { SourceLink } from '../common/SourceLink'
import type { OverviewTabProps } from './types'

export type { OverviewTabProps } from './types'

export function OverviewTab({ facts, kickoff, countdown, selectedRowId, onOpenRow, onOpenSource, onEditFact, onConfirmFact, onAddFact, onToggleKickoff, onSetKickoffOwner, onAddKickoff, onJumpToRow }: OverviewTabProps) {
  const [newField, setNewField] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newKickoff, setNewKickoff] = useState('')

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-line bg-paper p-5">
        <p className="text-sm text-muted-foreground">Deadline</p>
        {countdown ? <div className="flex flex-wrap items-end gap-x-6 gap-y-2"><div><p className="font-numeric text-4xl font-bold">{countdown.daysLeft === 0 ? 'Due today' : countdown.daysLeft < 0 ? 'Past due' : `${countdown.daysLeft} days`}</p><p className="font-numeric text-sm text-muted-foreground">{countdown.workdaysLeft} workdays remaining</p></div><p className="text-sm text-muted-foreground">Due {countdown.dueDate}{countdown.dueTime ? ` at ${countdown.dueTime}` : ''}{countdown.timeZone ? ` ${countdown.timeZone}` : ''}</p></div> : <p className="mt-2 text-sm text-muted-foreground">No due date has been set.</p>}
      </section>

      <section className="overflow-hidden rounded-lg border border-line bg-paper">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4"><div><h2 className="font-semibold">Bid facts</h2><p className="text-sm text-muted-foreground">Confirm extracted facts before relying on them.</p></div><form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (newField && newValue) { onAddFact(newField, newValue); setNewField(''); setNewValue('') } }}><Input aria-label="New fact field" value={newField} onChange={(event) => setNewField(event.target.value)} placeholder="Field" /><Input aria-label="New fact value" value={newValue} onChange={(event) => setNewValue(event.target.value)} placeholder="Value" /><Button type="submit" size="sm">Add fact</Button></form></header>
        {facts.length ? <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead><tr className="border-b border-line text-muted-foreground"><th className="p-3">Field</th><th className="p-3">Value</th><th className="p-3">Source</th><th className="p-3">Confirmed</th></tr></thead><tbody>{facts.map((fact) => <tr key={fact.id} className={selectedRowId === fact.id ? 'border-l-4 border-primary bg-weekend' : 'border-b border-line last:border-0'}><td className="p-3 align-top"><button type="button" className="font-medium underline underline-offset-2" onClick={() => onOpenRow(fact.id)}>{fact.field}</button>{fact.amendment.kind === 'superseded' && <button type="button" className="mt-1 block text-xs text-muted-foreground underline" onClick={() => onJumpToRow(fact.amendment.replacedById)}>Superseded by Amd {fact.amendment.amendmentNo}</button>}{fact.amendment.kind === 'added' && <span className="mt-1 block text-xs text-muted-foreground">Added by Amd {fact.amendment.amendmentNo}</span>}</td><td className={fact.amendment.kind === 'superseded' ? 'p-3 align-top line-through' : 'p-3 align-top'}>{fact.value}</td><td className="p-3 align-top"><SourceLink page={fact.sourcePage} pageEnd={fact.sourcePageEnd} rowLabel={fact.field} onOpen={() => onOpenSource(fact.id)} /></td><td className="p-3 align-top"><Checkbox aria-label={`Confirm ${fact.field}`} checked={fact.confirmed} onCheckedChange={(checked) => onConfirmFact(fact.id, checked === true)} /></td></tr>)}</tbody></table></div> : <EmptyState title="No bid facts" text="Add a fact by hand or upload the solicitation." action={{ label: 'Add fact', onClick: () => onAddFact('New field', 'New value') }} />}
      </section>

      <section className="rounded-lg border border-line bg-paper p-4"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">Kickoff checklist</h2><p className="text-sm text-muted-foreground">Assign the first actions for this bid.</p></div><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (newKickoff) { onAddKickoff(newKickoff); setNewKickoff('') } }}><Input aria-label="New kickoff item" value={newKickoff} onChange={(event) => setNewKickoff(event.target.value)} placeholder="Add item" /><Button type="submit" size="sm">Add</Button></form></div><div className="mt-4 flex flex-col gap-3">{kickoff.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 border-t border-line pt-3"><Checkbox aria-label={`Mark ${item.label} done`} checked={item.done} onCheckedChange={(checked) => onToggleKickoff(item.id, checked === true)} /><span className={item.done ? 'flex-1 line-through text-muted-foreground' : 'flex-1'}>{item.label}</span><Input aria-label={`Owner for ${item.label}`} className="max-w-40" value={item.owner ?? ''} onChange={(event) => onSetKickoffOwner(item.id, event.target.value)} placeholder="Owner" /></div>)}</div></section>
    </div>
  )
}

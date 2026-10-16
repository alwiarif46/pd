import { useState } from 'react'
import type { FormStatus, Role } from '@/types'
import { ConfirmDialog } from '@/ui/shell/ConfirmDialog'
import { BidSettings } from './BidSettings'
import { DateChangePrompt } from './DateChangePrompt'
import { settingsSample } from './sample-data'
import type { BidSettingsValues } from './types'

const idle: FormStatus = { state: 'idle' }
const scenarios: Array<{ label: string; role: Role; plan: 'free' | 'growth'; saveStatus: FormStatus; deleteStatus: FormStatus }> = [
  { label: 'Owner · Growth', role: 'owner', plan: 'growth', saveStatus: idle, deleteStatus: idle },
  { label: 'Member · Growth', role: 'member', plan: 'growth', saveStatus: idle, deleteStatus: idle },
  { label: 'Owner · Free', role: 'owner', plan: 'free', saveStatus: idle, deleteStatus: idle },
  { label: 'Saving', role: 'owner', plan: 'growth', saveStatus: { state: 'submitting' }, deleteStatus: idle },
  { label: 'Save error', role: 'owner', plan: 'growth', saveStatus: { state: 'error', message: 'Unable to save your changes.' }, deleteStatus: idle },
  { label: 'Delete dialog', role: 'owner', plan: 'growth', saveStatus: idle, deleteStatus: idle },
  { label: 'Date prompt', role: 'owner', plan: 'growth', saveStatus: idle, deleteStatus: idle },
]

export function Preview() {
  const [selected, setSelected] = useState(0)
  const [bid, setBid] = useState<BidSettingsValues>(settingsSample)
  const [datePromptOpen, setDatePromptOpen] = useState(false)
  const scenario = scenarios[selected]
  const showDeleteDialog = selected === 5
  const showDatePrompt = selected === 6 || datePromptOpen
  return (
    <div className="min-h-screen bg-canvas p-4 text-ink md:p-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <nav className="flex flex-wrap gap-2" aria-label="Preview scenarios">
          {scenarios.map((item, index) => <button key={item.label} className={`rounded-md border px-3 py-2 text-sm ${selected === index ? 'border-primary bg-primary text-primary-foreground' : 'border-line bg-paper'}`} onClick={() => setSelected(index)}>{item.label}</button>)}
        </nav>
        <div className="rounded-lg border border-line bg-canvas p-4">
          <BidSettings bid={bid} plan={scenario.plan} isOwner={scenario.role === 'owner'} filesLiveUntil="2027-02-01" creditStatus="reserved" saveStatus={scenario.saveStatus} deleteStatus={scenario.deleteStatus} onSave={setBid} onDeleteBid={() => undefined} />
        </div>
        <button className="text-sm text-primary underline" onClick={() => setDatePromptOpen(true)}>Open DateChangePrompt</button>
        <ConfirmDialog open={showDeleteDialog} title={`Delete ${bid.name}?`} body="This action cannot be undone." confirmLabel="Delete bid" typeToConfirm={bid.name} busy={false} onConfirm={() => undefined} onCancel={() => setSelected(0)} />
        <DateChangePrompt open={showDatePrompt} previousDue="2026-10-27" nextDue="2026-11-03" onChoose={() => { setDatePromptOpen(false); setSelected(0) }} onCancel={() => { setDatePromptOpen(false); setSelected(0) }} />
      </div>
    </div>
  )
}

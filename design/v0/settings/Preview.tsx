import { useState } from 'react'
import type { FormStatus, Role } from '@/types'
import { ConfirmDialog } from '@/ui/shell/ConfirmDialog'
import { BidSettings } from './BidSettings'
import { DateChangePrompt } from './DateChangePrompt'
import { settingsSample } from './sample-data'
import type { BidSettingsProps, BidSettingsValues } from './types'

type CreditStatus = BidSettingsProps['creditStatus']
type Dialog = 'none' | 'delete' | 'date'

const idle: FormStatus = { state: 'idle' }
const scenarios: Array<{ label: string; role: Role; plan: 'free' | 'growth'; creditStatus: CreditStatus; saveStatus: FormStatus; deleteStatus: FormStatus; dialog: Dialog }> = [
  { label: 'Owner · Growth', role: 'owner', plan: 'growth', creditStatus: 'reserved', saveStatus: idle, deleteStatus: idle, dialog: 'none' },
  { label: 'Member · Growth', role: 'member', plan: 'growth', creditStatus: 'reserved', saveStatus: idle, deleteStatus: idle, dialog: 'none' },
  { label: 'Owner · Free', role: 'owner', plan: 'free', creditStatus: 'reserved', saveStatus: idle, deleteStatus: idle, dialog: 'none' },
  { label: 'Member · Free', role: 'member', plan: 'free', creditStatus: 'reserved', saveStatus: idle, deleteStatus: idle, dialog: 'none' },
  { label: 'Saving', role: 'owner', plan: 'growth', creditStatus: 'reserved', saveStatus: { state: 'submitting' }, deleteStatus: idle, dialog: 'none' },
  { label: 'Save error', role: 'owner', plan: 'growth', creditStatus: 'reserved', saveStatus: { state: 'error', message: 'Unable to save your changes.' }, deleteStatus: idle, dialog: 'none' },
  { label: 'Saved', role: 'owner', plan: 'growth', creditStatus: 'reserved', saveStatus: { state: 'done', message: 'Saved.' }, deleteStatus: idle, dialog: 'none' },
  { label: 'Delete · consumed credit', role: 'owner', plan: 'growth', creditStatus: 'consumed', saveStatus: idle, deleteStatus: idle, dialog: 'delete' },
  { label: 'Delete · reserved credit', role: 'owner', plan: 'growth', creditStatus: 'reserved', saveStatus: idle, deleteStatus: idle, dialog: 'delete' },
  { label: 'Delete error', role: 'owner', plan: 'growth', creditStatus: 'consumed', saveStatus: idle, deleteStatus: { state: 'error', message: 'The bid could not be deleted. Try again.' }, dialog: 'delete' },
  { label: 'Date prompt', role: 'owner', plan: 'growth', creditStatus: 'reserved', saveStatus: idle, deleteStatus: idle, dialog: 'date' },
]

const creditSentences = {
  consumed: 'The RFP credit used for this bid is not returned.',
  reserved: 'The reserved RFP credit is released.',
  none: '',
} as const

export function Preview() {
  const [selected, setSelected] = useState(0)
  const [bid, setBid] = useState<BidSettingsValues>(settingsSample)
  const [datePromptOpen, setDatePromptOpen] = useState(false)
  const scenario = scenarios[selected]
  const showDeleteDialog = scenario.dialog === 'delete'
  const showDatePrompt = scenario.dialog === 'date' || datePromptOpen
  const deleteBody = ['This deletes the bid, its files, its archive copies, and every tab.', creditSentences[scenario.creditStatus], scenario.deleteStatus.state === 'error' ? scenario.deleteStatus.message : ''].filter(Boolean).join(' ')
  return (
    <div className="min-h-screen bg-canvas p-4 text-ink md:p-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <nav className="flex flex-wrap gap-2" aria-label="Preview scenarios">
          {scenarios.map((item, index) => <button key={item.label} className={`rounded-md border px-3 py-2 text-sm ${selected === index ? 'border-primary bg-primary text-primary-foreground' : 'border-line bg-paper'}`} onClick={() => setSelected(index)}>{item.label}</button>)}
        </nav>
        <div className="rounded-lg border border-line bg-canvas p-4">
          <BidSettings bid={bid} plan={scenario.plan} isOwner={scenario.role === 'owner'} filesLiveUntil="2027-02-01" creditStatus={scenario.creditStatus} saveStatus={scenario.saveStatus} deleteStatus={scenario.deleteStatus} onSave={setBid} onDeleteBid={() => undefined} />
        </div>
        <button className="text-sm text-primary underline" onClick={() => setDatePromptOpen(true)}>Open DateChangePrompt</button>
        <ConfirmDialog open={showDeleteDialog} title={`Delete ${bid.name}?`} body={deleteBody} confirmLabel="Delete bid" typeToConfirm={bid.name} busy={false} onConfirm={() => undefined} onCancel={() => setSelected(0)} />
        <DateChangePrompt open={showDatePrompt} previousDue="2026-11-03" nextDue="2026-11-13" onChoose={() => { setDatePromptOpen(false); setSelected(0) }} onCancel={() => { setDatePromptOpen(false); setSelected(0) }} />
      </div>
    </div>
  )
}

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/ui/shell/ConfirmDialog';
import type { BidSettingsProps, BidSettingsValues } from './types';

const timeZones = [
  ['America/New_York', 'Eastern'],
  ['America/Chicago', 'Central'],
  ['America/Denver', 'Mountain'],
  ['America/Los_Angeles', 'Pacific'],
  ['America/Anchorage', 'Alaska'],
  ['Pacific/Honolulu', 'Hawaii'],
] as const;

const creditSentences = {
  consumed: 'The RFP credit used for this bid is not returned.',
  reserved: 'The reserved RFP credit is released.',
  none: '',
} as const;

function localDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(year, month - 1, day),
  );
}

export function BidSettings({
  bid,
  plan,
  isOwner,
  filesLiveUntil,
  creditStatus,
  saveStatus,
  deleteStatus,
  onSave,
  onDeleteBid,
}: BidSettingsProps) {
  const [values, setValues] = useState(bid);
  const [synced, setSynced] = useState(bid);
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (bid !== synced) {
    setSynced(bid);
    setValues(bid);
  }
  const disabled = saveStatus.state === 'submitting';
  const set = <K extends keyof BidSettingsValues>(key: K, value: BidSettingsValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const canKeepLive = isOwner && plan !== 'free';
  const liveHelp =
    plan === 'free'
      ? 'Paid plans can keep files live longer.'
      : isOwner
        ? `Files stay live until ${filesLiveUntil ? localDate(filesLiveUntil) : 'the selected date'} unless you extend it. After that they move to the archive.`
        : 'Only the bid owner can change this.';
  const creditSentence = creditSentences[creditStatus];
  const deleteBody = [
    'This deletes the bid, its files, its archive copies, and every tab.',
    creditSentence,
    deleteStatus.state === 'error' ? deleteStatus.message : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <section className="flex max-w-3xl flex-col gap-6 text-ink">
      <header>
        <h1 className="text-2xl font-semibold">Bid settings</h1>
      </header>
      <form
        className="flex flex-col gap-5 rounded-lg border border-line bg-paper p-6"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(values);
        }}
      >
        <fieldset disabled={disabled} className="flex flex-col gap-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Name
              <Input value={values.name} onChange={(e) => set('name', e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Agency
              <Input value={values.agency} onChange={(e) => set('agency', e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Bid type
              <Select
                value={values.bidType}
                onValueChange={(value) => set('bidType', value as BidSettingsValues['bidType'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="federal">Federal</SelectItem>
                  <SelectItem value="sled">SLED</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Solicitation number
              <Input value={values.solicitationNumber} onChange={(e) => set('solicitationNumber', e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Start date
              <Input
                type="date"
                value={values.startDate ?? ''}
                onChange={(e) => set('startDate', e.target.value || null)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Due date
              <Input
                type="date"
                value={values.dueDate ?? ''}
                onChange={(e) => set('dueDate', e.target.value || null)}
              />
            </label>
            <p className="text-xs text-muted-foreground md:col-span-2">
              Changing the due date asks how to move the schedule.
            </p>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Due time
              <Input
                type="time"
                value={values.dueTime ?? ''}
                onChange={(e) => set('dueTime', e.target.value || null)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Time zone
              <Select value={values.timeZone} onValueChange={(value) => set('timeZone', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timeZones.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <label className="flex items-center justify-between gap-4 text-sm font-medium">
            Show the Orals tab
            <Switch checked={values.oralsEnabled} onCheckedChange={(value) => set('oralsEnabled', value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Keep files live until
            <Input
              disabled={!canKeepLive}
              type="date"
              value={values.keepFilesLiveUntil ?? ''}
              onChange={(e) => set('keepFilesLiveUntil', e.target.value || null)}
            />
            <span className="text-xs font-normal text-muted-foreground">{liveHelp}</span>
          </label>
        </fieldset>
        {saveStatus.state === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            {saveStatus.message}
          </p>
        )}
        {saveStatus.state === 'done' && (
          <p role="status" className="text-sm text-muted-foreground">
            {saveStatus.message}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => setValues(bid)}>
            Discard changes
          </Button>
          <Button type="submit" disabled={disabled}>
            {disabled ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
      <section className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-6">
        <h2 className="text-lg font-semibold">Delete this bid</h2>
        <p className="text-sm text-muted-foreground">
          This deletes the bid, its files, its archive copies, and every tab.
        </p>
        {creditSentence && <p className="text-sm text-muted-foreground">{creditSentence}</p>}
        <Button
          variant="destructive"
          disabled={deleteStatus.state === 'submitting'}
          onClick={() => setConfirmOpen(true)}
        >
          Delete bid
        </Button>
        {deleteStatus.state === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            {deleteStatus.message}
          </p>
        )}
        <ConfirmDialog
          open={confirmOpen}
          title={`Delete ${bid.name}?`}
          body={deleteBody}
          confirmLabel="Delete bid"
          typeToConfirm={bid.name}
          busy={deleteStatus.state === 'submitting'}
          onConfirm={onDeleteBid}
          onCancel={() => setConfirmOpen(false)}
        />
      </section>
    </section>
  );
}

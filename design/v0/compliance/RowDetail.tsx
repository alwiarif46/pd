import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import type { RowFlag } from '@/types'
import type { RowDetailProps } from './types'

const flagLabel: Record<RowFlag, string> = {
  maybe_not_requirement: 'May not be a requirement',
  page_estimated: 'Page estimated',
  ocr: 'OCR',
  quote_unverified: 'Quote not verified',
}

function formatAt(at: string) {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function RowDetail({ open, row, history, federal, editFields, saveStatus, onClose, onOpenSource, onSave, onJumpToRow }: RowDetailProps) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [seenStatus, setSeenStatus] = useState(saveStatus.state)
  if (saveStatus.state !== seenStatus) {
    setSeenStatus(saveStatus.state)
    if (saveStatus.state === 'done') setEditingId(null)
  }
  useEffect(() => {
    if (open) heading.current?.focus()
  }, [open, row?.id])
  if (!open) return null

  const editing = row !== null && editingId === row.id
  const replacedById = row !== null && row.amendment.kind === 'superseded' ? row.amendment.replacedById : null

  const startEdit = () => {
    if (!row) return
    setValues(Object.fromEntries(editFields.map((f) => [f.key, f.value])))
    setEditingId(row.id)
  }
  const save = () => {
    const changed: Record<string, string> = {}
    for (const field of editFields) {
      if ((values[field.key] ?? '') !== field.value) changed[field.key] = values[field.key] ?? ''
    }
    if (Object.keys(changed).length === 0) {
      setEditingId(null)
      return
    }
    onSave(changed)
  }

  let amendment: React.ReactNode = null
  if (row) {
    if (row.amendment.kind === 'original') amendment = 'Original'
    else if (row.amendment.kind === 'added') amendment = `Added by Amd ${row.amendment.amendmentNo}`
    else if (row.amendment.kind === 'withdrawn') amendment = `Withdrawn by Amd ${row.amendment.amendmentNo}`
    else if (replacedById !== null) {
      amendment = (
        <Button type="button" variant="link" className="h-auto p-0" onClick={() => onJumpToRow(replacedById)}>
          Superseded by Amd {row.amendment.amendmentNo}
        </Button>
      )
    } else amendment = `Superseded by Amd ${row.amendment.amendmentNo}`
  }

  const verified = row === null ? null : (row.quoteVerified ?? row.confirmed)
  const fields: [string, React.ReactNode][] = row
    ? [
        ['Section reference', row.sectionRef],
        ['Document', row.documentName],
        ['Page', row.sourcePage === null ? null : row.sourcePageEnd !== null && row.sourcePageEnd !== row.sourcePage ? `${row.sourcePage}–${row.sourcePageEnd}` : String(row.sourcePage)],
        ['Amendment', amendment],
        ['Requirement type', row.reqType],
        [federal ? 'L ref' : 'Instruction ref', row.instrRef],
        [federal ? 'M factor' : 'Evaluation factor', row.evalRef],
        ['Confidence', row.confidence === null ? null : `${Math.round(row.confidence * 100)}%`],
        [
          'Flags',
          row.flags.length ? (
            <span className="flex flex-wrap gap-1">
              {row.flags.map((flag) => (
                <Badge key={flag} variant="outline">
                  {flagLabel[flag]}
                </Badge>
              ))}
            </span>
          ) : null,
        ],
        ['Verified', verified === null ? null : verified ? 'Yes' : 'No'],
        ['Owner', row.owner],
        ['Status', row.status],
        ['Origin', row.origin === null ? null : row.origin === 'ai' ? 'AI' : 'User'],
      ]
    : []

  return (
    <div className="flex min-h-full w-full flex-col gap-4" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="flex items-start justify-between gap-3">
        <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
          {row?.title ?? 'Loading row detail'}
        </h2>
        <Button variant="ghost" size="icon" aria-label="Close row detail" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      {!row ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-5 w-2/3" />
          ))}
        </div>
      ) : editing ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <h3 className="font-semibold">Edit row</h3>
          {editFields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1 text-sm font-medium">
              {field.label}
              {field.kind === 'longtext' ? (
                <Textarea disabled={saveStatus.state === 'submitting'} value={values[field.key] ?? ''} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} />
              ) : field.kind === 'select' ? (
                <Select disabled={saveStatus.state === 'submitting'} value={values[field.key] ?? ''} onValueChange={(v) => setValues({ ...values, [field.key]: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options?.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  disabled={saveStatus.state === 'submitting'}
                  type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                />
              )}
            </label>
          ))}
          {saveStatus.state === 'error' && (
            <p role="alert" className="text-sm text-due">
              {saveStatus.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={saveStatus.state === 'submitting'}>
              {saveStatus.state === 'submitting' ? 'Saving…' : 'Save changes'}
            </Button>
            <Button type="button" variant="outline" disabled={saveStatus.state === 'submitting'} onClick={() => setEditingId(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-5 overflow-y-auto">
          {saveStatus.state === 'done' && (
            <p role="status" className="text-sm text-today">
              {saveStatus.message}
            </p>
          )}
          {row.sourceQuote && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Verbatim source text</h3>
              <blockquote className="whitespace-pre-wrap border-l-2 border-primary bg-canvas p-3 text-sm">{row.sourceQuote}</blockquote>
            </div>
          )}
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {fields.map(([label, value]) =>
              value === null || value === undefined ? null : (
                <div key={label}>
                  <dt className="font-medium">{label}</dt>
                  <dd className="text-muted-foreground">{value}</dd>
                </div>
              ),
            )}
          </dl>
          <section>
            <h3 className="font-semibold">Edit history</h3>
            {history.length ? (
              <div className="mt-2 flex flex-col gap-2 text-sm">
                {history.map((entry) => (
                  <p key={entry.id} className="border-b border-line pb-2">
                    <strong>{entry.who}</strong> changed {entry.field} from {entry.from ?? 'empty'} to {entry.to ?? 'empty'}{' '}
                    <time dateTime={entry.at} className="text-muted-foreground">
                      {formatAt(entry.at)}
                    </time>
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">No changes yet.</p>
            )}
          </section>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={row.sourcePage === null} onClick={onOpenSource}>
              Open source
            </Button>
            <Button onClick={startEdit}>Edit</Button>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

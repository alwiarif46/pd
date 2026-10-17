import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { SourceLink } from '@/ui/common/SourceLink'
import { EmptyState } from '@/ui/common/EmptyState'
import { ConfirmDialog } from '@/ui/shell/ConfirmDialog'
import type { ComplianceFilters, ComplianceMatrixTabProps, ComplianceRow, NewComplianceRow } from './types'
import type { ReqType, RowFlag, RowStatus } from '@/types'

const statuses: RowStatus[] = ['open', 'assigned', 'drafted', 'done']
const reqTypes: ReqType[] = ['shall', 'must', 'will', 'should', 'other']
const flagLabel: Record<RowFlag, string> = {
  maybe_not_requirement: 'May not be a requirement',
  page_estimated: 'Page estimated',
  ocr: 'OCR',
  quote_unverified: 'Quote not verified',
}
const emptyFilters: ComplianceFilters = {
  section: null,
  type: null,
  status: null,
  owner: null,
  amendment: null,
  flaggedOnly: false,
  hideClosed: false,
  checkThese: false,
  search: '',
}
const emptyNewRow: NewComplianceRow = { requirement: '', sectionRef: null, type: null, owner: null }

function activeFilterCount(f: ComplianceFilters) {
  return [
    f.section !== null,
    f.type !== null,
    f.status !== null,
    f.owner !== null,
    f.amendment !== null,
    f.flaggedOnly,
    f.hideClosed,
    f.checkThese,
    f.search !== '',
  ].filter(Boolean).length
}

function RequirementCell({ row, onOpenRow, closed }: { row: ComplianceRow; onOpenRow: () => void; closed: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const long = row.requirement.length > 240 || row.requirement.split('\n').length > 4
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        className={`whitespace-pre-line text-left hover:underline ${closed ? 'line-through' : ''} ${expanded ? '' : 'line-clamp-4'}`}
        onClick={onOpenRow}
      >
        {row.requirement}
      </button>
      {long && (
        <Button type="button" variant="link" size="sm" className="h-auto p-0" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
      <div className="flex flex-wrap gap-1">
        {row.flags.map((f) => (
          <Badge key={f} variant="outline">
            {flagLabel[f]}
          </Badge>
        ))}
        {row.origin === 'user' && <Badge variant="secondary">Added by user</Badge>}
      </div>
    </div>
  )
}

function AmendmentCell({ row, onJumpToRow }: { row: ComplianceRow; onJumpToRow: (id: string) => void }) {
  const amendment = row.amendment
  const replacedById = amendment.kind === 'superseded' ? amendment.replacedById : null
  if (amendment.kind === 'original') return <span>Original</span>
  if (amendment.kind === 'added') return <Badge variant="secondary">Added by Amd {amendment.amendmentNo}</Badge>
  if (amendment.kind === 'withdrawn') {
    return (
      <div className="flex flex-col items-start gap-1">
        <Badge variant="outline">Withdrawn</Badge>
        <span>Withdrawn by Amd {amendment.amendmentNo}</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant="outline">Superseded</Badge>
      {replacedById !== null && (
        <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => onJumpToRow(replacedById)}>
          Superseded by Amd {amendment.amendmentNo}
        </Button>
      )}
    </div>
  )
}

function MatrixRow({
  row,
  props,
  selected,
  checked,
  onCheck,
  onSplit,
  onDelete,
}: {
  row: ComplianceRow
  props: ComplianceMatrixTabProps
  selected: boolean
  checked: boolean
  onCheck: (value: boolean) => void
  onSplit: () => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  const closed = row.amendment.kind === 'withdrawn' || row.amendment.kind === 'superseded'
  const stickyBg = selected ? 'bg-weekend' : 'bg-paper'
  return (
    <TableRow
      ref={ref}
      data-state={selected ? 'selected' : undefined}
      className={`${closed ? 'text-muted-foreground' : ''} ${selected ? 'bg-weekend' : ''}`}
    >
      <TableCell className={`sticky left-0 z-10 ${stickyBg} ${selected ? 'border-l-4 border-l-primary' : ''}`}>
        <Checkbox aria-label={`Select ${row.reqId}`} checked={checked} onCheckedChange={(v) => onCheck(v === true)} />
      </TableCell>
      <TableCell className={`sticky left-12 z-10 ${stickyBg} font-semibold`}>
        <Button variant="link" className="p-0" onClick={() => props.onOpenRow(row.id)}>
          {row.reqId}
        </Button>
      </TableCell>
      <TableCell>{row.sectionRef ?? '—'}</TableCell>
      <TableCell className="min-w-72 whitespace-normal">
        <RequirementCell row={row} closed={closed} onOpenRow={() => props.onOpenRow(row.id)} />
      </TableCell>
      <TableCell>{row.type ?? '—'}</TableCell>
      <TableCell>{row.instrRef ?? '—'}</TableCell>
      <TableCell>{row.evalRef ?? '—'}</TableCell>
      <TableCell>{row.responseSection ?? '—'}</TableCell>
      <TableCell>
        <Select value={row.owner ?? 'none'} onValueChange={(v) => props.onEditRow(row.id, { owner: v === 'none' ? null : v })}>
          <SelectTrigger className="min-w-32" aria-label={`Owner for ${row.reqId}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Unassigned</SelectItem>
            {props.owners.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Select value={row.status} onValueChange={(v) => props.onEditRow(row.id, { status: v as RowStatus })}>
          <SelectTrigger className="min-w-28" aria-label={`Status for ${row.reqId}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statuses.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        {row.origin === 'user' && row.sourcePage === null ? (
          <span className="text-sm text-muted-foreground">Added by user</span>
        ) : (
          <SourceLink page={row.sourcePage} pageEnd={row.sourcePageEnd} rowLabel={row.reqId} onOpen={() => props.onOpenSource(row.id)} />
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-start gap-1">
          <AmendmentCell row={row} onJumpToRow={props.onJumpToRow} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={`Actions for ${row.reqId}`}>
                …
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => props.onOpenRow(row.id)}>Open details</DropdownMenuItem>
              <DropdownMenuItem onClick={onSplit}>Split row</DropdownMenuItem>
              <DropdownMenuItem onClick={onDelete}>Delete row</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  )
}

function AddRequirementForm({ owners, onAddRow, onDone }: { owners: string[]; onAddRow: (row: NewComplianceRow) => void; onDone: () => void }) {
  const [newRow, setNewRow] = useState<NewComplianceRow>(emptyNewRow)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        onAddRow(newRow)
        onDone()
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        Requirement
        <Textarea required value={newRow.requirement} onChange={(e) => setNewRow({ ...newRow, requirement: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Section
        <Input value={newRow.sectionRef ?? ''} onChange={(e) => setNewRow({ ...newRow, sectionRef: e.target.value || null })} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Type
        <Select value={newRow.type ?? 'none'} onValueChange={(v) => setNewRow({ ...newRow, type: v === 'none' ? null : (v as ReqType) })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Not set</SelectItem>
            {reqTypes.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Owner
        <Select value={newRow.owner ?? 'none'} onValueChange={(v) => setNewRow({ ...newRow, owner: v === 'none' ? null : v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Unassigned</SelectItem>
            {owners.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <DialogFooter>
        <Button type="submit">Add requirement</Button>
      </DialogFooter>
    </form>
  )
}

function SplitRowForm({ row, onSplitRow, onDone }: { row: ComplianceRow; onSplitRow: (id: string, at: number) => void; onDone: () => void }) {
  const [value, setValue] = useState('')
  const at = value === '' ? NaN : Number(value)
  const valid = Number.isInteger(at) && at >= 1 && at <= row.requirement.length - 1
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Split after character
        <Input type="number" min={1} max={row.requirement.length - 1} step={1} value={value} onChange={(e) => setValue(e.target.value)} />
        <span className="text-xs font-normal text-muted-foreground">Enter a number from 1 to {row.requirement.length - 1}.</span>
      </label>
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">First part</p>
        <p className="whitespace-pre-wrap rounded border border-line bg-canvas p-3">{valid ? row.requirement.slice(0, at) : row.requirement}</p>
        <p className="font-medium">Second part</p>
        <p className="whitespace-pre-wrap rounded border border-line bg-canvas p-3">{valid ? row.requirement.slice(at) : ''}</p>
      </div>
      <DialogFooter>
        <Button
          disabled={!valid}
          onClick={() => {
            onSplitRow(row.id, at)
            onDone()
          }}
        >
          Split row
        </Button>
      </DialogFooter>
    </div>
  )
}

export function ComplianceMatrixTab(props: ComplianceMatrixTabProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [splitRow, setSplitRow] = useState<ComplianceRow | null>(null)
  const [deleteRow, setDeleteRow] = useState<ComplianceRow | null>(null)
  const update = (change: Partial<ComplianceFilters>) => props.onFiltersChange({ ...props.filters, ...change })
  const selectedIds = props.rows.filter((r) => selected.includes(r.id)).map((r) => r.id)
  const activeCount = activeFilterCount(props.filters)
  const clearFilters = () => props.onFiltersChange(emptyFilters)

  const filterControls = (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Section
        <Select value={props.filters.section ?? 'all'} onValueChange={(v) => update({ section: v === 'all' ? null : v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sections</SelectItem>
            {props.sections.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Type
        <Select value={props.filters.type ?? 'all'} onValueChange={(v) => update({ type: v === 'all' ? null : (v as ReqType) })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {reqTypes.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Status
        <Select value={props.filters.status ?? 'all'} onValueChange={(v) => update({ status: v === 'all' ? null : (v as RowStatus) })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {statuses.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Owner
        <Select value={props.filters.owner ?? 'all'} onValueChange={(v) => update({ owner: v === 'all' ? null : v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All owners</SelectItem>
            {props.owners.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Amendment
        <Select
          value={props.filters.amendment === null ? 'all' : String(props.filters.amendment)}
          onValueChange={(v) => update({ amendment: v === 'all' ? null : v === 'original' ? 'original' : Number(v) })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All amendments</SelectItem>
            <SelectItem value="original">Original</SelectItem>
            {props.amendments.map((v) => (
              <SelectItem key={v} value={String(v)}>
                Amd {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium sm:col-span-2">
        Search requirements
        <Input value={props.filters.search} onChange={(e) => update({ search: e.target.value })} />
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={props.filters.flaggedOnly} onCheckedChange={(v) => update({ flaggedOnly: v === true })} /> Flagged
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={props.filters.hideClosed} onCheckedChange={(v) => update({ hideClosed: v === true })} /> Hide superseded and withdrawn
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={props.filters.checkThese} onCheckedChange={(v) => update({ checkThese: v === true })} /> Check these
        </label>
        <Button variant="link" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      </div>
    </div>
  )

  const headers = [
    'Section',
    'Requirement',
    'Type',
    props.federal ? 'L ref' : 'Instruction ref',
    props.federal ? 'M factor' : 'Evaluation factor',
    'Response section',
    'Owner',
    'Status',
    'Source',
    'Amendment',
  ]

  let body
  if (props.filters.checkThese) {
    body = (
      <div className="rounded-lg border border-line bg-paper p-4">
        <h2 className="font-semibold">Check these: sentences the pre-scan found that have no row</h2>
        {props.checkThese.length ? (
          props.checkThese.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-0">
              <p className="flex-1">
                {item.sentence} <span className="text-sm text-muted-foreground">p. {item.page}</span>
              </p>
              <Button size="sm" onClick={() => props.onPromoteCheckThese(item.id)}>
                Add as requirement
              </Button>
              <Button size="sm" variant="outline" onClick={() => props.onDismissCheckThese(item.id)}>
                Dismiss
              </Button>
            </div>
          ))
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Nothing to check.</p>
        )}
      </div>
    )
  } else if (props.rows.length === 0 && props.totalRows === 0) {
    body = <EmptyState title="No requirements found" text="Add one by hand." action={{ label: 'Add requirement', onClick: () => setAddOpen(true) }} />
  } else if (props.rows.length === 0) {
    body = <EmptyState title="No rows match these filters" text="Change or clear the filters to see more rows." action={{ label: 'Clear filters', onClick: clearFilters }} />
  } else {
    body = (
      <div className="overflow-x-auto rounded-lg border border-line bg-paper" role="region" aria-label="Compliance matrix" tabIndex={0}>
        <Table className="min-w-[1450px]">
          <caption className="sr-only">Compliance matrix</caption>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-20 w-12 bg-canvas">Select</TableHead>
              <TableHead className="sticky left-12 z-20 bg-canvas">ID</TableHead>
              {headers.map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.rows.map((row) => (
              <MatrixRow
                key={row.id}
                row={row}
                props={props}
                selected={props.selectedRowId === row.id}
                checked={selected.includes(row.id)}
                onCheck={(v) => setSelected((s) => (v ? [...s, row.id] : s.filter((id) => id !== row.id)))}
                onSplit={() => setSplitRow(row)}
                onDelete={() => setDeleteRow(row)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    )
  }

  return (
    <section className="flex min-w-0 flex-col gap-4 text-ink">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setAddOpen(true)}>Add requirement</Button>
        <Button variant="outline" disabled={selectedIds.length < 2} onClick={() => props.onMergeRows(selectedIds)}>
          Merge selected{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Export</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => props.onExport('xlsx')}>Export XLSX</DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onExport('csv')}>Export CSV</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" className="sm:hidden">
              Filters ({activeCount})
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="p-4">{filterControls}</div>
          </SheetContent>
        </Sheet>
        <span className="ml-auto text-sm text-muted-foreground">
          Showing {props.rows.length} of {props.totalRows} rows
        </span>
      </div>
      <div className="hidden rounded-lg border border-line bg-paper p-4 sm:block">{filterControls}</div>
      {body}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add requirement</DialogTitle>
          </DialogHeader>
          <AddRequirementForm owners={props.owners} onAddRow={props.onAddRow} onDone={() => setAddOpen(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={splitRow !== null} onOpenChange={(open) => !open && setSplitRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Split row</DialogTitle>
          </DialogHeader>
          {splitRow && <SplitRowForm row={splitRow} onSplitRow={props.onSplitRow} onDone={() => setSplitRow(null)} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteRow !== null}
        title={`Delete ${deleteRow?.reqId ?? 'row'}?`}
        body={deleteRow?.requirement ?? ''}
        confirmLabel="Delete row"
        typeToConfirm={null}
        busy={false}
        onConfirm={() => {
          if (deleteRow) props.onDeleteRow(deleteRow.id)
          setDeleteRow(null)
        }}
        onCancel={() => setDeleteRow(null)}
      />
    </section>
  )
}

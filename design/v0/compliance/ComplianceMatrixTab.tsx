import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SourceLink } from '../common/SourceLink'
import type { ComplianceFilters, ComplianceMatrixTabProps, ComplianceRow, NewComplianceRow } from './types'
import { flagLabels, rowStatusLabels } from './types'

function amendmentText(row: ComplianceRow) {
  if (row.origin === 'user') return 'Added by user'
  if (row.amendment.kind === 'original') return 'Original'
  if (row.amendment.kind === 'added') return `Added by Amd ${row.amendment.amendmentNo}`
  if (row.amendment.kind === 'withdrawn') return `Withdrawn by Amd ${row.amendment.amendmentNo}`
  return `Superseded by Amd ${row.amendment.amendmentNo}`
}

export function ComplianceMatrixTab(props: ComplianceMatrixTabProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [newRow, setNewRow] = useState<NewComplianceRow>({ requirement: '', sectionRef: null, type: null, owner: null })
  const update = (change: Partial<ComplianceFilters>) => props.onFiltersChange({ ...props.filters, ...change })
  const flaggedRows = useMemo(() => props.rows.filter((row) => row.flags.length > 0), [props.rows])
  const toggleSelected = (id: string, checked: boolean) => setSelected((current) => checked ? [...current, id] : current.filter((item) => item !== id))
  const isClosed = (row: ComplianceRow) => row.amendment.kind === 'withdrawn' || row.amendment.kind === 'superseded'

  return (
    <section className="flex flex-col gap-4 text-ink">
      <div className="flex flex-wrap items-end gap-2">
        <Button onClick={() => setShowAdd((open) => !open)}>{showAdd ? 'Close form' : 'Add requirement'}</Button>
        <Button variant="outline" disabled={selected.length < 2} onClick={() => props.onMergeRows(selected)}>Merge selected</Button>
        <Button variant="outline" onClick={() => props.onExport('xlsx')}>Export XLSX</Button>
        <Button variant="outline" onClick={() => props.onExport('csv')}>Export CSV</Button>
        <span className="ml-auto text-sm text-muted-foreground">Showing {props.rows.length} of {props.totalRows} rows</span>
      </div>
      {showAdd && <form className="grid gap-3 rounded-lg border border-line bg-paper p-4 md:grid-cols-[1fr_160px_160px_auto]" onSubmit={(event) => { event.preventDefault(); props.onAddRow(newRow); setNewRow({ requirement: '', sectionRef: null, type: null, owner: null }); setShowAdd(false) }}>
        <label className="flex flex-col gap-1 text-sm font-medium">Requirement<Input required value={newRow.requirement} onChange={(event) => setNewRow({ ...newRow, requirement: event.target.value })} /></label>
        <label className="flex flex-col gap-1 text-sm font-medium">Section<Input value={newRow.sectionRef ?? ''} onChange={(event) => setNewRow({ ...newRow, sectionRef: event.target.value || null })} /></label>
        <label className="flex flex-col gap-1 text-sm font-medium">Owner<Input value={newRow.owner ?? ''} onChange={(event) => setNewRow({ ...newRow, owner: event.target.value || null })} /></label>
        <Button type="submit">Add row</Button>
      </form>}
      <div className="grid gap-2 rounded-lg border border-line bg-paper p-3 md:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm font-medium">Section<Select value={props.filters.section ?? 'all'} onValueChange={(value) => update({ section: value === 'all' ? null : value })}><SelectTrigger><SelectValue placeholder="All sections" /></SelectTrigger><SelectContent><SelectItem value="all">All sections</SelectItem>{props.sections.map((section) => <SelectItem key={section} value={section}>{section}</SelectItem>)}</SelectContent></Select></label>
        <label className="flex flex-col gap-1 text-sm font-medium">Status<Select value={props.filters.status ?? 'all'} onValueChange={(value) => update({ status: value === 'all' ? null : value as ComplianceFilters['status'] })}><SelectTrigger><SelectValue placeholder="All statuses" /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{Object.entries(rowStatusLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label>
        <label className="flex flex-col gap-1 text-sm font-medium">Search<Input value={props.filters.search} onChange={(event) => update({ search: event.target.value })} /></label>
        <div className="flex flex-wrap items-end gap-3 pb-2"><label className="flex items-center gap-2 text-sm"><Checkbox checked={props.filters.flaggedOnly} onCheckedChange={(checked) => update({ flaggedOnly: checked === true })} /> Flagged</label><label className="flex items-center gap-2 text-sm"><Checkbox checked={props.filters.hideClosed} onCheckedChange={(checked) => update({ hideClosed: checked === true })} /> Hide closed</label><label className="flex items-center gap-2 text-sm"><Checkbox checked={props.filters.checkThese} onCheckedChange={(checked) => update({ checkThese: checked === true })} /> Check these</label></div>
      </div>
      {props.filters.checkThese ? <div className="flex flex-col gap-2 rounded-lg border border-line bg-paper p-4"><h2 className="font-semibold">Check these</h2>{props.checkThese.map((item) => <div className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-0" key={item.id}><p className="flex-1">{item.sentence} <span className="text-sm text-muted-foreground">p. {item.page}</span></p><Button size="sm" onClick={() => props.onPromoteCheckThese(item.id)}>Add as requirement</Button><Button size="sm" variant="outline" onClick={() => props.onDismissCheckThese(item.id)}>Dismiss</Button></div>)}</div> : <div role="region" aria-label="Compliance matrix" tabIndex={0} className="overflow-x-auto rounded-lg border border-line bg-paper"><table className="w-full min-w-[1320px] text-left text-sm"><caption className="sr-only">Compliance matrix</caption><thead className="bg-canvas"><tr className="border-b border-line">{['Select', 'ID', 'Section', 'Requirement', 'Type', props.federal ? 'L ref' : 'Instruction ref', props.federal ? 'M factor' : 'Evaluation factor', 'Response section', 'Owner', 'Status', 'Source', 'Amendment'].map((heading) => <th className="p-3 font-semibold" key={heading}>{heading}</th>)}</tr></thead><tbody>{props.rows.map((row) => { const closed = isClosed(row); return <tr key={row.id} className={`border-b border-line align-top ${props.selectedRowId === row.id ? 'bg-blue-50' : ''}`}><td className="p-3"><Checkbox aria-label={`Select ${row.reqId}`} checked={selected.includes(row.id)} onCheckedChange={(checked) => toggleSelected(row.id, checked === true)} /></td><td className={`sticky left-0 p-3 font-semibold ${closed ? 'bg-paper line-through' : 'bg-paper'}`}><button className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => props.onOpenRow(row.id)}>{row.reqId}</button>{closed && <span className="ml-2 text-xs text-muted-foreground">{row.amendment.kind === 'withdrawn' ? 'Withdrawn' : 'Superseded'}</span>}</td><td className="p-3">{row.sectionRef ?? '—'}</td><td className={`max-w-[300px] p-3 ${closed ? 'line-through text-muted-foreground' : ''}`}>{row.requirement}<div className="mt-1 flex flex-wrap gap-1">{row.flags.map((flag) => <Badge variant="secondary" key={flag}>{flagLabels[flag]}</Badge>)}</div></td><td className="p-3">{row.type ?? '—'}</td><td className="p-3">{row.instrRef ?? '—'}</td><td className="p-3">{row.evalRef ?? '—'}</td><td className="p-3">{row.responseSection ?? '—'}</td><td className="p-3"><Input aria-label={`Owner for ${row.reqId}`} value={row.owner ?? ''} onChange={(event) => props.onEditRow(row.id, { owner: event.target.value || null })} /></td><td className="p-3"><Select value={row.status} onValueChange={(value) => props.onEditRow(row.id, { status: value as ComplianceRow['status'] })}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(rowStatusLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></td><td className="p-3">{row.sourcePage ? <SourceLink page={row.sourcePage} pageEnd={row.sourcePageEnd} rowLabel={row.reqId} onOpen={() => props.onOpenSource(row.id)} /> : <span className="text-muted-foreground">No source</span>}</td><td className="p-3"><button className="text-left underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => row.amendment.kind === 'superseded' && row.amendment.replacedById ? props.onJumpToRow(row.amendment.replacedById) : undefined}>{amendmentText(row)}</button></td></tr> })}</tbody></table></div>}
      {flaggedRows.length > 0 && <p className="text-sm text-muted-foreground">Flagged rows: {flaggedRows.length}. Select a row to review its source and flags.</p>}
    </section>
  )
}

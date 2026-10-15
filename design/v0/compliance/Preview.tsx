import { useState } from 'react'
import { ComplianceMatrixTab } from './ComplianceMatrixTab'
import { RowDetail } from './RowDetail'
import { SourceViewer } from './SourceViewer'
import { complianceCheckThese, complianceFilters, complianceRows } from './sample-data'
import type { ComplianceFilters } from './types'

const log = (...args: unknown[]) => console.log('[v0] compliance preview', ...args)

export function Preview() {
  const [filters, setFilters] = useState<ComplianceFilters>(complianceFilters)
  const [selected, setSelected] = useState<string | null>('r1')
  const [sourceOpen, setSourceOpen] = useState(false)
  return <main className="min-h-screen bg-canvas p-4 md:p-8"><div className="mx-auto flex max-w-[1600px] flex-col gap-6"><header><p className="text-sm text-muted-foreground">Compliance matrix</p><h1 className="text-2xl font-semibold text-ink">Review solicitation requirements</h1></header><ComplianceMatrixTab rows={complianceRows} totalRows={complianceRows.length + 2} checkThese={complianceCheckThese} filters={filters} federal sections={['C.3.2', 'C.3.4', 'C.4.1']} owners={['Dana Reyes', 'Alex Morgan']} amendments={[1]} selectedRowId={selected} onFiltersChange={setFilters} onEditRow={(id, edit) => log('edit', id, edit)} onAddRow={(row) => log('add', row)} onMergeRows={(ids) => log('merge', ids)} onSplitRow={(id, at) => log('split', id, at)} onDeleteRow={(id) => log('delete', id)} onPromoteCheckThese={(id) => log('promote', id)} onDismissCheckThese={(id) => log('dismiss', id)} onOpenRow={(id) => { setSelected(id); log('open row', id) }} onOpenSource={(id) => { setSelected(id); setSourceOpen(true); log('open source', id) }} onJumpToRow={(id) => { setSelected(id); log('jump', id) }} onExport={(format) => log('export', format)} /><RowDetail open={selected !== null && !sourceOpen} row={selected ? { ...complianceRows.find((row) => row.id === selected)!, title: selected, documentName: 'Solicitation.pdf', confidence: 0.86, confirmed: true } : null} onClose={() => setSelected(null)} onEdit={() => log('edit detail')} onOpenSource={() => setSourceOpen(true)} /><SourceViewer open={sourceOpen} fileName="Solicitation.pdf" page={12} pageEnd={13} quote="The contractor shall provide transition planning within ten business days." state="live" onClose={() => setSourceOpen(false)} onRestore={() => log('restore')} /></div></main>
}

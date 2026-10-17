import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { FormStatus } from '@/types'
import { AppShell } from '@/ui/shell/AppShell'
import { sampleBid, sampleBids, sampleUser } from '@/ui/shell/sample-data'
import { ComplianceMatrixTab } from './ComplianceMatrixTab'
import { RowDetail } from './RowDetail'
import { SourceViewer } from './SourceViewer'
import { complianceCheckThese, complianceFilters, complianceRows } from './sample-data'
import type { CheckThese, ComplianceFilters, ComplianceRow, RowDetailData, RowEditField, RowHistoryEntry, SourceView } from './types'

const log = (...args: unknown[]) => console.log('[v0] compliance preview', ...args)

const longText =
  'The contractor shall provide Tier 2 help desk support 24 hours a day, 7 days a week, 365 days a year, including federal holidays, and shall resolve or escalate every ticket within the response times in Attachment J-3. Support staff shall hold current security clearances and complete annual privacy training. The contractor shall report ticket volume, mean time to resolve and open escalations every month.'

// 12 rows: every amendment kind, every flag, user rows (with and without a page), a long requirement.
const extraRows: ComplianceRow[] = [
  { id: 'r6', reqId: 'L-001', sectionRef: 'L.4.2', requirement: 'The offeror shall submit a technical volume not to exceed 30 pages.', type: 'shall', instrRef: 'L.4.2', evalRef: 'M.1', responseSection: 'Technical volume', owner: 'Dana Reyes', status: 'drafted', sourcePage: 7, sourcePageEnd: null, sourceQuote: 'The offeror shall submit a technical volume not to exceed 30 pages.', quoteVerified: true, origin: 'ai', flags: [], amendment: { kind: 'original' } },
  { id: 'r7', reqId: 'C-006', sectionRef: 'C.3.2', requirement: longText, type: 'shall', instrRef: 'L.5', evalRef: 'M.3', responseSection: 'Operations', owner: 'Alex Morgan', status: 'assigned', sourcePage: 21, sourcePageEnd: 22, sourceQuote: longText, quoteVerified: true, origin: 'ai', flags: ['ocr'], amendment: { kind: 'original' } },
  { id: 'r8', reqId: 'C-007', sectionRef: 'C.5.1', requirement: 'The contractor will deliver a transition-out plan 60 days before the end of the period of performance.', type: 'will', instrRef: null, evalRef: 'M.4', responseSection: null, owner: null, status: 'open', sourcePage: 33, sourcePageEnd: null, sourceQuote: 'The contractor will deliver a transition-out plan 60 days before the end of the period of performance.', quoteVerified: false, origin: 'ai', flags: ['page_estimated', 'quote_unverified'], amendment: { kind: 'added', amendmentNo: 2 } },
  { id: 'r9', reqId: 'U-001', sectionRef: null, requirement: 'Confirm the incumbent badge process with the contracting officer.', type: null, instrRef: null, evalRef: null, responseSection: null, owner: 'Dana Reyes', status: 'open', sourcePage: null, sourcePageEnd: null, sourceQuote: null, quoteVerified: false, origin: 'user', flags: [], amendment: { kind: 'original' } },
  { id: 'r10', reqId: 'C-008', sectionRef: 'C.6.3', requirement: 'Staff shall be on site at the Washington, DC office at least three days a week.', type: 'shall', instrRef: 'L.6', evalRef: null, responseSection: 'Staffing', owner: 'Alex Morgan', status: 'done', sourcePage: 40, sourcePageEnd: null, sourceQuote: 'Staff shall be on site at the Washington, DC office at least three days a week.', quoteVerified: true, origin: 'ai', flags: ['maybe_not_requirement'], amendment: { kind: 'superseded', amendmentNo: 2, replacedById: null } },
  { id: 'r11', reqId: 'C-009', sectionRef: 'C.7.1', requirement: 'The contractor should offer an optional training track for new staff.', type: 'should', instrRef: null, evalRef: null, responseSection: null, owner: null, status: 'open', sourcePage: 44, sourcePageEnd: null, sourceQuote: 'The contractor should offer an optional training track for new staff.', quoteVerified: true, origin: 'user', flags: [], amendment: { kind: 'original' } },
  { id: 'r12', reqId: 'C-010', sectionRef: 'C.7.4', requirement: 'Other direct costs are reimbursed at cost without fee.', type: 'other', instrRef: null, evalRef: null, responseSection: 'Price', owner: null, status: 'open', sourcePage: 47, sourcePageEnd: null, sourceQuote: 'Other direct costs are reimbursed at cost without fee.', quoteVerified: true, origin: 'ai', flags: [], amendment: { kind: 'original' } },
]
const twelveRows: ComplianceRow[] = [...complianceRows, ...extraRows]
const sections = ['C.3.2', 'C.3.4', 'C.4.1', 'C.5.1', 'L.4.2']
const owners = ['Dana Reyes', 'Alex Morgan']

const activeFilters: ComplianceFilters = { ...complianceFilters, status: 'open', owner: 'Dana Reyes', flaggedOnly: true }

function MatrixExample({
  rows,
  totalRows,
  federal = true,
  initialFilters = complianceFilters,
  checkThese = complianceCheckThese,
  selectedRowId = null,
}: {
  rows: ComplianceRow[]
  totalRows: number
  federal?: boolean
  initialFilters?: ComplianceFilters
  checkThese?: CheckThese[]
  selectedRowId?: string | null
}) {
  const [filters, setFilters] = useState<ComplianceFilters>(initialFilters)
  return (
    <ComplianceMatrixTab
      rows={rows}
      totalRows={totalRows}
      checkThese={checkThese}
      filters={filters}
      federal={federal}
      sections={sections}
      owners={owners}
      amendments={[1, 2]}
      selectedRowId={selectedRowId}
      onFiltersChange={setFilters}
      onEditRow={(id, edit) => log('edit', id, edit)}
      onAddRow={(value) => log('add', value)}
      onMergeRows={(ids) => log('merge', ids)}
      onSplitRow={(id, at) => log('split', id, at)}
      onDeleteRow={(id) => log('delete', id)}
      onPromoteCheckThese={(id) => log('promote', id)}
      onDismissCheckThese={(id) => log('dismiss', id)}
      onOpenRow={(id) => log('open row', id)}
      onOpenSource={(id) => log('open source', id)}
      onJumpToRow={(id) => log('jump', id)}
      onExport={(format) => log('export', format)}
    />
  )
}

const complianceRow = twelveRows[0]
const complianceDetail: RowDetailData = {
  id: complianceRow.id,
  kind: 'compliance',
  title: `${complianceRow.reqId} ${complianceRow.sectionRef ?? ''}`.trim(),
  sourceQuote: complianceRow.sourceQuote,
  sectionRef: complianceRow.sectionRef,
  documentName: 'Solicitation.pdf',
  sourcePage: 18,
  sourcePageEnd: 19,
  amendment: { kind: 'superseded', amendmentNo: 1, replacedById: 'r4' },
  reqType: complianceRow.type,
  instrRef: complianceRow.instrRef,
  evalRef: complianceRow.evalRef,
  confidence: 0.86,
  flags: ['ocr', 'quote_unverified'],
  quoteVerified: false,
  confirmed: null,
  owner: complianceRow.owner,
  status: complianceRow.status,
  origin: 'ai',
}
const bidFactDetail: RowDetailData = {
  id: 'bf1',
  kind: 'bid_fact',
  title: 'Proposal due date',
  sourceQuote: 'Proposals are due by 2:00 PM Eastern on November 3, 2026.',
  sectionRef: null,
  documentName: 'Solicitation.pdf',
  sourcePage: 1,
  sourcePageEnd: null,
  amendment: { kind: 'original' },
  reqType: null,
  instrRef: null,
  evalRef: null,
  confidence: null,
  flags: [],
  quoteVerified: null,
  confirmed: true,
  owner: null,
  status: null,
  origin: null,
}
const editFields: RowEditField[] = [
  { key: 'requirement', label: 'Requirement', kind: 'longtext', value: complianceRow.requirement, options: null },
  { key: 'responseSection', label: 'Response section', kind: 'text', value: complianceRow.responseSection ?? '', options: null },
  { key: 'owner', label: 'Owner', kind: 'select', value: complianceRow.owner ?? '', options: owners.map((o) => ({ value: o, label: o })) },
  { key: 'status', label: 'Status', kind: 'select', value: complianceRow.status, options: [{ value: 'open', label: 'Open' }, { value: 'assigned', label: 'Assigned' }, { value: 'drafted', label: 'Drafted' }, { value: 'done', label: 'Done' }] },
]
const history: RowHistoryEntry[] = [
  { id: 'h1', who: 'Dana Reyes', field: 'Owner', from: null, to: 'Dana Reyes', at: '2026-11-03T14:14:00Z' },
  { id: 'h2', who: 'Alex Morgan', field: 'Status', from: 'open', to: 'assigned', at: '2026-11-04T09:30:00Z' },
]
const idle: FormStatus = { state: 'idle' }

function DetailExample({ row, status = idle, hint, hist = history }: { row: RowDetailData | null; status?: FormStatus; hint?: string; hist?: RowHistoryEntry[] }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="flex max-w-md flex-col gap-2 rounded-lg border border-line bg-paper p-5">
      {!open && <Button size="sm" onClick={() => setOpen(true)}>Open row detail</Button>}
      <RowDetail open={open} row={row} history={hist} federal editFields={editFields} saveStatus={status} onClose={() => setOpen(false)} onOpenSource={() => log('open source')} onSave={(values) => log('save', values)} onJumpToRow={(id) => log('jump detail', id)} />
      {hint && open && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

const pageSample = <div className="grid h-64 place-items-center bg-paper text-muted-foreground">PDF page 12</div>
const pages = [{ pageNo: 12, text: 'Section C.3.2\nThe contractor   shall provide transition planning\nwithin ten business days.' }, { pageNo: 13, text: 'This page has no matching text.' }]
const sourceViews: { label: string; view: SourceView; canRestore: boolean }[] = [
  { label: 'loading', view: { mode: 'loading' }, canRestore: true },
  { label: 'page', view: { mode: 'page', pageView: pageSample }, canRestore: true },
  { label: 'text', view: { mode: 'text', pages }, canRestore: true },
  { label: 'archived', view: { mode: 'archived', pages, restore: 'none' }, canRestore: true },
  { label: 'archived, member', view: { mode: 'archived', pages, restore: 'none' }, canRestore: false },
  { label: 'restore requested', view: { mode: 'archived', pages, restore: 'requested' }, canRestore: true },
  { label: 'restoring', view: { mode: 'archived', pages, restore: 'restoring' }, canRestore: true },
  { label: 'resume deleted', view: { mode: 'resume_deleted' }, canRestore: false },
  { label: 'error', view: { mode: 'error', message: 'The source could not be loaded.' }, canRestore: false },
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  )
}

export function Preview() {
  const [source, setSource] = useState<number | null>(null)
  const [shellDetail, setShellDetail] = useState(true)
  const current = source === null ? sourceViews[0] : sourceViews[source]
  return (
    <div className="min-h-screen bg-canvas p-4 text-ink md:p-8">
      <div className="mx-auto flex max-w-[1700px] flex-col gap-10">
        <h1 className="text-2xl font-semibold">Compliance matrix</h1>
        <Section title="Federal bid, 12 rows (every amendment kind and flag, user rows, selected row C-002). Open a row menu for Split row; use Add requirement for the add dialog.">
          <MatrixExample rows={twelveRows} totalRows={12} selectedRowId="r2" />
        </Section>
        <Section title="SLED labels">
          <MatrixExample rows={twelveRows.slice(0, 4)} totalRows={4} federal={false} />
        </Section>
        <Section title="Filters active, Showing 4 of 12 rows">
          <MatrixExample rows={twelveRows.slice(0, 4)} totalRows={12} initialFilters={activeFilters} />
        </Section>
        <Section title="Check these list">
          <MatrixExample rows={twelveRows} totalRows={12} initialFilters={{ ...complianceFilters, checkThese: true }} />
        </Section>
        <Section title="Check these, empty">
          <MatrixExample rows={twelveRows} totalRows={12} checkThese={[]} initialFilters={{ ...complianceFilters, checkThese: true }} />
        </Section>
        <Section title="Empty (no requirements)">
          <MatrixExample rows={[]} totalRows={0} />
        </Section>
        <Section title="No matches">
          <MatrixExample rows={[]} totalRows={12} initialFilters={{ ...complianceFilters, search: 'zzz' }} />
        </Section>
        <Section title="Row detail: compliance row (all fields)">
          <DetailExample row={complianceDetail} />
        </Section>
        <Section title="Row detail: bid fact (few fields)">
          <DetailExample row={bidFactDetail} hist={[]} />
        </Section>
        <Section title="Row detail: loading">
          <DetailExample row={null} />
        </Section>
        <Section title="Row detail: edit mode with error">
          <DetailExample row={complianceDetail} status={{ state: 'error', message: 'The row could not be saved. Try again.' }} hint="Choose Edit to see the form with the error." />
        </Section>
        <Section title="Row detail inside AppShell's detail slot">
          <div className="h-[760px] overflow-hidden rounded-lg border border-line">
            <AppShell
              bid={sampleBid}
              bids={sampleBids}
              activeTab="compliance"
              activePage={null}
              plan="free"
              creditsLeft={3}
              creditsResetOn="2026-11-01"
              oralsEnabled={false}
              tabSignals={[]}
              user={sampleUser}
              detail={shellDetail ? <RowDetail open row={complianceDetail} history={history} federal editFields={editFields} saveStatus={idle} onClose={() => setShellDetail(false)} onOpenSource={() => setSource(2)} onSave={(values) => log('save', values)} onJumpToRow={(id) => log('jump detail', id)} /> : null}
              onSelectTab={(tab) => log('tab', tab)}
              onSwitchBid={(id) => log('bid', id)}
              onOpenPage={(page) => log('page', page)}
              onUpgrade={() => log('upgrade')}
              onSignOut={() => log('sign out')}
            >
              <div className="p-4">
                <MatrixExample rows={twelveRows} totalRows={12} selectedRowId="r2" />
              </div>
            </AppShell>
          </div>
          {!shellDetail && <Button className="w-fit" onClick={() => setShellDetail(true)}>Open row detail</Button>}
        </Section>
        <Section title="Source viewer, every mode">
          <div className="flex flex-wrap gap-2">
            {sourceViews.map((s, i) => (
              <Button key={s.label} size="sm" variant="outline" onClick={() => setSource(i)}>
                Source: {s.label}
              </Button>
            ))}
          </div>
        </Section>
        <SourceViewer open={source !== null} fileName="Solicitation.pdf" page={12} pageEnd={13} quote="The contractor shall provide transition planning within ten business days." view={current.view} canRestore={current.canRestore} onClose={() => setSource(null)} onRestore={() => log('restore')} onRetry={() => log('retry')} />
      </div>
    </div>
  )
}

export default Preview

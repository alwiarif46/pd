import type { AmendmentMark, ReqType, RowFlag, RowStatus } from '../common/types'

export interface ComplianceRow {
  id: string
  reqId: string
  sectionRef: string | null
  requirement: string
  type: ReqType | null
  instrRef: string | null
  evalRef: string | null
  responseSection: string | null
  owner: string | null
  status: RowStatus
  sourcePage: number | null
  sourcePageEnd: number | null
  sourceQuote: string | null
  quoteVerified: boolean
  origin: 'ai' | 'user'
  flags: RowFlag[]
  amendment: AmendmentMark
}

export interface CheckThese { id: string; sentence: string; page: number }
export interface ComplianceFilters {
  section: string | null
  type: ReqType | null
  status: RowStatus | null
  owner: string | null
  amendment: number | 'original' | null
  flaggedOnly: boolean
  hideClosed: boolean
  checkThese: boolean
  search: string
}
export type ComplianceRowEdit = Partial<Pick<ComplianceRow, 'requirement' | 'owner' | 'status' | 'responseSection'>>
export interface NewComplianceRow { requirement: string; sectionRef: string | null; type: ReqType | null; owner: string | null }
export interface ComplianceMatrixTabProps {
  rows: ComplianceRow[]
  totalRows: number
  checkThese: CheckThese[]
  filters: ComplianceFilters
  federal: boolean
  sections: string[]
  owners: string[]
  amendments: number[]
  selectedRowId: string | null
  onFiltersChange: (f: ComplianceFilters) => void
  onEditRow: (id: string, edit: ComplianceRowEdit) => void
  onAddRow: (row: NewComplianceRow) => void
  onMergeRows: (ids: string[]) => void
  onSplitRow: (id: string, at: number) => void
  onDeleteRow: (id: string) => void
  onPromoteCheckThese: (id: string) => void
  onDismissCheckThese: (id: string) => void
  onOpenRow: (id: string) => void
  onOpenSource: (id: string) => void
  onJumpToRow: (id: string) => void
  onExport: (format: 'xlsx' | 'csv') => void
}

export interface RowDetailData {
  id: string; title: string; sourceQuote: string | null; sectionRef: string | null; documentName: string | null
  sourcePage: number | null; sourcePageEnd: number | null; amendment: AmendmentMark; reqType: ReqType | null
  instrRef: string | null; evalRef: string | null; confidence: number | null; flags: RowFlag[]
  quoteVerified: boolean | null; confirmed: boolean | null; owner: string | null; status: string | null
  origin: 'ai' | 'user' | null
}
export interface RowDetailProps { open: boolean; row: RowDetailData | null; onClose: () => void; onEdit: () => void; onOpenSource: () => void }
export interface SourceViewerProps { open: boolean; fileName: string | null; page: number | null; pageEnd: number | null; quote: string | null; state: 'live' | 'archived' | 'restoring' | 'deleted' | 'none'; onClose: () => void; onRestore: () => void }
export type { AmendmentMark, ReqType, RowFlag, RowStatus }

export const rowStatusLabels: Record<RowStatus, string> = { open: 'Open', assigned: 'Assigned', drafted: 'Drafted', done: 'Done' }
export const flagLabels: Record<RowFlag, string> = { maybe_not_requirement: 'May not be a requirement', page_estimated: 'Page estimated', ocr: 'OCR', quote_unverified: 'Quote not verified' }

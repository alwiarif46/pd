import type { AmendmentMark, FormStatus, ReqType, RowFlag, RowStatus } from '@/types'

export interface ComplianceRow {
  id: string; reqId: string; sectionRef: string | null; requirement: string; type: ReqType | null;
  instrRef: string | null; evalRef: string | null; responseSection: string | null; owner: string | null; status: RowStatus;
  sourcePage: number | null; sourcePageEnd: number | null; sourceQuote: string | null; quoteVerified: boolean;
  origin: 'ai' | 'user'; flags: RowFlag[]; amendment: AmendmentMark;
}
export interface CheckThese { id: string; sentence: string; page: number }
export interface ComplianceFilters {
  section: string | null; type: ReqType | null; status: RowStatus | null; owner: string | null;
  amendment: number | 'original' | null; flaggedOnly: boolean; hideClosed: boolean; checkThese: boolean; search: string;
}
export type ComplianceRowEdit = Partial<Pick<ComplianceRow, 'requirement' | 'owner' | 'status' | 'responseSection'>>
export interface NewComplianceRow { requirement: string; sectionRef: string | null; type: ReqType | null; owner: string | null }
export interface ComplianceMatrixTabProps {
  rows: ComplianceRow[]; totalRows: number; checkThese: CheckThese[]; filters: ComplianceFilters; federal: boolean;
  sections: string[]; owners: string[]; amendments: number[]; selectedRowId: string | null;
  onFiltersChange: (f: ComplianceFilters) => void;
  onEditRow: (id: string, edit: ComplianceRowEdit) => void; onAddRow: (row: NewComplianceRow) => void;
  onMergeRows: (ids: string[]) => void; onSplitRow: (id: string, at: number) => void; onDeleteRow: (id: string) => void;
  onPromoteCheckThese: (id: string) => void; onDismissCheckThese: (id: string) => void;
  onOpenRow: (id: string) => void; onOpenSource: (id: string) => void; onJumpToRow: (id: string) => void;
  onExport: (format: 'xlsx' | 'csv') => void;
}
export interface RowDetailData {
  id: string; kind: 'bid_fact' | 'schedule' | 'compliance' | 'outline' | 'requirement' | 'finding' | 'production' | 'orals'; title: string;
  sourceQuote: string | null; sectionRef: string | null; documentName: string | null; sourcePage: number | null; sourcePageEnd: number | null;
  amendment: AmendmentMark; reqType: ReqType | null; instrRef: string | null; evalRef: string | null; confidence: number | null;
  flags: RowFlag[]; quoteVerified: boolean | null; confirmed: boolean | null; owner: string | null; status: string | null; origin: 'ai' | 'user' | null;
}
export interface RowEditField { key: string; label: string; kind: 'text' | 'longtext' | 'select' | 'number' | 'date'; value: string; options: { value: string; label: string }[] | null }
export interface RowHistoryEntry { id: string; who: string; field: string; from: string | null; to: string | null; at: string }
export interface RowDetailProps {
  open: boolean; row: RowDetailData | null; history: RowHistoryEntry[]; federal: boolean; editFields: RowEditField[]; saveStatus: FormStatus;
  onOpenSource: () => void; onSave: (values: Record<string, string>) => void; onJumpToRow: (id: string) => void; onClose: () => void;
}
export interface PageText { pageNo: number; text: string }
export type SourceView = { mode: 'loading' } | { mode: 'page'; pageView: React.ReactNode } | { mode: 'text'; pages: PageText[] } | { mode: 'archived'; pages: PageText[]; restore: 'none' | 'requested' | 'restoring' } | { mode: 'resume_deleted' } | { mode: 'error'; message: string }
export interface SourceViewerProps {
  open: boolean; fileName: string; page: number; pageEnd: number | null; quote: string | null; view: SourceView; canRestore: boolean;
  onRestore: () => void; onRetry: () => void; onClose: () => void;
}

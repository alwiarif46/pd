// Compliance matrix: docs/plans/09-ui-workflow.md section 5.4.
import type { AmendmentMark, ReqType, RowFlag } from './shared';

export type RowStatus = 'open' | 'assigned' | 'drafted' | 'done';
export interface ComplianceRow {
  id: string;
  reqId: string;
  sectionRef: string | null;
  requirement: string;
  type: ReqType | null;
  instrRef: string | null;
  evalRef: string | null;
  responseSection: string | null;
  owner: string | null;
  status: RowStatus;
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
  quoteVerified: boolean;
  origin: 'ai' | 'user';
  flags: RowFlag[];
  amendment: AmendmentMark;
}
export interface CheckThese {
  id: string;
  sentence: string;
  page: number;
}
export interface ComplianceFilters {
  section: string | null;
  type: ReqType | null;
  status: RowStatus | null;
  owner: string | null;
  amendment: number | 'original' | null;
  flaggedOnly: boolean;
  hideClosed: boolean;
  checkThese: boolean;
  search: string;
}
export type ComplianceRowEdit = Partial<Pick<ComplianceRow, 'requirement' | 'owner' | 'status' | 'responseSection'>>;
export interface NewComplianceRow {
  requirement: string;
  sectionRef: string | null;
  type: ReqType | null;
  owner: string | null;
}
export interface ComplianceMatrixTabProps {
  rows: ComplianceRow[]; // already filtered by the container
  totalRows: number;
  checkThese: CheckThese[];
  filters: ComplianceFilters;
  federal: boolean;
  sections: string[];
  owners: string[];
  amendments: number[];
  selectedRowId: string | null;
  onFiltersChange: (f: ComplianceFilters) => void;
  onEditRow: (id: string, edit: ComplianceRowEdit) => void;
  onAddRow: (row: NewComplianceRow) => void;
  onMergeRows: (ids: string[]) => void;
  onSplitRow: (id: string, at: number) => void;
  onDeleteRow: (id: string) => void;
  onPromoteCheckThese: (id: string) => void;
  onDismissCheckThese: (id: string) => void;
  onOpenRow: (id: string) => void;
  onOpenSource: (id: string) => void;
  onJumpToRow: (id: string) => void;
  onExport: (format: 'xlsx' | 'csv') => void;
}

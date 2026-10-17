// Row detail slider: docs/plans/09-ui-workflow.md section 5.17.
import type { AmendmentMark, FormStatus, ReqType, RowFlag } from './shared';

export type RowKind =
  | 'bid_fact'
  | 'schedule'
  | 'compliance'
  | 'outline'
  | 'requirement'
  | 'finding'
  | 'production'
  | 'orals';
export interface RowDetailData {
  id: string;
  kind: RowKind;
  title: string;
  sourceQuote: string | null;
  sectionRef: string | null;
  documentName: string | null;
  sourcePage: number | null;
  sourcePageEnd: number | null;
  amendment: AmendmentMark;
  reqType: ReqType | null;
  instrRef: string | null;
  evalRef: string | null;
  confidence: number | null; // 0 to 1
  flags: RowFlag[];
  quoteVerified: boolean | null;
  confirmed: boolean | null;
  owner: string | null;
  status: string | null;
  origin: 'ai' | 'user' | null;
}
export interface RowEditField {
  key: string;
  label: string;
  kind: 'text' | 'longtext' | 'select' | 'number' | 'date';
  value: string;
  options: { value: string; label: string }[] | null;
}
export interface RowHistoryEntry {
  id: string;
  who: string;
  field: string;
  from: string | null;
  to: string | null;
  at: string;
}
export interface RowDetailProps {
  open: boolean;
  row: RowDetailData | null; // null while loading
  history: RowHistoryEntry[];
  federal: boolean;
  editFields: RowEditField[];
  saveStatus: FormStatus;
  onOpenSource: () => void;
  onSave: (values: Record<string, string>) => void;
  onJumpToRow: (id: string) => void;
  onClose: () => void;
}

// Outline and status tracker: docs/plans/09-ui-workflow.md section 5.5.
import type { AmendmentMark } from './shared';

export type OutlineStatus = 'not_started' | 'in_progress' | 'review' | 'done';
export interface OutlineItem {
  id: string;
  parentId: string | null;
  number: string | null;
  title: string;
  pageLimit: number | null;
  sourceRef: string | null;
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
  writer: string | null;
  status: OutlineStatus;
  dueDate: string | null;
  origin: 'ai' | 'user';
  amendment: AmendmentMark;
}
export type OutlineEdit = Partial<Pick<OutlineItem, 'title' | 'writer' | 'status' | 'pageLimit' | 'dueDate'>>;
export interface OutlineTabProps {
  items: OutlineItem[];
  selectedRowId: string | null;
  onEdit: (id: string, edit: OutlineEdit) => void;
  onAdd: (parentId: string | null, title: string, number: string | null) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, parentId: string | null, index: number) => void;
  onOpenRow: (id: string) => void;
  onOpenSource: (id: string) => void;
  onExport: (format: 'xlsx' | 'docx') => void;
}

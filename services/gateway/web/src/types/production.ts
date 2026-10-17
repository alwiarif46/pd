// Production checklist: docs/plans/09-ui-workflow.md section 5.8.
import type { AmendmentMark } from './shared';

export type ProductionCategory = 'format' | 'files' | 'submission' | 'copies' | 'other';
export interface ProductionItem {
  id: string;
  category: ProductionCategory;
  rule: string;
  owner: string | null;
  done: boolean;
  origin: 'ai' | 'user' | 'standard';
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
  amendment: AmendmentMark;
}
export interface ProductionTabProps {
  items: ProductionItem[];
  selectedRowId: string | null;
  onToggle: (id: string, done: boolean) => void;
  onEdit: (id: string, edit: { rule?: string; owner?: string | null }) => void;
  onAdd: (category: ProductionCategory, rule: string) => void;
  onDelete: (id: string) => void;
  onOpenRow: (id: string) => void;
  onOpenSource: (id: string) => void;
}

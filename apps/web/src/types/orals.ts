// Orals: docs/plans/09-ui-workflow.md section 5.9.
import type { AmendmentMark } from './shared';

export type OralsCategory = 'rules' | 'prep' | 'session';
export interface OralsItem {
  id: string;
  category: OralsCategory;
  item: string;
  owner: string | null;
  minutes: number | null;
  done: boolean;
  origin: 'ai' | 'user' | 'standard';
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
  amendment: AmendmentMark;
}
export interface OralsTabProps {
  items: OralsItem[];
  selectedRowId: string | null;
  onToggle: (id: string, done: boolean) => void;
  onEdit: (id: string, edit: { item?: string; owner?: string | null; minutes?: number | null }) => void;
  onAdd: (category: OralsCategory, item: string) => void;
  onDelete: (id: string) => void;
  onOpenRow: (id: string) => void;
  onOpenSource: (id: string) => void;
}

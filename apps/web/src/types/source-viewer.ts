// Source viewer: docs/plans/09-ui-workflow.md section 5.18.
import type { ReactNode } from 'react';

export interface PageText {
  pageNo: number;
  text: string;
}
export type SourceView =
  | { mode: 'loading' }
  | { mode: 'page'; pageView: ReactNode } // the container renders the PDF page(s) with the quote highlighted
  | { mode: 'text'; pages: PageText[] } // Word file that could not be converted: "Page estimated"
  | { mode: 'archived'; pages: PageText[]; restore: 'none' | 'requested' | 'restoring' }
  | { mode: 'resume_deleted' }
  | { mode: 'error'; message: string };
export interface SourceViewerProps {
  open: boolean;
  fileName: string;
  page: number;
  pageEnd: number | null;
  quote: string | null;
  view: SourceView;
  canRestore: boolean;
  onRestore: () => void;
  onRetry: () => void;
  onClose: () => void;
}

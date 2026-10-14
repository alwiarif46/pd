// Shared UI types: docs/plans/09-ui-workflow.md sections 5.1 and 5.12.
// v0 and ui components import these from '@/types'. Do not redefine them.
// Per-screen contracts (sections 5.2 to 5.11) are added here when that screen is integrated.

export type Tab =
  | 'overview' | 'schedule' | 'compliance' | 'outline' | 'resumes' | 'reviews'
  | 'production' | 'orals' | 'lessons' | 'documents' | 'settings';

export interface ProcessingState {
  stage: 'idle' | 'scanning' | 'extracting' | 'classifying' | 'extract' | 'verify' | 'map' | 'done' | 'failed';
  percent: number;
  message?: string;
  etaSeconds?: number;
}

export interface SourceLinkProps {
  page?: number;
  quote?: string;
  fileGone?: boolean;
  onOpen: (page: number, quote: string) => void;
}
// Color team reviews: docs/plans/09-ui-workflow.md section 5.7.
import type { FormStatus } from './shared';

export type ReviewType = 'pink' | 'red' | 'green' | 'gold' | 'other';
export type FindingKind = 'strength' | 'weakness' | 'deficiency' | 'risk' | 'comment';
export type Disposition = 'open' | 'accepted' | 'rejected' | 'done';
export interface Reviewer {
  id: string;
  name: string;
  sections: string;
}
export interface Review {
  id: string;
  type: ReviewType;
  scheduledAt: string | null;
  status: 'planned' | 'in_progress' | 'done';
  draftFileName: string | null;
  reviewers: Reviewer[];
}
export interface Finding {
  id: string;
  reviewId: string;
  evalFactor: string | null;
  kind: FindingKind;
  text: string;
  draftQuote: string | null;
  draftPage: number | null;
  origin: 'ai' | 'user';
  author: string | null;
  disposition: Disposition;
}
export interface NewReview {
  type: ReviewType;
  scheduledAt: string | null;
  reviewers: { name: string; sections: string }[];
}
export interface ReviewsTabProps {
  reviews: Review[];
  findings: Finding[];
  activeReviewId: string | null;
  evalFactors: string[];
  federal: boolean;
  uploadStatus: FormStatus;
  selectedRowId: string | null;
  onCreateReview: (r: NewReview, draft: File | null) => void;
  onSelectReview: (id: string) => void;
  onEditReview: (id: string, edit: { status?: Review['status']; scheduledAt?: string | null }) => void;
  onUploadDraft: (reviewId: string, file: File) => void;
  onAddReviewer: (reviewId: string, name: string, sections: string) => void;
  onRemoveReviewer: (id: string) => void;
  onAddFinding: (f: { reviewId: string; evalFactor: string | null; kind: FindingKind; text: string }) => void;
  onEditFinding: (id: string, text: string) => void;
  onSetDisposition: (id: string, d: Disposition) => void;
  onOpenRow: (id: string) => void;
  onOpenSource: (id: string) => void;
  onExport: (format: 'docx' | 'xlsx') => void;
}

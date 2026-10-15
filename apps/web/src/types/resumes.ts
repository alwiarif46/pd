// Resume and key personnel matrix: docs/plans/09-ui-workflow.md section 5.6.
import type { AmendmentMark, FormStatus } from './shared';

export type PersonnelKind = 'degree' | 'years' | 'certification' | 'clearance' | 'skill' | 'other';
export type MatchResult = 'meets' | 'partial' | 'gap' | 'unknown';
export interface PersonnelRequirement {
  id: string;
  role: string;
  requirement: string;
  kind: PersonnelKind | null;
  origin: 'ai' | 'user';
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
  amendment: AmendmentMark;
}
export interface Candidate {
  id: string;
  name: string;
  role: string;
  status: 'processing' | 'ready' | 'failed';
  uploadedAt: string | null;
  resumeDeleted: boolean;
}
export interface ResumeMatch {
  candidateId: string;
  requirementId: string;
  result: MatchResult;
  evidence: string | null;
  evidencePage: number | null;
  overridden: boolean;
}
export interface ResumeMatrixTabProps {
  requirements: PersonnelRequirement[];
  candidates: Candidate[];
  matches: ResumeMatch[];
  roles: string[];
  gaps: { candidateId: string; requirementIds: string[] }[];
  uncoveredRoles: string[];
  uploadStatus: FormStatus;
  selectedRowId: string | null;
  onEditRequirement: (id: string, edit: { role?: string; requirement?: string }) => void;
  onAddRequirement: (role: string, requirement: string, kind: PersonnelKind | null) => void;
  onDeleteRequirement: (id: string) => void;
  onUploadResumes: (files: File[], role: string) => void;
  onAssignRole: (candidateId: string, role: string) => void;
  onRemoveCandidate: (id: string) => void;
  onSetResult: (candidateId: string, requirementId: string, result: 'meets' | 'partial' | 'gap') => void;
  onOpenRow: (id: string) => void;
  onOpenSource: (id: string) => void;
  onExport: () => void;
}

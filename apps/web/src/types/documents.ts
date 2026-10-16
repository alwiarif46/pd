// Documents and bid settings: docs/plans/09-ui-workflow.md section 5.11.
import type { BidType, FileKind, FormStatus, Plan } from './shared';

export type DocStatus =
  | { state: 'processing'; queuePosition: number | null }
  | { state: 'live' }
  | { state: 'failed'; reason: string }
  | { state: 'archived' }
  | { state: 'restore_requested' }
  | { state: 'restoring' }
  | { state: 'restored'; until: string }
  | { state: 'deleted' };
export type MarkingState =
  | { state: 'none' }
  | { state: 'blocked'; markings: string[]; page: number | null }
  | { state: 'confirmed'; markings: string[] };
export type KeyCheck = 'not_applicable' | 'ok' | 'mismatch' | 'overridden';
export interface Doc {
  id: string;
  name: string;
  kind: FileKind;
  amendmentNo: number | null;
  pages: number | null;
  pagesEstimated: boolean;
  sizeBytes: number;
  uploadedAt: string;
  liveUntil: string | null;
  status: DocStatus;
  marking: MarkingState;
  keyCheck: KeyCheck;
  amendmentNoAssumed: boolean;
  amendmentNoFound: number | null;
  needsNumber: boolean;
}
export interface UploadNotice {
  id: string;
  fileName: string;
  tone: 'error' | 'info';
  message: string;
}
export interface UploadProgress {
  fileName: string;
  percent: number;
}
export interface DocumentsPanelProps {
  docs: Doc[];
  usedBytes: number;
  capMb: number;
  plan: Plan;
  isOwner: boolean;
  overridesLeft: number;
  notices: UploadNotice[];
  uploads: UploadProgress[];
  onUpload: (files: File[], kind: FileKind, amendmentNo?: number) => void;
  onSetAmendmentNo: (id: string, amendmentNo: number) => void;
  onDismissNotice: (id: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onConfirmMarking: (id: string) => void;
  onOverrideKey: (id: string, reason: string) => void;
  onUpgrade: () => void;
}
export interface BidSettingsValues {
  name: string;
  agency: string;
  bidType: BidType;
  solicitationNumber: string;
  startDate: string | null;
  dueDate: string | null;
  dueTime: string | null;
  timeZone: string;
  oralsEnabled: boolean;
  keepFilesLiveUntil: string | null;
}
export interface BidSettingsProps {
  bid: BidSettingsValues;
  plan: Plan;
  isOwner: boolean;
  filesLiveUntil: string | null;
  creditStatus: 'reserved' | 'consumed' | 'none';
  saveStatus: FormStatus;
  deleteStatus: FormStatus;
  onSave: (v: BidSettingsValues) => void;
  onDeleteBid: () => void;
}
export interface DateChangePromptProps {
  open: boolean;
  previousDue: string;
  nextDue: string;
  onChoose: (mode: 'shift' | 'scale' | 'keep') => void;
  onCancel: () => void;
}

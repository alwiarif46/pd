export type FileKind = 'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft';

export interface Doc {
  id: string;
  name: string;
  kind: FileKind;
  pages?: number;
  uploadedAt: string;
  deleteOn: string;
  status: 'scanning' | 'extracting' | 'ready' | 'failed' | 'deleted';
  amendmentNoAssumed: boolean;
  amendmentNoFound: number | null;
  needsNumber: boolean;
  markings?: string;
  markingState?: 'blocked' | 'confirmed' | 'none';
}

export interface DocumentsPanelProps {
  docs: Doc[];
  storageUsedBytes: number;
  storageLimitBytes: number;
  onUpload: (files: File[], kind: FileKind, amendmentNo?: number) => void;
  onDelete: (id: string) => void;
  onOpen: (id: string) => void;
  onSetAmendmentNo: (id: string, amendmentNo: number) => void;
}

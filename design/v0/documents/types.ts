import type { FileKind, FormStatus, Plan } from '@/types'

export type DocStatus =
  | { state: 'processing'; queuePosition: number | null }
  | { state: 'live' }
  | { state: 'failed'; reason: string }
  | { state: 'archived' }
  | { state: 'restore_requested' }
  | { state: 'restoring' }
  | { state: 'restored'; until: string }
  | { state: 'deleted' }
export type MarkingState =
  | { state: 'none' }
  | { state: 'blocked'; markings: string[]; page: number | null }
  | { state: 'confirmed'; markings: string[] }
export type KeyCheck = 'not_applicable' | 'ok' | 'mismatch' | 'overridden'
export interface Doc { id: string; name: string; kind: FileKind; amendmentNo: number | null; pages: number | null; pagesEstimated: boolean; sizeBytes: number; uploadedAt: string; liveUntil: string | null; status: DocStatus; marking: MarkingState; keyCheck: KeyCheck }
export interface UploadNotice { id: string; fileName: string; tone: 'error' | 'info'; message: string }
export interface UploadProgress { fileName: string; percent: number }
export interface DocumentsPanelProps {
  docs: Doc[]; usedBytes: number; capMb: number; plan: Plan; isOwner: boolean; overridesLeft: number
  notices: UploadNotice[]; uploads: UploadProgress[]; amendmentNoAssumed: number | null; amendmentNoFound: number | null; needsNumber: boolean
  onSetAmendmentNo: (value: number) => void
  onUpload: (files: File[], kind: FileKind, amendmentNo?: number) => void; onDismissNotice: (id: string) => void
  onOpen: (id: string) => void; onDelete: (id: string) => void; onRestore: (id: string) => void
  onConfirmMarking: (id: string) => void; onOverrideKey: (id: string, reason: string) => void; onUpgrade: () => void
}
export type { FileKind, FormStatus, Plan }

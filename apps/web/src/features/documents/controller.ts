import * as api from '@/api';
import { ApiError, type DocumentDto, type JobDto } from '@/api';
import type { AmendmentProposal, Doc, DocStatus, MarkingState, UploadNotice } from '@/types';
import { dayOf } from '@/features/schedule/derive';
import { noticeFor } from '@/features/shared/messages';
import { failedJobs, failureReason, isActive, isProcessing } from '@/features/tab-frame/derive';

/** The calls the Documents container makes; tests pass fakes. */
export interface DocumentsApi {
  uploadFile: typeof api.uploadFile;
  confirmMarking: typeof api.confirmMarking;
  deleteDocument: typeof api.deleteDocument;
  restoreDocument: typeof api.restoreDocument;
  overrideSolicitationKey: typeof api.overrideSolicitationKey;
  setAmendmentNo: typeof api.setAmendmentNo;
}

export const documentsApi: DocumentsApi = api;

/** 05 s3.10: the API refuses an upload whose amendment number another amendment on the bid already has. */
export const AMENDMENT_NO_TAKEN_MESSAGE = 'Another amendment on this bid already has that number.';

/** The marking text when the API blocked a file without naming the marking (as `markingRequests`). */
const UNNAMED_MARKING = 'a controlled marking';

function toStatus(dto: DocumentDto, jobs: readonly JobDto[], docs: readonly DocumentDto[]): DocStatus {
  if (dto.liveStatus === 'deleted') return { state: 'deleted' };
  const failed = failedJobs([...jobs], [...docs]).filter((job) => job.documentId === dto.id);
  const latestFailed = failed[failed.length - 1];
  if (latestFailed) return { state: 'failed', reason: failureReason(latestFailed, [...docs]) };
  const active = jobs.filter((job) => job.documentId === dto.id && isActive(job));
  if (isProcessing(dto) || active.length > 0) {
    const positions = active.map((job) => job.queuePosition).filter((n): n is number => n !== null);
    return { state: 'processing', queuePosition: positions.length > 0 ? Math.min(...positions) : null };
  }
  switch (dto.liveStatus) {
    case 'archived':
      return { state: 'archived' };
    case 'restore_requested':
      return { state: 'restore_requested' };
    case 'restoring':
      return { state: 'restoring' };
    case 'restored': {
      // `restored.until` is a date; with none to show the file is simply available.
      const until = dayOf(dto.restoredUntil);
      return until ? { state: 'restored', until } : { state: 'live' };
    }
    default:
      return { state: 'live' };
  }
}

function toMarking(dto: DocumentDto): MarkingState {
  if (dto.markingStatus === 'blocked') {
    const found = dto.markingFound && dto.markingFound.length > 0 ? dto.markingFound : [UNNAMED_MARKING];
    return { state: 'blocked', markings: found, page: dto.markingPage };
  }
  if (dto.markingStatus === 'confirmed') return { state: 'confirmed', markings: dto.markingFound ?? [] };
  return { state: 'none' };
}

/** A document as v0's panel shows it (09 s5.11 `Doc`). `docs` is every document of the bid (failure reasons read them). */
export function toDoc(dto: DocumentDto, jobs: readonly JobDto[], docs: readonly DocumentDto[]): Doc {
  return {
    id: dto.id,
    name: dto.fileName,
    kind: dto.kind,
    amendmentNo: dto.amendmentNo,
    pages: dto.pageCount ?? dto.pagesEstimated,
    pagesEstimated: dto.pageCount === null && dto.pagesEstimated !== null,
    sizeBytes: dto.sizeBytes,
    uploadedAt: dto.createdAt,
    liveUntil: dayOf(dto.liveUntil),
    status: toStatus(dto, jobs, docs),
    marking: toMarking(dto),
    keyCheck: dto.keyCheck,
    amendmentNoAssumed: dto.amendmentNoSource === 'sequence',
    amendmentNoFound: dto.amendmentNoFound !== null && dto.amendmentNoFound !== dto.amendmentNo ? dto.amendmentNoFound : null,
    needsNumber: dto.amendmentStatus === 'needs_number',
  };
}

/** The notice for a failed upload of `file`: the 409 `amendment_no_taken` text of 05 s3.10, else the API's message as given. */
export function uploadFailureNotice(error: unknown, file: { name: string }, id: string): UploadNotice {
  if (error instanceof ApiError && error.status === 409 && error.code === 'amendment_no_taken') {
    return { id, fileName: file.name, tone: 'error', message: AMENDMENT_NO_TAKEN_MESSAGE };
  }
  return noticeFor(error, file, id);
}

/** Percent done for an upload's chunk progress, 0 to 100. */
export function percentOf(progress: { chunksSent: number; chunkCount: number }): number {
  if (progress.chunkCount <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((progress.chunksSent / progress.chunkCount) * 100)));
}

/**
 * The row ids, in page order, of the source buttons that TabFrame's amendment cards draw (old row, then new
 * row, only when the row has a source page): lets the container find a row's button by id, not by its label.
 */
export function proposalSourceRowIds(proposals: readonly AmendmentProposal[]): string[] {
  const ids: string[] = [];
  for (const p of proposals) {
    if (p.oldRow && p.oldRow.sourcePage !== null) ids.push(p.oldRow.rowId);
    if (p.newRow && p.newRow.sourcePage !== null) ids.push(p.newRow.rowId);
  }
  return ids;
}

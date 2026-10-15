import type { UploadNotice } from '@/types';

/**
 * Upload notices from the new-bid screen, kept for the bid's Documents tab to show when it opens
 * (09 s5.11 `UploadNotice`). In memory only: a reload drops them, which is fine for a one-time message.
 */
const pending = new Map<string, UploadNotice[]>();

export function stashUploadNotices(bidId: string, notices: UploadNotice[]): void {
  if (notices.length > 0) pending.set(bidId, notices);
}

/** Returns the stashed notices for a bid and forgets them. */
export function takeUploadNotices(bidId: string): UploadNotice[] {
  const notices = pending.get(bidId) ?? [];
  pending.delete(bidId);
  return notices;
}

import type { UploadNotice } from '@/types';

export const TABS_PENDING_MESSAGE = 'Updating bid facts and dates from this amendment.';
export const TABS_FAILED_MESSAGE = 'Bid facts and dates did not update from this amendment. Open Overview and choose Retry.';

/**
 * What the Documents tab says about an amendment's update of the bid facts and dates (09 s5.11 `UploadNotice`;
 * null: nothing to say). The file's own status stays "Live". The id is `<document id>:<status>`, so a notice
 * the user dismissed stays hidden until that document's status changes.
 */
export function amendmentTabsNotice(doc: {
  id: string;
  fileName: string;
  kind: string;
  amendmentTabsStatus?: string | null;
}): UploadNotice | null {
  if (doc.kind !== 'amendment') return null;
  if (doc.amendmentTabsStatus === 'pending') {
    return { id: `${doc.id}:pending`, fileName: doc.fileName, tone: 'info', message: TABS_PENDING_MESSAGE };
  }
  if (doc.amendmentTabsStatus === 'failed') {
    return { id: `${doc.id}:failed`, fileName: doc.fileName, tone: 'error', message: TABS_FAILED_MESSAGE };
  }
  return null;
}

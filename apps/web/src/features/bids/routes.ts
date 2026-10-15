export const BIDS_HASH = '#/bids';
export const NEW_BID_HASH = '#/bids/new';
/** Organization page: where the plan and credits are managed until the upgrade dialog exists. */
export const UPGRADE_HASH = '#/org';

export function bidHash(bidId: string): string {
  return `#/bids/${encodeURIComponent(bidId)}/overview`;
}

/** Where a new bid goes after its files are uploaded. */
export function bidDocumentsHash(bidId: string): string {
  return `#/bids/${encodeURIComponent(bidId)}/documents`;
}

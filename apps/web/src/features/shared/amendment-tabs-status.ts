/** What the documents list says about an amendment's update of the bid facts and dates (null: nothing to say). */
export function amendmentTabsNote(doc: {
  kind: string;
  amendmentTabsStatus?: string | null;
}): { text: string; tone: 'info' | 'bad' } | null {
  if (doc.kind !== 'amendment') return null;
  if (doc.amendmentTabsStatus === 'pending') return { text: 'Updating bid facts and dates', tone: 'info' };
  if (doc.amendmentTabsStatus === 'failed') return { text: 'Bid facts and dates did not update. Retry the failed step above.', tone: 'bad' };
  return null;
}

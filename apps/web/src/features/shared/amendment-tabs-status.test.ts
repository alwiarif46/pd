import { describe, expect, it } from 'vitest';
import { amendmentTabsNotice } from './amendment-tabs-status';

const amendment = { id: 'amd', fileName: 'amd2.pdf', kind: 'amendment' };

describe('amendmentTabsNotice', () => {
  it('says pending as info and failed as an error, pointing to Overview Retry', () => {
    expect(amendmentTabsNotice({ ...amendment, amendmentTabsStatus: 'pending' })).toEqual({
      id: 'amd:pending',
      fileName: 'amd2.pdf',
      tone: 'info',
      message: 'Updating bid facts and dates from this amendment.',
    });
    expect(amendmentTabsNotice({ ...amendment, amendmentTabsStatus: 'failed' })).toEqual({
      id: 'amd:failed',
      fileName: 'amd2.pdf',
      tone: 'error',
      message: 'Bid facts and dates did not update from this amendment. Open Overview and choose Retry.',
    });
  });

  it('says nothing when applied, unset, or not an amendment', () => {
    expect(amendmentTabsNotice({ ...amendment, amendmentTabsStatus: 'applied' })).toBeNull();
    expect(amendmentTabsNotice({ ...amendment, amendmentTabsStatus: null })).toBeNull();
    expect(amendmentTabsNotice(amendment)).toBeNull();
    expect(amendmentTabsNotice({ ...amendment, kind: 'solicitation', amendmentTabsStatus: 'failed' })).toBeNull();
  });
});

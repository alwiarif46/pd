import { describe, expect, it } from 'vitest';
import { amendmentTabsNote } from './amendment-tabs-status';

describe('amendmentTabsNote', () => {
  it('says pending and failed for an amendment', () => {
    expect(amendmentTabsNote({ kind: 'amendment', amendmentTabsStatus: 'pending' })).toEqual({
      text: 'Updating bid facts and dates',
      tone: 'info',
    });
    expect(amendmentTabsNote({ kind: 'amendment', amendmentTabsStatus: 'failed' })).toEqual({
      text: 'Bid facts and dates did not update. Retry the failed step above.',
      tone: 'bad',
    });
  });

  it('says nothing when applied, unset, or not an amendment', () => {
    expect(amendmentTabsNote({ kind: 'amendment', amendmentTabsStatus: 'applied' })).toBeNull();
    expect(amendmentTabsNote({ kind: 'amendment', amendmentTabsStatus: null })).toBeNull();
    expect(amendmentTabsNote({ kind: 'amendment' })).toBeNull();
    expect(amendmentTabsNote({ kind: 'solicitation', amendmentTabsStatus: 'failed' })).toBeNull();
  });
});

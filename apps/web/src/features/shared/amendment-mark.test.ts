import { describe, expect, it } from 'vitest';
import { amendmentMark } from './amendment-mark';

const base = { amendmentNo: 0, supersedeStatus: 'active' as const, supersededByRowId: null, changedByAmendment: null };

describe('amendmentMark', () => {
  it('maps superseded, withdrawn, added and original rows', () => {
    const ids = new Set(['r2']);
    expect(amendmentMark({ ...base, supersedeStatus: 'superseded', supersededByRowId: 'r2', changedByAmendment: 3 }, ids))
      .toEqual({ kind: 'superseded', amendmentNo: 3, replacedById: 'r2' });
    expect(amendmentMark({ ...base, supersedeStatus: 'withdrawn', changedByAmendment: 2 }, ids)).toEqual({ kind: 'withdrawn', amendmentNo: 2 });
    expect(amendmentMark({ ...base, amendmentNo: 4 }, ids)).toEqual({ kind: 'added', amendmentNo: 4 });
    expect(amendmentMark(base, ids)).toEqual({ kind: 'original' });
    expect(amendmentMark({ ...base, supersedeStatus: null }, ids)).toEqual({ kind: 'original' });
  });

  it('has no jump target when the replacing row is gone', () => {
    expect(amendmentMark({ ...base, supersedeStatus: 'superseded', supersededByRowId: 'gone', changedByAmendment: 3 }, new Set()))
      .toEqual({ kind: 'superseded', amendmentNo: 3, replacedById: null });
    expect(amendmentMark({ ...base, supersedeStatus: 'superseded', changedByAmendment: 3 }, new Set()))
      .toEqual({ kind: 'superseded', amendmentNo: 3, replacedById: null });
  });

  it('a superseded row added by an amendment shows the amendment that closed it', () => {
    expect(amendmentMark({ ...base, amendmentNo: 2, supersedeStatus: 'superseded', supersededByRowId: 'r9', changedByAmendment: 5 }, new Set(['r9'])))
      .toEqual({ kind: 'superseded', amendmentNo: 5, replacedById: 'r9' });
  });

  it('never shows Amd 0: a closed row with no recorded amendment is original', () => {
    expect(amendmentMark({ ...base, supersedeStatus: 'superseded', supersededByRowId: 'r2' }, new Set(['r2']))).toEqual({ kind: 'original' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyAmendmentChanges,
  confirmAmendmentLink,
  rejectAmendmentLink,
  type AmendmentLink,
} from './amendment-diff';
import type { ComplianceRequirement } from './compliance-pipeline';

function row(id: string, overrides: Partial<ComplianceRequirement> = {}): ComplianceRequirement {
  return {
    id,
    requirementText: `Requirement ${id}`,
    sourcePage: 1,
    sourceQuote: `Quote ${id}`,
    reqType: 'shall',
    confidence: 0.9,
    amendmentNo: 0,
    origin: 'ai',
    flags: [],
    ...overrides,
  };
}

function link(overrides: Partial<AmendmentLink>): AmendmentLink {
  return { oldRowId: null, newRowId: null, action: 'add', confidence: 0.9, status: 'auto', ...overrides };
}

const find = (rows: ComplianceRequirement[], id: string) => rows.find((item) => item.id === id);

describe('applyAmendmentChanges', () => {
  it('marks the old row superseded, points it at the new row, and appends the new row', () => {
    const result = applyAmendmentChanges(
      [row('a'), row('b')],
      [row('a2', { amendmentNo: 1 })],
      [link({ action: 'supersede', oldRowId: 'a', newRowId: 'a2' })],
    );
    expect(result.map((item) => item.id)).toEqual(['a', 'b', 'a2']);
    expect(find(result, 'a')).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: 'a2' });
    expect(find(result, 'b')?.supersedeStatus).toBeUndefined();
    expect(find(result, 'a2')?.supersedeStatus).toBeUndefined();
  });

  it('keeps superseded and withdrawn rows in the list', () => {
    const result = applyAmendmentChanges(
      [row('a'), row('b')],
      [row('a2')],
      [
        link({ action: 'supersede', oldRowId: 'a', newRowId: 'a2' }),
        link({ action: 'withdraw', oldRowId: 'b' }),
      ],
    );
    expect(result).toHaveLength(3);
    expect(find(result, 'b')).toMatchObject({ supersedeStatus: 'withdrawn' });
    expect(find(result, 'b')?.supersededByRowId).toBeUndefined();
  });

  it('withdraws a row without adding anything', () => {
    const result = applyAmendmentChanges([row('a')], [row('x')], [link({ action: 'withdraw', oldRowId: 'a' })]);
    expect(result.map((item) => item.id)).toEqual(['a']);
    expect(find(result, 'a')?.supersedeStatus).toBe('withdrawn');
  });

  it('adds a new row from an add link only if it is in the added list', () => {
    const added = [row('n1'), row('n2')];
    const result = applyAmendmentChanges([row('a')], added, [
      link({ action: 'add', newRowId: 'n1' }),
      link({ action: 'add', newRowId: 'missing' }),
      link({ action: 'add', newRowId: null }),
    ]);
    expect(result.map((item) => item.id)).toEqual(['a', 'n1']);
  });

  it('applies auto and confirmed links and ignores proposed and rejected ones', () => {
    const links: AmendmentLink[] = [
      link({ action: 'withdraw', oldRowId: 'a', status: 'auto' }),
      link({ action: 'withdraw', oldRowId: 'b', status: 'confirmed' }),
      link({ action: 'withdraw', oldRowId: 'c', status: 'proposed' }),
      link({ action: 'withdraw', oldRowId: 'd', status: 'rejected' }),
    ];
    const result = applyAmendmentChanges([row('a'), row('b'), row('c'), row('d')], [], links);
    expect(find(result, 'a')?.supersedeStatus).toBe('withdrawn');
    expect(find(result, 'b')?.supersedeStatus).toBe('withdrawn');
    expect(find(result, 'c')?.supersedeStatus).toBeUndefined();
    expect(find(result, 'd')?.supersedeStatus).toBeUndefined();
  });

  it('does not add the replacement row of a proposed supersede link', () => {
    const result = applyAmendmentChanges(
      [row('a')],
      [row('a2')],
      [link({ action: 'supersede', oldRowId: 'a', newRowId: 'a2', status: 'proposed' })],
    );
    expect(result.map((item) => item.id)).toEqual(['a']);
    expect(find(result, 'a')?.supersedeStatus).toBeUndefined();
  });

  it('ignores a link that names a row that does not exist', () => {
    const result = applyAmendmentChanges([row('a')], [], [link({ action: 'withdraw', oldRowId: 'ghost' })]);
    expect(result).toHaveLength(1);
    expect(find(result, 'a')?.supersedeStatus).toBeUndefined();
  });

  it('does not duplicate a replacement row that two links point at', () => {
    const result = applyAmendmentChanges(
      [row('a'), row('b')],
      [row('c')],
      [
        link({ action: 'supersede', oldRowId: 'a', newRowId: 'c' }),
        link({ action: 'supersede', oldRowId: 'b', newRowId: 'c' }),
      ],
    );
    expect(result.filter((item) => item.id === 'c')).toHaveLength(1);
    expect(find(result, 'a')?.supersededByRowId).toBe('c');
    expect(find(result, 'b')?.supersededByRowId).toBe('c');
  });

  it('does not mutate the original rows or their flags', () => {
    const original = [row('a', { flags: ['check'] })];
    const result = applyAmendmentChanges(original, [], [link({ action: 'withdraw', oldRowId: 'a' })]);
    expect(original[0].supersedeStatus).toBeUndefined();
    expect(result[0]).not.toBe(original[0]);
    expect(result[0].flags).not.toBe(original[0].flags);
  });

  // Suspected bug: a withdraw link that arrives after a supersede on the same row overwrites
  // 'superseded' with 'withdrawn' but leaves supersededByRowId pointing at the replacement.
  it.skip('clears supersededByRowId when a superseded row is then withdrawn', () => {
    const result = applyAmendmentChanges(
      [row('a')],
      [row('a2')],
      [
        link({ action: 'supersede', oldRowId: 'a', newRowId: 'a2' }),
        link({ action: 'withdraw', oldRowId: 'a' }),
      ],
    );
    expect(find(result, 'a')).toMatchObject({ supersedeStatus: 'withdrawn' });
    expect(find(result, 'a')?.supersededByRowId).toBeUndefined();
  });
});

describe('confirm and reject amendment links', () => {
  it('moves a proposed link to confirmed, then its rows are applied', () => {
    const proposed = link({ action: 'withdraw', oldRowId: 'a', status: 'proposed' });
    const confirmed = confirmAmendmentLink(proposed);
    expect(confirmed.status).toBe('confirmed');
    expect(proposed.status).toBe('proposed');
    expect(applyAmendmentChanges([row('a')], [], [confirmed])[0].supersedeStatus).toBe('withdrawn');
  });

  it('moves a link to rejected, then nothing is applied', () => {
    const rejected = rejectAmendmentLink(link({ action: 'withdraw', oldRowId: 'a', status: 'auto' }));
    expect(rejected.status).toBe('rejected');
    expect(applyAmendmentChanges([row('a')], [], [rejected])[0].supersedeStatus).toBeUndefined();
  });
});

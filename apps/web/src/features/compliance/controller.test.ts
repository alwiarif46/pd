import { describe, expect, it } from 'vitest';
import type { ComplianceRow } from '@/types';
import { complianceRowDto } from '@/test/fixtures';
import {
  complianceFileName,
  deriveLists,
  exportSheet,
  filterRows,
  NO_FILTERS,
  NO_REF_HEADING,
  toComplianceRow,
  toCreateBody,
  toRowPatch,
} from './controller';
import { csvSafe } from '@/schedule/export';

const none = new Set<string>();

function row(over: Partial<ComplianceRow> = {}): ComplianceRow {
  return { ...toComplianceRow(complianceRowDto(), none), ...over };
}

describe('toComplianceRow', () => {
  it('maps the stored names and keeps the source fields', () => {
    const r = toComplianceRow(complianceRowDto({ sourcePageEnd: 13 }), none);
    expect(r).toMatchObject({
      id: 'req-1',
      reqId: 'L.4.2',
      requirement: 'The offeror shall describe its staffing approach.',
      type: 'shall',
      sourcePage: 12,
      sourcePageEnd: 13,
      quoteVerified: true,
      origin: 'ai',
      flags: [],
      amendment: { kind: 'original' },
    });
  });

  it('treats a row with no origin as the AI’s, and maps flags and the amendment mark', () => {
    const r = toComplianceRow(
      complianceRowDto({ origin: null, flags: ['ocr', 'unknown'], supersedeStatus: 'superseded', changedByAmendment: 2, supersededByRowId: 'req-9' }),
      new Set(['req-9']),
    );
    expect(r.origin).toBe('ai');
    expect(r.flags).toEqual(['ocr']); // no quote_unverified: with no stored origin the slider (toRowDetailData) shows none either
    expect(r.amendment).toEqual({ kind: 'superseded', amendmentNo: 2, replacedById: 'req-9' });
  });
});

describe('filterRows', () => {
  const a = row({ id: 'a', reqId: 'L.1', sectionRef: 'Section L', requirement: 'Provide a Staffing plan.', type: 'shall', status: 'open', owner: 'Sam' });
  const b = row({ id: 'b', reqId: 'L.2', sectionRef: 'Section L.2', requirement: 'Submit pricing.', type: 'must', status: 'done', owner: null, flags: ['ocr'] });
  const c = row({ id: 'c', reqId: 'C.1', sectionRef: 'Section C', requirement: 'Old text.', amendment: { kind: 'superseded', amendmentNo: 2, replacedById: 'd' } });
  const d = row({ id: 'd', reqId: 'C.1a', sectionRef: 'Section C', requirement: 'New text.', amendment: { kind: 'added', amendmentNo: 2 } });
  const e = row({ id: 'e', reqId: 'C.9', sectionRef: null, requirement: 'Gone.', amendment: { kind: 'withdrawn', amendmentNo: 3 } });
  const all = [a, b, c, d, e];
  const ids = (f: Partial<typeof NO_FILTERS>) => filterRows(all, { ...NO_FILTERS, ...f }).map((r) => r.id);

  it('keeps everything with no filters', () => expect(ids({})).toEqual(['a', 'b', 'c', 'd', 'e']));
  it('filters by section, exactly', () => {
    expect(ids({ section: 'Section L' })).toEqual(['a']);
    expect(ids({ section: 'Section C' })).toEqual(['c', 'd']);
  });
  it('filters by type', () => expect(ids({ type: 'must' })).toEqual(['b']));
  it('filters by status', () => expect(ids({ status: 'done' })).toEqual(['b']));
  it('filters by owner', () => expect(ids({ owner: 'Sam' })).toEqual(['a']));
  it('filters by amendment: original, or added, superseded or withdrawn by N', () => {
    expect(ids({ amendment: 'original' })).toEqual(['a', 'b']);
    expect(ids({ amendment: 2 })).toEqual(['c', 'd']);
    expect(ids({ amendment: 3 })).toEqual(['e']);
  });
  it('shows flagged rows only', () => expect(ids({ flaggedOnly: true })).toEqual(['b']));
  it('hides superseded and withdrawn rows', () => expect(ids({ hideClosed: true })).toEqual(['a', 'b', 'd']));
  it('searches ID, requirement and section, ignoring case', () => {
    expect(ids({ search: 'l.2' })).toEqual(['b']);
    expect(ids({ search: 'STAFFING' })).toEqual(['a']);
    expect(ids({ search: 'section c' })).toEqual(['c', 'd']);
    expect(ids({ search: '  nothing  ' })).toEqual([]);
  });
  it('filters nothing for check these', () => expect(ids({ checkThese: true })).toEqual(['a', 'b', 'c', 'd', 'e']));
  it('combines filters', () => expect(ids({ amendment: 2, hideClosed: true })).toEqual(['d']));
});

describe('deriveLists', () => {
  it('lists distinct sections in natural order, owners sorted, and amendment numbers ascending', () => {
    const rows = [
      row({ sectionRef: 'L.10', owner: 'Zed' }),
      row({ sectionRef: 'L.2', owner: 'Amy', amendment: { kind: 'added', amendmentNo: 3 } }),
      row({ sectionRef: 'L.2', owner: 'Amy', amendment: { kind: 'withdrawn', amendmentNo: 2 } }),
      row({ sectionRef: null, owner: null, amendment: { kind: 'superseded', amendmentNo: 3, replacedById: null } }),
    ];
    expect(deriveLists(rows)).toEqual({ sections: ['L.2', 'L.10'], owners: ['Amy', 'Zed'], amendments: [2, 3] });
  });

  it('is empty for no rows', () => expect(deriveLists([])).toEqual({ sections: [], owners: [], amendments: [] }));
});

describe('exportSheet', () => {
  const rows = [
    row({ id: '1', reqId: 'L.1', instrRef: 'L.1', requirement: 'One.', sourcePage: 4, sourcePageEnd: 6 }),
    row({ id: '2', reqId: 'X.1', instrRef: null, requirement: 'Two.', sourcePage: null, origin: 'user' }),
    row({ id: '3', reqId: 'L.2', instrRef: 'L.1', requirement: 'Three.', amendment: { kind: 'superseded', amendmentNo: 2, replacedById: null } }),
    row({ id: '4', reqId: 'L.3', instrRef: 'L.3', requirement: 'Four.', amendment: { kind: 'withdrawn', amendmentNo: 3 } }),
    row({ id: '5', reqId: 'L.4', instrRef: 'L.3', requirement: 'Five.', amendment: { kind: 'added', amendmentNo: 2 } }),
  ];

  it('groups by instruction reference in order of first appearance, with a heading row each', () => {
    const sheet = exportSheet(rows, true);
    expect(sheet[0]).toEqual(['ID', 'Section', 'Requirement', 'Type', 'L ref', 'M factor', 'Response section', 'Owner', 'Status', 'Source page', 'Amendment']);
    expect(sheet.map((r) => r[0])).toEqual(['ID', 'Section L L.1', 'L.1', 'L.2', NO_REF_HEADING, 'X.1', 'Section L L.3', 'L.3', 'L.4']);
    expect(sheet[2]?.[9]).toBe('4–6');
  });

  it('includes superseded and withdrawn rows with their status, and user rows as added by the user', () => {
    const sheet = exportSheet(rows, false);
    expect(sheet[0]?.slice(4, 6)).toEqual(['Instruction ref', 'Evaluation factor']);
    expect(sheet[1]?.[0]).toBe('Instruction L.1');
    const byId = Object.fromEntries(sheet.map((r) => [r[0], r[10]]));
    expect(byId['L.1']).toBe('Original');
    expect(byId['L.2']).toBe('Superseded by Amd 2');
    expect(byId['L.3']).toBe('Withdrawn by Amd 3');
    expect(byId['L.4']).toBe('Added by Amd 2');
    expect(byId['X.1']).toBe('Added by user');
  });

  it('is guarded against formulas in the CSV', () => {
    const sheet = csvSafe(exportSheet([row({ requirement: '=HYPERLINK("x")', sectionRef: '-2' })], true));
    expect(sheet[2]?.[2]).toBe(`'=HYPERLINK("x")`);
    expect(sheet[2]?.[1]).toBe(`'-2`);
  });
});

describe('complianceFileName', () => {
  it('slugs the bid name', () => expect(complianceFileName('VA EHR Support!', 'xlsx')).toBe('va-ehr-support-compliance.xlsx'));
  it('falls back without a name', () => expect(complianceFileName('', 'csv')).toBe('compliance.csv'));
});

describe('request bodies', () => {
  it('drops the empty fields of a new requirement', () => {
    expect(toCreateBody({ requirement: ' Do it. ', sectionRef: ' ', type: null, owner: null })).toEqual({ requirementText: 'Do it.' });
    expect(toCreateBody({ requirement: 'Do it.', sectionRef: 'L.1', type: 'must', owner: 'Sam' })).toEqual({
      requirementText: 'Do it.',
      sectionRef: 'L.1',
      reqType: 'must',
      owner: 'Sam',
    });
  });

  it('renames requirement and keeps only the keys edited', () => {
    expect(toRowPatch({ requirement: 'New.' })).toEqual({ requirementText: 'New.' });
    expect(toRowPatch({ owner: null, status: 'done' })).toEqual({ owner: null, status: 'done' });
    expect(toRowPatch({})).toEqual({});
  });
});

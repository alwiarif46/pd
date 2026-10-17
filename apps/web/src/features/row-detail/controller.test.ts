import { describe, expect, it } from 'vitest';
import { bidFactDto, complianceRowDto, docDto, rowHistoryDto, scheduleActivityDto } from '@/test/fixtures';
import { editFieldsFor, rowPatchFor, rowSourceOf, toHistory, toRowDetailData } from './controller';

const docs = [docDto({ id: 'doc-1', fileName: 'rfp.pdf' })];
const none = new Set<string>();

describe('toRowDetailData', () => {
  it('maps a compliance row: reqId as title, refs, confidence, status label, document name', () => {
    const row = toRowDetailData('compliance_rows', complianceRowDto({ flags: ['ocr', 'unknown'], status: 'drafted', owner: 'Dana' }), docs, none);
    expect(row).toEqual({
      id: 'req-1',
      kind: 'compliance',
      title: 'L.4.2',
      sourceQuote: 'The offeror shall describe its staffing approach.',
      sectionRef: 'Section L.4.2',
      documentName: 'rfp.pdf',
      sourcePage: 12,
      sourcePageEnd: null,
      amendment: { kind: 'original' },
      reqType: 'shall',
      instrRef: 'L.4.2',
      evalRef: 'M.2',
      confidence: 0.92,
      flags: ['ocr'],
      quoteVerified: true,
      confirmed: null,
      owner: 'Dana',
      status: 'Drafted',
      origin: 'ai',
    });
  });

  it('maps a superseded row to a jump only when the replacing row is on the tab', () => {
    const dto = complianceRowDto({ supersedeStatus: 'superseded', changedByAmendment: 2, supersededByRowId: 'req-2' });
    expect(toRowDetailData('compliance_rows', dto, docs, new Set(['req-2'])).amendment).toEqual({
      kind: 'superseded',
      amendmentNo: 2,
      replacedById: 'req-2',
    });
    expect(toRowDetailData('compliance_rows', dto, docs, none).amendment).toEqual({ kind: 'superseded', amendmentNo: 2, replacedById: null });
  });

  it('maps a schedule activity with nulls for what it does not have; a template row shows no origin', () => {
    const row = toRowDetailData('schedule_activities', scheduleActivityDto({ origin: 'template', owner: 'Sam', status: 'On track' }), docs, none);
    expect(row).toMatchObject({
      kind: 'schedule',
      title: 'First draft writing',
      sectionRef: null,
      documentName: null,
      reqType: null,
      instrRef: null,
      evalRef: null,
      confidence: null,
      flags: [],
      quoteVerified: null,
      confirmed: null,
      owner: 'Sam',
      status: 'On track',
      origin: null,
    });
  });

  it('flags an AI quote that was not verified, and shows Verified only for a row with a quote', () => {
    const ai = scheduleActivityDto({ origin: 'ai', sourceQuote: 'Due Nov 25.', sourcePage: 3, documentId: 'doc-1', quoteVerified: false });
    expect(toRowDetailData('schedule_activities', ai, docs, none)).toMatchObject({ flags: ['quote_unverified'], quoteVerified: false, origin: 'ai' });
  });

  it('maps a bid fact: field as title, confirmed shown, no owner or status', () => {
    const row = toRowDetailData('bid_facts', bidFactDto({ confirmed: false }), docs, none);
    expect(row).toMatchObject({ kind: 'bid_fact', title: 'Agency', confirmed: false, owner: null, status: null, origin: 'user' });
  });

  it('names no document that is not in the list', () => {
    expect(toRowDetailData('compliance_rows', complianceRowDto({ documentId: 'gone' }), docs, none).documentName).toBeNull();
  });
});

describe('editFieldsFor', () => {
  it('offers the compliance fields with the status as a select', () => {
    const fields = editFieldsFor('compliance_rows', complianceRowDto({ owner: null, responseSection: '3.1' }));
    expect(fields.map((f) => [f.key, f.label, f.kind, f.value])).toEqual([
      ['requirementText', 'Requirement', 'longtext', 'The offeror shall describe its staffing approach.'],
      ['owner', 'Owner', 'text', ''],
      ['status', 'Status', 'select', 'open'],
      ['responseSection', 'Response section', 'text', '3.1'],
    ]);
    expect(fields[2]!.options?.map((o) => o.value)).toEqual(['open', 'assigned', 'drafted', 'done']);
  });

  it('offers no date fields on a schedule activity', () => {
    const keys = editFieldsFor('schedule_activities', scheduleActivityDto()).map((f) => f.key);
    expect(keys).toEqual(['label', 'owner', 'status']);
    expect(editFieldsFor('schedule_activities', scheduleActivityDto()).some((f) => f.kind === 'date')).toBe(false);
  });

  it('offers the value of a bid fact', () => {
    expect(editFieldsFor('bid_facts', bidFactDto()).map((f) => [f.key, f.value])).toEqual([['value', 'VA']]);
  });
});

describe('rowPatchFor', () => {
  const fields = editFieldsFor('compliance_rows', complianceRowDto({ owner: 'Dana', responseSection: '3.1' }));

  it('sends only the changed keys', () => {
    expect(rowPatchFor('compliance_rows', { owner: 'Sam', status: 'open', requirementText: fields[0]!.value }, fields)).toEqual({ owner: 'Sam' });
  });

  it('sends an emptied nullable field as null, and nothing when nothing changed', () => {
    expect(rowPatchFor('compliance_rows', { owner: '', responseSection: '' }, fields)).toEqual({ owner: null, responseSection: null });
    expect(rowPatchFor('compliance_rows', {}, fields)).toEqual({});
  });

  it('drops keys the table does not take', () => {
    const scheduleFields = editFieldsFor('schedule_activities', scheduleActivityDto());
    expect(rowPatchFor('schedule_activities', { label: 'Pink team', startDate: '2026-12-01' }, scheduleFields)).toEqual({ label: 'Pink team' });
  });
});

describe('toHistory', () => {
  it('labels the fields and names System for changes no user made', () => {
    expect(
      toHistory([
        rowHistoryDto(),
        rowHistoryDto({ id: 'hist-2', field: 'requirementText', userName: null, oldValue: 'a', newValue: 'b' }),
        rowHistoryDto({ id: 'hist-3', field: 'someNewColumn' }),
      ]),
    ).toEqual([
      { id: 'hist-1', who: 'Dana Reyes', field: 'Owner', from: null, to: 'Dana', at: '2026-10-02T15:30:00.000Z' },
      { id: 'hist-2', who: 'System', field: 'Requirement', from: 'a', to: 'b', at: '2026-10-02T15:30:00.000Z' },
      { id: 'hist-3', who: 'Dana Reyes', field: 'someNewColumn', from: null, to: 'Dana', at: '2026-10-02T15:30:00.000Z' },
    ]);
  });
});

describe('rowSourceOf', () => {
  it('needs a document and a page', () => {
    expect(rowSourceOf(complianceRowDto({ sourcePageEnd: 13 }))).toEqual({
      documentId: 'doc-1',
      page: 12,
      pageEnd: 13,
      quote: 'The offeror shall describe its staffing approach.',
    });
    expect(rowSourceOf(complianceRowDto({ documentId: null }))).toBeNull();
    expect(rowSourceOf(complianceRowDto({ sourcePage: null }))).toBeNull();
  });
});

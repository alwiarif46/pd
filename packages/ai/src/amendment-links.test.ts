import { describe, expect, it } from 'vitest';
import {
  diffAmendment,
  planAmendmentApply,
  withdrawCandidates,
  type DiffLink,
  type ExistingRow,
} from './amendment-diff';
import type { ComplianceRequirement } from './compliance-pipeline';
import type { ModelProvider, ModelRequest } from './providers';

const OLD_A = '11111111-1111-4111-8111-111111111111';
const OLD_B = '22222222-2222-4222-8222-222222222222';
const OLD_C = '33333333-3333-4333-8333-333333333333';

const existing: ExistingRow[] = [
  { id: OLD_A, reqId: 'C.3.1-01', sectionRef: 'C.3.1', requirementText: 'Help desk 8 to 5', sourceQuote: 'The contractor shall staff the help desk from 8 to 5.' },
  { id: OLD_B, reqId: 'C.3.4-01', sectionRef: 'C.3.4', requirementText: 'Monthly report', sourceQuote: 'The contractor shall deliver a monthly report.' },
  { id: OLD_C, reqId: 'C.3.41-01', sectionRef: 'C.3.41', requirementText: 'Badges', sourceQuote: 'Badges are worn on site at all times.' },
];

const amendmentPages = [{
  pageNo: 1,
  ocrUsed: false,
  text: 'AMENDMENT 0002\nC.3.1 is revised: The contractor shall staff the help desk from 7 to 7.\nSection C.3.4 is deleted in its entirety.\nC.3.5 The contractor shall keep a visitor log.',
}];

function newRow(sectionRef: string, sourceQuote: string, overrides: Partial<ComplianceRequirement> = {}): ComplianceRequirement {
  return {
    id: `${sectionRef}-01`, sectionRef, requirementText: sourceQuote, sourcePage: 1, sourceQuote,
    reqType: 'shall', confidence: 0.9, amendmentNo: 2, origin: 'ai', flags: [], supersedeStatus: 'active', ...overrides,
  };
}

const newRows = [
  newRow('C.3.1', 'The contractor shall staff the help desk from 7 to 7.'),
  newRow('C.3.5', 'The contractor shall keep a visitor log.'),
];

function provider(links: unknown[]): ModelProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'ollama',
    prompts,
    async complete(request: ModelRequest) {
      prompts.push(request.messages[0].content);
      return { text: '', json: { links }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 7 } };
    },
  };
}

const config = { providerName: 'ollama', model: 'test', maxOutputTokens: 100 };

describe('withdrawCandidates', () => {
  it('takes rows whose section appears near a delete word, as a whole reference', () => {
    expect(withdrawCandidates(existing, amendmentPages).map((row) => row.id)).toEqual([OLD_B]);
    expect(withdrawCandidates(existing, [{ pageNo: 1, ocrUsed: false, text: 'C.3.4 is revised.' }])).toEqual([]);
    expect(withdrawCandidates(existing, [{ pageNo: 1, ocrUsed: false, text: 'Strike C.3.4.1 only.' }])).toEqual([]);
    expect(withdrawCandidates(existing, [{ pageNo: 1, ocrUsed: false, text: 'Rescind paragraph C.3.41.' }]).map((row) => row.id)).toEqual([OLD_C]);
  });
});

describe('diffAmendment', () => {
  it('maps temporary keys to new-row indexes, keeps old ids, and quote-checks every link', async () => {
    const model = provider([
      { action: 'supersede', newKey: 'n1', oldRowId: OLD_A, confidence: 0.95, sourceQuote: 'C.3.1 is revised: The contractor shall staff the help desk from 7 to 7.', sourcePage: 1 },
      { action: 'withdraw', newKey: null, oldRowId: OLD_B, confidence: 0.6, sourceQuote: 'Section C.3.4 is deleted in its entirety.', sourcePage: 3 },
      { action: 'add', newKey: 'n2', oldRowId: null, confidence: 0.7 },
    ]);
    const diff = await diffAmendment({ newRows, existing, amendmentPages, provider: model, config });
    expect(diff.dropped).toBe(0);
    expect(diff.tokensUsed).toBe(7);
    expect(diff.links).toEqual([
      { action: 'supersede', newIndex: 0, oldRowId: OLD_A, confidence: 0.95, sourcePage: 1, sourceQuote: 'C.3.1 is revised: The contractor shall staff the help desk from 7 to 7.' },
      // The cited page is corrected to the page the quote is on.
      { action: 'withdraw', newIndex: null, oldRowId: OLD_B, confidence: 0.6, sourcePage: 1, sourceQuote: 'Section C.3.4 is deleted in its entirety.' },
      { action: 'add', newIndex: 1, oldRowId: null, confidence: 0.7, sourcePage: null, sourceQuote: null },
    ]);
    // The model saw keys, not req ids, for the new rows, and old rows by id.
    expect(model.prompts[0]).toContain('"key":"n1"');
    expect(model.prompts[0]).toContain(OLD_A);
    expect(model.prompts[0]).not.toContain('"key":"C.3.1-01"');
  });

  it('drops and counts links that are malformed, not offered, or quote text not in the amendment', async () => {
    const model = provider([
      'not an object',
      { action: 'replace', newKey: 'n1', oldRowId: OLD_A, confidence: 0.9, sourceQuote: 'C.3.1 is revised', sourcePage: 1 },
      // n9 does not exist; OLD_C is not a candidate of n1; OLD_A is not a withdraw candidate.
      { action: 'supersede', newKey: 'n9', oldRowId: OLD_A, confidence: 0.9, sourceQuote: 'C.3.1 is revised', sourcePage: 1 },
      { action: 'supersede', newKey: 'n1', oldRowId: OLD_C, confidence: 0.9, sourceQuote: 'C.3.1 is revised', sourcePage: 1 },
      { action: 'withdraw', newKey: null, oldRowId: OLD_A, confidence: 0.9, sourceQuote: 'C.3.1 is revised', sourcePage: 1 },
      // A UUID-shaped id that is not a row, and a req id instead of a row id.
      { action: 'withdraw', newKey: null, oldRowId: '99999999-9999-4999-8999-999999999999', confidence: 0.9, sourceQuote: 'is deleted', sourcePage: 1 },
      { action: 'supersede', newKey: 'n1', oldRowId: 'C.3.1-01', confidence: 0.9, sourceQuote: 'C.3.1 is revised', sourcePage: 1 },
      // No quote, a quote not in the amendment, no confidence.
      { action: 'withdraw', newKey: null, oldRowId: OLD_B, confidence: 0.9 },
      { action: 'withdraw', newKey: null, oldRowId: OLD_B, confidence: 0.9, sourceQuote: 'Section C.3.4 is kept as written.', sourcePage: 1 },
      { action: 'withdraw', newKey: null, oldRowId: OLD_B, sourceQuote: 'Section C.3.4 is deleted in its entirety.', sourcePage: 1 },
      { action: 'add', newKey: 'n7', oldRowId: null, confidence: 0.9 },
    ]);
    const diff = await diffAmendment({ newRows, existing, amendmentPages, provider: model, config });
    expect(diff.links).toEqual([]);
    expect(diff.dropped).toBe(11);
  });

  it('makes no model call when there are no new rows and nothing to withdraw', async () => {
    const model = provider([]);
    const diff = await diffAmendment({ newRows: [], existing, amendmentPages: [{ pageNo: 1, ocrUsed: false, text: 'Dates only.' }], provider: model, config });
    expect(diff).toEqual({ links: [], dropped: 0, tokensUsed: 0 });
    expect(model.prompts).toHaveLength(0);
  });

  it('throws when the JSON has no links, so the run fails and can be retried', async () => {
    const model: ModelProvider = { name: 'ollama', complete: async () => ({ text: '', json: { rows: [] }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }) };
    await expect(diffAmendment({ newRows, existing, amendmentPages, provider: model, config })).rejects.toThrow('missing links');
  });
});

describe('planAmendmentApply', () => {
  let counter = 0;
  const ids = () => `new-${(counter += 1)}`;
  const link = (overrides: Partial<DiffLink>): DiffLink => ({
    action: 'supersede', newIndex: 0, oldRowId: OLD_A, confidence: 0.9, sourcePage: 1, sourceQuote: 'q', ...overrides,
  });
  const active = existing.map((row) => ({ id: row.id }));

  it('inserts every new row with a generated id; auto links close rows; proposed links leave them active', () => {
    counter = 0;
    const plan = planAmendmentApply(active, newRows, [
      link({ action: 'supersede', newIndex: 0, oldRowId: OLD_A, confidence: 0.95 }),
      link({ action: 'withdraw', newIndex: null, oldRowId: OLD_B, confidence: 0.5 }),
    ], 0.8, ids);
    expect(plan.inserts.map((row) => [row.id, row.sectionRef])).toEqual([['new-1', 'C.3.1'], ['new-2', 'C.3.5']]);
    expect(plan.closes).toEqual([{ rowId: OLD_A, status: 'superseded', supersededByRowId: 'new-1' }]);
    expect(plan.links).toEqual([
      { action: 'supersede', oldRowId: OLD_A, newRowId: 'new-1', confidence: 0.95, status: 'auto', sourcePage: 1, sourceQuote: 'q' },
      { action: 'withdraw', oldRowId: OLD_B, newRowId: null, confidence: 0.5, status: 'proposed', sourcePage: 1, sourceQuote: 'q' },
      // The row that replaces nothing gets an add link with a null old row.
      { action: 'add', oldRowId: null, newRowId: 'new-2', confidence: null, status: 'auto', sourcePage: null, sourceQuote: null },
    ]);
    expect(plan.dropped).toBe(0);
  });

  it('add links are always auto, whatever the confidence; a new row with a proposed supersede gets no add link', () => {
    counter = 0;
    const plan = planAmendmentApply(active, newRows, [
      link({ action: 'add', newIndex: 1, oldRowId: null, confidence: 0.1, sourcePage: null, sourceQuote: null }),
      link({ action: 'supersede', newIndex: 0, oldRowId: OLD_A, confidence: 0.3 }),
    ], 0.8, ids);
    expect(plan.links.find((item) => item.action === 'add')).toMatchObject({ newRowId: 'new-2', status: 'auto', confidence: 0.1 });
    expect(plan.links.filter((item) => item.newRowId === 'new-1')).toEqual([
      expect.objectContaining({ action: 'supersede', status: 'proposed' }),
    ]);
    expect(plan.closes).toEqual([]);
    expect(plan.inserts).toHaveLength(2);
  });

  it('several new rows replacing one: superseded_by is the highest-confidence one and every link is kept', () => {
    counter = 0;
    const plan = planAmendmentApply(active, newRows, [
      link({ newIndex: 0, oldRowId: OLD_A, confidence: 0.85 }),
      link({ newIndex: 1, oldRowId: OLD_A, confidence: 0.92 }),
    ], 0.8, ids);
    expect(plan.closes).toEqual([{ rowId: OLD_A, status: 'superseded', supersededByRowId: 'new-2' }]);
    expect(plan.links.filter((item) => item.action === 'supersede').map((item) => item.newRowId)).toEqual(['new-1', 'new-2']);
    expect(plan.links.some((item) => item.action === 'add')).toBe(false);
  });

  it('drops links to rows that are no longer active, and a withdraw of a row a supersede closes', () => {
    counter = 0;
    const plan = planAmendmentApply([{ id: OLD_A }], newRows, [
      link({ newIndex: 0, oldRowId: OLD_A, confidence: 0.9 }),
      link({ action: 'withdraw', newIndex: null, oldRowId: OLD_A, confidence: 0.9 }),
      link({ action: 'withdraw', newIndex: null, oldRowId: OLD_B, confidence: 0.9 }),
    ], 0.8, ids);
    expect(plan.dropped).toBe(2);
    expect(plan.closes).toEqual([{ rowId: OLD_A, status: 'superseded', supersededByRowId: 'new-1' }]);
    expect(plan.links.map((item) => item.action)).toEqual(['supersede', 'add']);
  });

  it('a duplicate link counts once, at its highest confidence', () => {
    counter = 0;
    const plan = planAmendmentApply(active, newRows.slice(0, 1), [
      link({ confidence: 0.5 }),
      link({ confidence: 0.9 }),
    ], 0.8, ids);
    expect(plan.links).toEqual([expect.objectContaining({ action: 'supersede', confidence: 0.9, status: 'auto' })]);
  });
});

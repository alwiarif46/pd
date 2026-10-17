import { describe, expect, it } from 'vitest';
import { bidFactDto, scheduleActivityDto, tabProposalDto } from '@/test/fixtures';
import { activityProposals, factProposals, proposalSource } from './derive';

const ts = (day: string) => `${day}T00:00:00.000Z`;

describe('factProposals', () => {
  const mine = bidFactDto({ id: 'fact-1', field: 'Agency', value: 'VA', origin: 'user' });
  const ai = bidFactDto({ id: 'fact-ai', field: 'Agency', value: 'Veterans Affairs', origin: 'ai', documentId: 'doc-1', sourcePage: 1, sourcePageEnd: 2 });
  const next = bidFactDto({
    id: 'fact-new',
    field: 'Agency',
    value: 'GSA',
    origin: 'ai',
    documentId: 'doc-amd',
    sourcePage: 7,
    sourcePageEnd: 8,
    sourceQuote: 'Row quote.',
  });

  it('lists the old rows found by oldRowIds and skips a missing one', () => {
    const [p] = factProposals([tabProposalDto(next, { oldRowIds: ['fact-1', 'gone', 'fact-ai'] })], [mine, ai]);
    expect(p).toMatchObject({ id: 'link-a', rowId: 'fact-new', amendmentNo: 2, next: { kind: 'fact', label: 'Agency', value: 'GSA' } });
    expect(p!.replaces).toEqual([
      { rowId: 'fact-1', subject: { kind: 'fact', label: 'Agency', value: 'VA' }, isAi: false, sourcePage: null, sourcePageEnd: null },
      { rowId: 'fact-ai', subject: { kind: 'fact', label: 'Agency', value: 'Veterans Affairs' }, isAi: true, sourcePage: 1, sourcePageEnd: 2 },
    ]);
  });

  it("uses the proposal's source first, then the row's", () => {
    const own = factProposals([tabProposalDto(next, { sourcePage: 4, sourceQuote: 'Agency is GSA.' })], [])[0]!;
    expect(own).toMatchObject({ sourcePage: 4, sourcePageEnd: null, sourceQuote: 'Agency is GSA.' });
    const row = factProposals([tabProposalDto(next)], [])[0]!;
    expect(row).toMatchObject({ sourcePage: 7, sourcePageEnd: 8, sourceQuote: 'Row quote.' });
  });
});

describe('activityProposals', () => {
  it('takes days with dayOf, a one-day end, and an undated row', () => {
    const dated = scheduleActivityDto({ id: 'act-new', label: 'Proposal due', startDate: ts('2026-12-02'), endDate: null });
    const undated = scheduleActivityDto({ id: 'act-u', label: 'Orals', startDate: null, endDate: null });
    const [a, b] = activityProposals([tabProposalDto(dated), tabProposalDto(undated, { linkId: 'link-b' })], []);
    expect(a!.next).toEqual({ kind: 'activity', label: 'Proposal due', start: '2026-12-02', end: '2026-12-02' });
    expect(b!.next).toEqual({ kind: 'activity', label: 'Orals', start: null, end: null });
  });

  it('counts an AI row by origin, or by its page when it has none', () => {
    const rows = [
      scheduleActivityDto({ id: 'a', origin: 'ai' }),
      scheduleActivityDto({ id: 'b', origin: null, sourcePage: 3 }),
      scheduleActivityDto({ id: 'c', origin: null }),
      scheduleActivityDto({ id: 'd', origin: 'template' }),
    ];
    const [p] = activityProposals([tabProposalDto(scheduleActivityDto({ id: 'new' }), { oldRowIds: ['a', 'b', 'c', 'd'] })], rows);
    expect(p!.replaces.map((r) => r.isAi)).toEqual([true, true, false, false]);
  });
});

describe('proposalSource', () => {
  const next = bidFactDto({ id: 'fact-new', documentId: 'doc-amd', sourcePage: 7, sourcePageEnd: 8, sourceQuote: 'Row quote.' });
  const old = bidFactDto({ id: 'fact-ai', origin: 'ai', documentId: 'doc-1', sourcePage: 1, sourcePageEnd: 2, sourceQuote: 'Old quote.' });

  it('opens the proposed row in the amendment document', () => {
    const dtos = [tabProposalDto(next, { sourcePage: 4, sourceQuote: 'Agency is GSA.', oldRowIds: ['fact-ai'] })];
    expect(proposalSource(dtos, [old], 'fact-new')).toEqual({ documentId: 'doc-amd', page: 4, pageEnd: null, quote: 'Agency is GSA.' });
    expect(proposalSource([tabProposalDto(next)], [old], 'fact-new')).toEqual({ documentId: 'doc-amd', page: 7, pageEnd: 8, quote: 'Row quote.' });
  });

  it('opens a replaced row in its own document', () => {
    expect(proposalSource([tabProposalDto(next)], [old], 'fact-ai')).toEqual({ documentId: 'doc-1', page: 1, pageEnd: 2, quote: 'Old quote.' });
  });

  it('is null without a document or a page', () => {
    expect(proposalSource([tabProposalDto({ ...next, documentId: null })], [], 'fact-new')).toBeNull();
    expect(proposalSource([tabProposalDto({ ...next, sourcePage: null })], [], 'fact-new')).toBeNull();
    expect(proposalSource([], [], 'nope')).toBeNull();
  });
});

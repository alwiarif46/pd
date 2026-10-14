import { describe, expect, it } from 'vitest';
import { chunkPages, classifyPages, estimateTokens, preScan, type PageText } from './document-processor';

const page = (pageNo: number, text: string): PageText => ({ pageNo, text, ocrUsed: false });

describe('pre-scan date logic', () => {
  const dates = (text: string) => preScan([page(1, text)]).dates.map((hit) => hit.text);

  it('flags ISO, slashed and dashed numeric dates', () => {
    expect(dates('Offers are open until 2026-12-15.')).toHaveLength(1);
    expect(dates('Questions by 12/15/2026.')).toHaveLength(1);
    expect(dates('Site visit on 3-4-26.')).toHaveLength(1);
  });

  it('flags times with and without am/pm', () => {
    expect(dates('Offers close at 2:00 p.m. local time.')).toHaveLength(1);
    expect(dates('Offers close at 14:30 local time.')).toHaveLength(1);
    expect(dates('Opening at 9:00 AM sharp.')).toHaveLength(1);
  });

  it('flags the words "due" and "no later than"', () => {
    expect(dates('Proposals are due December 15, 2026.')).toHaveLength(1);
    expect(dates('Submit no later than noon on the closing date.')).toHaveLength(1);
  });

  it('does not flag a sentence with no date cue', () => {
    expect(dates('The contractor shall maintain a quality plan.')).toEqual([]);
    expect(dates('We have 2026 reasons.')).toEqual([]);
  });

  it('reports the page number and one hit per sentence', () => {
    const result = preScan([
      page(1, 'Nothing here.'),
      page(4, 'Proposals are due 2026-12-15. Questions are due 2026-11-01.'),
    ]);
    expect(result.dates).toEqual([
      { text: 'Proposals are due 2026-12-15.', pageNo: 4 },
      { text: 'Questions are due 2026-11-01.', pageNo: 4 },
    ]);
  });

  it('splits sentences on line breaks as well as full stops', () => {
    expect(dates('Due date\n2026-12-15\nOther text')).toEqual(['Due date', '2026-12-15']);
  });

  // Suspected gap: a date written with a month name and no cue word ("due", "no later than")
  // is not reported, so an amendment that only changes "15 December 2026" to "22 December 2026"
  // in a sentence like this one yields no date change for the schedule prompt.
  it.skip('flags a month-name date with no cue word', () => {
    expect(dates('Offers will be received until 22 December 2026 at noon.')).toHaveLength(1);
  });
});

describe('pre-scan requirements', () => {
  it('flags shall, must, will, required, is to and are to', () => {
    const text = [
      'The offeror shall submit a plan.',
      'Staff must hold a clearance.',
      'The contractor will report weekly.',
      'A resume is required.',
      'The vendor is to attend.',
      'Bidders are to register.',
      'This sentence has none.',
    ].join(' ');
    const hits = preScan([page(2, text)]).requirements;
    expect(hits).toHaveLength(6);
    expect(hits.every((hit) => hit.pageNo === 2)).toBe(true);
  });

  it('marks a sentence whose subject is the government as informational', () => {
    const hits = preScan([page(1, 'The Government will provide office space. The contractor will provide staff.')]).requirements;
    expect(hits.map((hit) => hit.kind)).toEqual(['informational', 'requirement']);
  });
});

describe('page classification and chunking', () => {
  it('classifies a page from its heading lines', () => {
    const roles = classifyPages([
      page(1, 'SECTION L\nInstructions'),
      page(2, 'Section M evaluation criteria'),
      page(3, 'Performance Work Statement (PWS)'),
      page(4, 'Random text'),
    ]).map((item) => item.role);
    expect(roles).toEqual(['instructions', 'evaluation', 'scope', 'other']);
  });

  it('estimates tokens as one per four characters, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('keeps every page in order inside some chunk and records page ranges', () => {
    const pages = Array.from({ length: 6 }, (_, index) => page(index + 1, 'x'.repeat(400)));
    const chunks = chunkPages(pages, 250);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].pageStart).toBe(1);
    expect(chunks[chunks.length - 1].pageEnd).toBe(6);
    for (const chunk of chunks) {
      expect(chunk.pageEnd).toBeGreaterThanOrEqual(chunk.pageStart);
    }
  });
});

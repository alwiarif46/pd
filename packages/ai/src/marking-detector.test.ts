import { describe, expect, it } from 'vitest';
import {
  checkDocumentForMarkings,
  checkPageForMarkings,
  getMarkingSummary,
  shouldRejectDocument,
  textInMarkingScope,
} from './marking-checker';

const labels = (text: string, pageNo: number) => checkPageForMarkings(text, pageNo).map((found) => found.marking);

describe('marking scope', () => {
  it('searches pages 1 to 3 in full', () => {
    const text = 'Line one\nmiddle\nLine three';
    for (const pageNo of [1, 2, 3]) {
      expect(textInMarkingScope({ pageNo, text })).toBe(text);
    }
  });

  it('searches only the first and last non-empty lines from page 4 on', () => {
    const text = '\n  Header  \nbody one\nbody two\n  Footer  \n\n';
    expect(textInMarkingScope({ pageNo: 4, text })).toBe('Header\nFooter');
  });

  it('returns a single line once when header and footer are the same line, and nothing for a blank page', () => {
    expect(textInMarkingScope({ pageNo: 9, text: 'Only line' })).toBe('Only line');
    expect(textInMarkingScope({ pageNo: 9, text: ' \n\r\n ' })).toBe('');
  });

  it('handles CRLF line endings', () => {
    expect(textInMarkingScope({ pageNo: 5, text: 'Top\r\nmiddle\r\nBottom' })).toBe('Top\nBottom');
  });
});

describe('block markings', () => {
  it.each([
    ['CUI', 'CUI'],
    ['CONTROLLED UNCLASSIFIED', 'CONTROLLED UNCLASSIFIED'],
    ['Controlled   Unclassified Information', 'CONTROLLED UNCLASSIFIED'],
    ['FOUO', 'FOUO'],
    ['DISTRIBUTION STATEMENT B', 'DISTRIBUTION STATEMENT'],
    ['Distribution Statement F', 'DISTRIBUTION STATEMENT'],
    ['ITAR', 'ITAR'],
    ['EXPORT CONTROLLED', 'EXPORT CONTROLLED'],
    ['EAR99', 'EAR99'],
  ])('flags %s on page 1', (text, label) => {
    expect(labels(text, 1)).toContain(label);
    const result = checkDocumentForMarkings([{ pageNo: 1, text }]);
    expect(result.shouldBlock).toBe(true);
    expect(result.shouldReject).toBe(false);
  });

  it('does not flag Distribution Statement A (public release)', () => {
    expect(labels('DISTRIBUTION STATEMENT A: Approved for public release', 1)).toEqual([]);
  });

  it('matches whole words only', () => {
    expect(labels('The circuit and a cuisine and EAR990 and COUIN', 1)).toEqual([]);
    expect(labels('Document is (CUI).', 1)).toEqual(['CUI']);
  });

  it('records the page number', () => {
    expect(checkPageForMarkings('CUI', 2)).toEqual([{ type: 'block', marking: 'CUI', page: 2 }]);
  });

  it('ignores a marking in the body after page 3 but finds it in a header or footer', () => {
    expect(labels('Header\nThe ITAR rules apply here.\nFooter', 6)).toEqual([]);
    expect(labels('ITAR\nbody\nFooter', 6)).toEqual(['ITAR']);
    expect(labels('Header\nbody\nCUI', 6)).toEqual(['CUI']);
  });

  it('finds a marking on page 3 in the middle of the page but not on page 4', () => {
    const text = 'Header\nThe offeror shall not disclose FOUO data.\nFooter';
    expect(labels(text, 3)).toEqual(['FOUO']);
    expect(labels(text, 4)).toEqual([]);
  });

  it('reports several markings on one page', () => {
    expect(labels('CUI\nITAR\nEAR99', 1).sort()).toEqual(['CUI', 'EAR99', 'ITAR']);
  });
});

describe('classified markings', () => {
  it.each(['SECRET', 'TOP SECRET', 'CONFIDENTIAL'])('rejects %s', (text) => {
    const result = checkDocumentForMarkings([{ pageNo: 1, text }]);
    expect(result.shouldReject).toBe(true);
    expect(shouldRejectDocument(result)).toBe(true);
  });

  it('reports TOP SECRET once, not also as SECRET', () => {
    expect(labels('TOP SECRET', 1)).toEqual(['TOP SECRET']);
    expect(labels('TOP   SECRET', 1)).toEqual(['TOP SECRET']);
  });

  it('rejects and blocks when both kinds are present on different pages', () => {
    const result = checkDocumentForMarkings([
      { pageNo: 1, text: 'CUI' },
      { pageNo: 2, text: 'SECRET' },
    ]);
    expect(result.shouldBlock).toBe(true);
    expect(result.shouldReject).toBe(true);
  });

  // Suspected bug: the reject patterns are case-insensitive and run over the full text of
  // pages 1 to 3, so ordinary prose rejects the whole file. Plan 04 s2 lists only the CUI and
  // export-control markings and does not say prose should reject. Needs an owner decision.
  it.skip('does not reject a file because early body prose says "confidential"', () => {
    const result = checkDocumentForMarkings([
      { pageNo: 2, text: 'Offerors shall protect confidential business information in their proposals.' },
    ]);
    expect(result.shouldReject).toBe(false);
  });
});

describe('document result', () => {
  it('reports no markings for clean text', () => {
    const result = checkDocumentForMarkings([{ pageNo: 1, text: 'The offeror shall submit a plan.' }]);
    expect(result).toEqual({ hasMarkings: false, markings: [], shouldBlock: false, shouldReject: false });
    expect(getMarkingSummary(result)).toBe('No markings found');
  });

  it('handles an empty document', () => {
    expect(checkDocumentForMarkings([]).hasMarkings).toBe(false);
  });

  it('summarises each marking with its page', () => {
    const result = checkDocumentForMarkings([
      { pageNo: 1, text: 'CUI' },
      { pageNo: 7, text: 'Header\nbody\nFOUO' },
    ]);
    expect(getMarkingSummary(result)).toBe('CUI on page 1, FOUO on page 7');
  });
});

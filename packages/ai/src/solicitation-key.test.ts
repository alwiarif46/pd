import { describe, expect, it } from 'vitest';
import { checkSolicitationKey, extractSolicitationNumbers, matchBidKey, readValue } from './solicitation-key.ts';

const page = (text: string, pageNo = 1, ocrUsed = false) => ({ pageNo, text, ocrUsed });

describe('matchBidKey', () => {
  it('matches dash, plain, space, dot and OCR-spacing variants of the bid key', () => {
    for (const written of ['W912-24-R-0001', 'W91224R0001', 'W912 24 R 0001', 'W912.24.R.0001', 'W912 24R 0001']) {
      expect(matchBidKey([page(`Amendment 1 to ${written} for services`)], 'W912-24-R-0001')?.raw, written).toBe(written);
    }
  });

  it('never matches part of a token', () => {
    expect(matchBidKey([page('Solicitation No. W91224R00012')], 'W91224R0001')).toBeNull();
    expect(matchBidKey([page('XW91224R0001')], 'W91224R0001')).toBeNull();
  });

  it('folds O/0, I/L/1, S/5, B/8, Z/2 on OCR pages only', () => {
    const scanned = 'Solicitation No. W9I2-24-R-OOO1';
    expect(matchBidKey([page(scanned, 1, true)], 'W912-24-R-0001')?.raw).toBe('W9I2-24-R-OOO1');
    expect(matchBidKey([page(scanned, 1, false)], 'W912-24-R-0001')).toBeNull();
  });

  it('matches a body-only reference on a later page', () => {
    const pages = [page('ADDENDUM\nChanges to the scope below.'), page('Line 1\nThis addendum modifies W912-24-R-0001 section C.\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8', 2)];
    expect(matchBidKey(pages, 'W91224R0001')).toEqual({ raw: 'W912-24-R-0001', page: 2 });
  });

  it('needs a label for a weak key', () => {
    expect(matchBidKey([page('Call 24-017 for details')], '24017')).toBeNull();
    expect(matchBidKey([page('Addendum 2 to RFP 24-017')], '24017')?.raw).toBe('24-017');
    expect(matchBidKey([page('RFP No. 24-017-A2')], '24017')?.raw).toBe('24-017');
    expect(matchBidKey([page('The SERVICES are')], 'SERVICES')).toBeNull();
  });
});

describe('extractSolicitationNumbers', () => {
  it('reads the SF-30 block 9A label, including a value on the next line', () => {
    expect(extractSolicitationNumbers([page('9A. AMENDMENT OF SOLICITATION NO.\nFA8771-24-R-1000\n9B. DATED')])).toEqual([
      { raw: 'FA8771-24-R-1000', key: 'FA877124R1000', page: 1 },
    ]);
  });

  it('ranks by label, then page, then position, and keeps up to 5 distinct numbers', () => {
    const pages = [
      page('Reference No. REF-9001\nRFQ 2024-55\nSolicitation Number: ABC-123-45'),
      page('Bid No. 7777-1\nRFP 1111-22', 2),
    ];
    expect(extractSolicitationNumbers(pages).map((candidate) => candidate.raw)).toEqual([
      'ABC-123-45', '2024-55', '1111-22', 'REF-9001', '7777-1',
    ]);
  });

  it('cuts a value at dated, a comma, or a title', () => {
    expect(readValue(' 24-017 dated 1 May')).toBe('24-017');
    expect(readValue(': W912-24-R-0001, issued')).toBe('W912-24-R-0001');
    expect(readValue(' 24-017 for Janitorial Services')).toBe('24-017');
    expect(readValue(' ABC')).toBeNull();
  });
});

describe('checkSolicitationKey', () => {
  it('matches a SLED addendum that names its RFP', () => {
    expect(checkSolicitationKey([page('Addendum 2 to RFP 24-017')], '24017')).toMatchObject({ result: 'match', found: '24-017', page: 1 });
  });

  it('reports a different labelled number as a mismatch with the number found', () => {
    const result = checkSolicitationKey([page('Solicitation No. W912-24-R-0002\nRFP 55-66')], 'W912-24-R-0001');
    expect(result.result).toBe('mismatch');
    expect(result.found).toBe('W912-24-R-0002');
    expect(result.candidates.map((candidate) => candidate.key)).toEqual(['W91224R0002', '5566']);
  });

  it('matches when any of several numbers is the bid key', () => {
    const result = checkSolicitationKey([page('Solicitation No. W912-24-R-0002\nSee also W912-24-R-0001')], 'W912-24-R-0001');
    expect(result.result).toBe('match');
  });

  it('reports not found when there is no number', () => {
    expect(checkSolicitationKey([page('ADDENDUM\nThe due date is extended.')], 'W912-24-R-0001')).toEqual({
      result: 'not_found', found: null, candidates: [], page: null,
    });
  });
});

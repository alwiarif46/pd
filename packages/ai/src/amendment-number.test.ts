import { describe, expect, it } from 'vitest';
import { amendmentNumberValue, extractAmendmentNumber } from './amendment-number.ts';

const page = (text: string, pageNo = 1, ocrUsed = false) => ({ pageNo, text, ocrUsed });

const SF30_UNDER = [
  'AMENDMENT OF SOLICITATION/MODIFICATION OF CONTRACT        1. CONTRACT ID CODE      PAGE OF PAGES',
  '                                                                                    1     3',
  '2. AMENDMENT/MODIFICATION NO.     3. EFFECTIVE DATE      4. REQUISITION/PURCHASE REQ. NO.',
  '0003                              10/14/2026             W81XWH-1234-5678',
  '9A. AMENDMENT OF SOLICITATION NO.',
  'FA8771-24-R-1000',
].join('\n');

const SF30_ABOVE = [
  'AMENDMENT OF SOLICITATION/MODIFICATION OF CONTRACT',
  '   0002                             10/14/2026             0099',
  '2. AMENDMENT/MODIFICATION NO.     3. EFFECTIVE DATE      4. REQUISITION/PURCHASE REQ. NO.',
  '9A. AMENDMENT OF SOLICITATION NO.',
  'FA8771-24-R-1000',
].join('\n');

describe('extractAmendmentNumber', () => {
  it('reads SF-30 block 2 under the label, never the requisition number or block 9A', () => {
    expect(extractAmendmentNumber([page(SF30_UNDER)])).toEqual({ result: 'found', number: 3, page: 1 });
  });

  it('reads SF-30 block 2 above the label, in its column', () => {
    expect(extractAmendmentNumber([page(SF30_ABOVE)])).toEqual({ result: 'found', number: 2, page: 1 });
  });

  it('reads SF-30 block 2 on the same line', () => {
    expect(extractAmendmentNumber([page('2. AMENDMENT/MODIFICATION NO. 0004\n9A. AMENDMENT OF SOLICITATION NO. W912-24-R-0001')]))
      .toEqual({ result: 'found', number: 4, page: 1 });
  });

  it('reads a page-1 heading and labelled numbers', () => {
    expect(extractAmendmentNumber([page('Amendment 0003\nto RFP 24-017')])).toMatchObject({ result: 'found', number: 3 });
    expect(extractAmendmentNumber([page('City of Springfield\nAddendum No. 2\nRFP 24-017')])).toMatchObject({ result: 'found', number: 2 });
    expect(extractAmendmentNumber([page('ADDENDUM #2\nQuestions and answers')])).toMatchObject({ result: 'found', number: 2 });
    expect(extractAmendmentNumber([page('Solicitation Amendment Number: 12')])).toMatchObject({ result: 'found', number: 12 });
    expect(extractAmendmentNumber([page('Amendment No.\n5\nThe due date moves.')])).toMatchObject({ result: 'found', number: 5 });
  });

  it('ignores the solicitation number in block 9A and a heading with no number', () => {
    expect(extractAmendmentNumber([page('AMENDMENT OF SOLICITATION NO. 2024-0015\nThe site visit moves.')])).toEqual({ result: 'none' });
    expect(extractAmendmentNumber([page('AMENDMENT OF SOLICITATION/MODIFICATION OF CONTRACT')])).toEqual({ result: 'none' });
  });

  it('ignores a value with letters (a contract modification number)', () => {
    expect(extractAmendmentNumber([page('2. AMENDMENT/MODIFICATION NO.\nP00002')])).toEqual({ result: 'none' });
    expect(extractAmendmentNumber([page('Amendment No. 2A')])).toEqual({ result: 'none' });
  });

  it('two different numbers on page 1 are ambiguous; block 2 wins over the rest', () => {
    expect(extractAmendmentNumber([page('Addendum No. 2\nThis replaces Addendum No. 1 in full.')]))
      .toEqual({ result: 'ambiguous', numbers: [1, 2], page: 1 });
    expect(extractAmendmentNumber([page(`${SF30_UNDER}\nThis amendment also corrects Amendment No. 1.`)]))
      .toEqual({ result: 'found', number: 3, page: 1 });
  });

  it('the first page that names a number decides', () => {
    const later = 'Line 1\nLine 2\nLine 3\nbody\nbody\nbody\nbody\nAddendum No. 4 - page 3';
    expect(extractAmendmentNumber([page('Questions and answers', 1), page('more text', 2), page(later, 3)]))
      .toEqual({ result: 'found', number: 4, page: 3 });
  });

  it('folds O to 0 on OCR pages only, drops leading zeros, and allows 1 to 999 only', () => {
    expect(extractAmendmentNumber([page('Amendment No. OO3', 1, true)])).toMatchObject({ result: 'found', number: 3 });
    expect(extractAmendmentNumber([page('Amendment No. OO3', 1, false)])).toEqual({ result: 'none' });
    expect(amendmentNumberValue('0007', false)).toBe(7);
    expect(amendmentNumberValue('0000', false)).toBeNull();
    expect(amendmentNumberValue('1000', false)).toBeNull();
    expect(amendmentNumberValue('999', false)).toBe(999);
  });
});

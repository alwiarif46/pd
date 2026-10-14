import assert from 'node:assert/strict';
import test from 'node:test';
import { locateQuote, normalizeQuote, quoteCoverage } from './quote-normalizer.ts';

test('normalizeQuote joins a hyphenated line break and maps ligatures and smart quotes', () => {
  const normalized = normalizeQuote('The of\uFB01cial \u201Cshall\u201D sub-\nmit a plan.');
  assert.equal(normalized, 'the official "shall" submit a plan.');
});

test('quoteCoverage accepts a quote that is 95 percent of the page text', () => {
  const page = 'The offeror shall submit a technical proposal not exceeding 50 pages.';
  const quote = 'The offeror shall submit a technical proposal not exceeding 50 page.';
  assert.ok(quoteCoverage(quote, page) >= 0.95);
});

test('quoteCoverage rejects a quote that is not on the page', () => {
  const page = 'Questions are due on 15 December 2026.';
  const quote = 'The offeror shall submit a technical proposal not exceeding 50 pages.';
  assert.ok(quoteCoverage(quote, page) < 0.95);
});

test('locateQuote corrects the page when the quote is elsewhere', () => {
  const location = locateQuote('must provide past performance', [
    { pageNo: 5, text: 'Cover page only.' },
    { pageNo: 7, text: 'All offerors must provide past performance references.' },
  ], 5);
  assert.equal(location.found, true);
  assert.equal(location.page, 7);
  assert.equal(location.pageCorrected, true);
});

test('locateQuote reports a miss so the caller can drop the row', () => {
  const location = locateQuote('this sentence is not in the file', [
    { pageNo: 1, text: 'The agency will evaluate technical approach.' },
  ], 1);
  assert.equal(location.found, false);
});

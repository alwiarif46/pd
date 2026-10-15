import assert from 'node:assert/strict';
import { test } from 'vitest';
import { checkDocumentForMarkings } from './marking-checker.ts';

test('CUI on an early page blocks AI until the user confirms', () => {
  const result = checkDocumentForMarkings([
    { pageNo: 1, text: 'CUI\nThe offeror shall submit a plan.' },
  ]);
  assert.equal(result.shouldBlock, true);
  assert.equal(result.shouldReject, false);
});

test('FOUO in a later page footer blocks, and FOUO in the body does not', () => {
  const blocked = checkDocumentForMarkings([
    { pageNo: 8, text: 'Body text about the work.\nFOUO' },
  ]);
  assert.equal(blocked.shouldBlock, true);

  const ignored = checkDocumentForMarkings([
    { pageNo: 8, text: 'Header\nThis paragraph mentions FOUO in the body.\nFooter' },
  ]);
  assert.equal(ignored.shouldBlock, false);
});

test('SECRET rejects the file', () => {
  const result = checkDocumentForMarkings([
    { pageNo: 1, text: 'SECRET\nHandle accordingly.' },
  ]);
  assert.equal(result.shouldReject, true);
});

test('DISTRIBUTION STATEMENT C and EAR99 block', () => {
  const result = checkDocumentForMarkings([
    { pageNo: 2, text: 'DISTRIBUTION STATEMENT C\nEAR99' },
  ]);
  assert.equal(result.shouldBlock, true);
  assert.deepEqual(
    result.markings.map((marking) => marking.marking).sort(),
    ['DISTRIBUTION STATEMENT', 'EAR99'],
  );
});

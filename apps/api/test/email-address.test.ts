import { describe, expect, it } from 'vitest';
import { normalizeAddress } from '../src/email-address.js';

describe('normalizeAddress (one bare email address)', () => {
  it('trims and lowercases a bare address', () => {
    expect(normalizeAddress('  Pat.O\'Neil+qa@Sub.Acme-Test.COM ')).toBe('pat.o\'neil+qa@sub.acme-test.com');
  });

  it.each([
    'Work Co <me@gmail.com>',
    'ceo@victim.com <me@evil.com>',
    '<me@acme-test.com>',
    'a@acme-test.com,c@acme-test.com',
    'a@acme-test.com, c@acme-test.com',
    'a@acme-test.com;c@acme-test.com',
    '"a"@acme-test.com',
    'a b@acme-test.com',
    'a@acme-test.com\r\nBcc: x@acme-test.com',
    'a@@acme-test.com',
    '@acme-test.com',
    'a@acme-test',
    'a@acme-test..com',
    '.a@acme-test.com',
    'a.@acme-test.com',
    '*@acme-test.com',
    '%@acme-test.com',
    // U+212A KELVIN SIGN lowercases to an ASCII "k"; refused instead of folded.
    'Kim@acme-test.com',
    'pat@acme-tеst.com',
    '',
    `${'a'.repeat(250)}@acme-test.com`,
  ])('refuses %j', (value) => {
    expect(normalizeAddress(value)).toBeNull();
  });

  it('refuses a value that is not a string', () => {
    expect(normalizeAddress(undefined)).toBeNull();
    expect(normalizeAddress(['a@acme-test.com'])).toBeNull();
  });
});

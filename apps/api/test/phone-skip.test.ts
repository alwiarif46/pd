import { afterEach, describe, expect, it, vi } from 'vitest';
import { phoneSkipListFromEnv, warnPhoneSkip } from '../src/phone-skip.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PD_SKIP_PHONE_VERIFY_EMAILS', () => {
  it('is off when unset or empty', () => {
    expect(phoneSkipListFromEnv(undefined).size).toBe(0);
    expect(phoneSkipListFromEnv('').size).toBe(0);
    expect(phoneSkipListFromEnv(' , ').size).toBe(0);
  });

  it('lowercases and trims exact addresses', () => {
    const list = phoneSkipListFromEnv(' Pat@Acme-Test.com ,sam.o\'neil+qa@sub.acme-test.co.uk,, ');
    expect([...list]).toEqual(['pat@acme-test.com', 'sam.o\'neil+qa@sub.acme-test.co.uk']);
  });

  it.each([
    '*@acme-test.com',
    '*',
    '@acme-test.com',
    'acme-test.com',
    'pat@*.acme-test.com',
    'pat@acme-test',
    'pat@@acme-test.com',
    'pat@acme@test.com',
    'pat smith@acme-test.com',
    'pat@acme-test.com;sam@acme-test.com',
    '<pat@acme-test.com>',
    'pat@.acme-test.com',
    'pat@acme-test..com',
    '%@acme-test.com',
  ])('refuses %s, without echoing it', (entry) => {
    const run = () => phoneSkipListFromEnv(`ok@acme-test.com,${entry}`);
    expect(run).toThrow(/PD_SKIP_PHONE_VERIFY_EMAILS/);
    try {
      run();
    } catch (error) {
      expect((error as Error).message).not.toContain(entry);
      expect((error as Error).message).not.toContain('ok@acme-test.com');
    }
  });

  it('warns once with the count and never the addresses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnPhoneSkip(phoneSkipListFromEnv('a@acme-test.com,b@acme-test.com'));
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('2');
    expect(line).not.toContain('acme-test.com');
  });

  it('says nothing when the list is empty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnPhoneSkip(phoneSkipListFromEnv(''));
    expect(warn).not.toHaveBeenCalled();
  });
});

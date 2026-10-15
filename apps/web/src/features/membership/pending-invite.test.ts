// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingInvite,
  hasPendingInvite,
  isInviteCode,
  loadPendingInvite,
  normalizeInviteCode,
  PENDING_INVITE_KEY,
  PENDING_INVITE_MAX_AGE_MS,
  savePendingInvite,
  takeInviteRedirect,
} from './pending-invite';

const CODE = `${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}.${'b'.repeat(64)}`;

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isInviteCode', () => {
  it('accepts <org id>.<64 hex> and nothing else', () => {
    expect(isInviteCode(CODE)).toBe(true);
    expect(isInviteCode('abc')).toBe(false);
    expect(isInviteCode(`${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}.short`)).toBe(false);
    expect(isInviteCode(undefined)).toBe(false);
    expect(isInviteCode(null)).toBe(false);
  });
});

describe('pending invite storage', () => {
  it('round-trips and clears', () => {
    expect(hasPendingInvite()).toBe(false);
    savePendingInvite(CODE);
    expect(loadPendingInvite()).toBe(CODE);
    expect(hasPendingInvite()).toBe(true);
    clearPendingInvite();
    expect(loadPendingInvite()).toBeNull();
  });

  it('ignores a code older than 7 days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    savePendingInvite(CODE);
    vi.setSystemTime(Date.now() + PENDING_INVITE_MAX_AGE_MS - 1000);
    expect(loadPendingInvite()).toBe(CODE);
    vi.setSystemTime(Date.now() + 2000);
    expect(loadPendingInvite()).toBeNull();
  });

  it.each(['not json', '{}', '{"code":"x","savedAt":1}', `{"code":"${CODE}"}`, 'null', '[]'])(
    'treats junk %s as empty',
    (raw) => {
      localStorage.setItem(PENDING_INVITE_KEY, raw);
      expect(loadPendingInvite()).toBeNull();
    },
  );

  it('does not throw when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => savePendingInvite(CODE)).not.toThrow();
    expect(loadPendingInvite()).toBeNull();
    expect(() => clearPendingInvite()).not.toThrow();
  });
});

describe('normalizeInviteCode', () => {
  it('trims and lowercases, so an uppercase org id from a pasted link works', () => {
    expect(normalizeInviteCode(`  ${CODE.toUpperCase()}\n`)).toBe(CODE);
    expect(normalizeInviteCode('nonsense')).toBeNull();
    expect(normalizeInviteCode(undefined)).toBeNull();
  });

  it('saves and loads the normalized code', () => {
    savePendingInvite(CODE.toUpperCase());
    expect(loadPendingInvite()).toBe(CODE);
  });
});

describe('takeInviteRedirect', () => {
  afterEach(() => sessionStorage.clear());

  it('is true once per browser session while a code is pending', () => {
    expect(takeInviteRedirect()).toBe(false);
    savePendingInvite(CODE);
    expect(takeInviteRedirect()).toBe(true);
    expect(takeInviteRedirect()).toBe(false);
    sessionStorage.clear();
    expect(takeInviteRedirect()).toBe(true);
  });

  it('is false when session storage is blocked, so it can never loop', () => {
    savePendingInvite(CODE);
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(takeInviteRedirect()).toBe(false);
    vi.restoreAllMocks();
  });
});

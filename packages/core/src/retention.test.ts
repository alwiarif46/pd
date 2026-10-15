import { describe, expect, it } from 'vitest';
import { KEY_OVERRIDES_PER_BID, keyOverridesLeft, keyOverridesPerBid } from './credits';
import {
  bidDefaultLiveUntil,
  bidFilesLiveUntil,
  canRestore,
  documentLiveUntil,
  parseBooleanSetting,
  parseIntSetting,
  restoredUntil,
  restoreSettings,
} from './retention';
import { isBidStatus } from './index';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

describe('documentLiveUntil (03 s39)', () => {
  const base = { uploadedAt: d('2026-01-01'), dueDate: d('2026-06-01'), retentionExtendedUntil: null };

  it('free: upload plus 90 days, whatever the due date', () => {
    expect(iso(documentLiveUntil({ ...base, plan: 'free', kind: 'solicitation' }))).toBe('2026-04-01');
  });

  it('free ignores an extension left over from a paid plan', () => {
    expect(iso(documentLiveUntil({ ...base, plan: 'free', kind: 'solicitation', retentionExtendedUntil: d('2027-01-01') }))).toBe('2026-04-01');
  });

  it('paid: the later of upload plus 90 and due plus 90', () => {
    expect(iso(documentLiveUntil({ ...base, plan: 'starter', kind: 'attachment' }))).toBe('2026-08-30');
    expect(iso(documentLiveUntil({ ...base, plan: 'growth', kind: 'attachment', dueDate: d('2025-12-01') }))).toBe('2026-04-01');
  });

  it('paid without a due date: upload plus 90', () => {
    expect(iso(documentLiveUntil({ ...base, plan: 'starter', kind: 'solicitation', dueDate: null }))).toBe('2026-04-01');
  });

  it('paid: a later extension wins, an earlier one does not shorten', () => {
    expect(iso(documentLiveUntil({ ...base, plan: 'starter', kind: 'draft', retentionExtendedUntil: d('2027-01-01') }))).toBe('2027-01-01');
    expect(iso(documentLiveUntil({ ...base, plan: 'starter', kind: 'draft', retentionExtendedUntil: d('2026-02-01') }))).toBe('2026-08-30');
  });

  it('resumes: upload plus 90 on every plan, extension or not', () => {
    for (const plan of ['free', 'starter', 'growth'] as const) {
      expect(iso(documentLiveUntil({ ...base, plan, kind: 'resume', retentionExtendedUntil: d('2027-01-01') }))).toBe('2026-04-01');
    }
  });
});

describe('bid live-until dates', () => {
  it('free: latest upload plus 90; null with no upload', () => {
    expect(iso(bidDefaultLiveUntil({ plan: 'free', latestUploadAt: d('2026-03-01'), latestNonResumeUploadAt: d('2026-01-01'), dueDate: d('2026-12-01') }))).toBe('2026-05-30');
    expect(bidDefaultLiveUntil({ plan: 'free', latestUploadAt: null, latestNonResumeUploadAt: null, dueDate: d('2026-12-01') })).toBeNull();
  });

  it('paid: the later of latest non-resume upload plus 90 and due plus 90', () => {
    const input = { plan: 'starter' as const, latestUploadAt: d('2026-03-01'), latestNonResumeUploadAt: d('2026-01-01') };
    expect(iso(bidDefaultLiveUntil({ ...input, dueDate: d('2026-06-01') }))).toBe('2026-08-30');
    expect(iso(bidDefaultLiveUntil({ ...input, dueDate: null }))).toBe('2026-04-01');
    expect(iso(bidDefaultLiveUntil({ ...input, latestNonResumeUploadAt: null, dueDate: d('2026-06-01') }))).toBe('2026-08-30');
    expect(bidDefaultLiveUntil({ ...input, latestNonResumeUploadAt: null, dueDate: null })).toBeNull();
  });

  it('files live until: the later of the default and the extension, on paid plans', () => {
    const input = { plan: 'growth' as const, latestUploadAt: d('2026-01-01'), latestNonResumeUploadAt: d('2026-01-01'), dueDate: null };
    expect(iso(bidFilesLiveUntil({ ...input, retentionExtendedUntil: d('2026-12-31') }))).toBe('2026-12-31');
    expect(iso(bidFilesLiveUntil({ ...input, retentionExtendedUntil: d('2026-02-01') }))).toBe('2026-04-01');
    expect(iso(bidFilesLiveUntil({ ...input, retentionExtendedUntil: null }))).toBe('2026-04-01');
    expect(iso(bidFilesLiveUntil({ ...input, latestUploadAt: null, latestNonResumeUploadAt: null, retentionExtendedUntil: d('2026-12-31') }))).toBe('2026-12-31');
    expect(iso(bidFilesLiveUntil({ ...input, plan: 'free', retentionExtendedUntil: d('2026-12-31') }))).toBe('2026-04-01');
  });
});

describe('settings', () => {
  it('parses booleans and whole numbers, falling back on anything else', () => {
    expect(parseBooleanSetting('false', true)).toBe(false);
    expect(parseBooleanSetting(' TRUE ', false)).toBe(true);
    expect(parseBooleanSetting('maybe', true)).toBe(true);
    expect(parseBooleanSetting(undefined, false)).toBe(false);
    expect(parseIntSetting('3', 2)).toBe(3);
    expect(parseIntSetting('0', 2)).toBe(0);
    expect(parseIntSetting('0', 7, 1)).toBe(7);
    expect(parseIntSetting('-1', 2)).toBe(2);
    expect(parseIntSetting('2.5', 2)).toBe(2);
    expect(parseIntSetting(null, 2)).toBe(2);
  });

  it('restore settings default to free restores allowed and a 7-day window', () => {
    expect(restoreSettings({})).toEqual({ freeAllowed: true, windowDays: 7 });
    const strict = restoreSettings({ restore_free_allowed: 'false', restore_window_days: '14' });
    expect(strict).toEqual({ freeAllowed: false, windowDays: 14 });
    expect(canRestore('free', strict)).toBe(false);
    expect(canRestore('starter', strict)).toBe(true);
    expect(iso(restoredUntil(d('2026-01-01'), strict))).toBe('2026-01-15');
    expect(iso(restoredUntil(d('2026-01-01'), restoreSettings({})))).toBe('2026-01-08');
  });

  it('key overrides per bid default to the constant and never go below zero left', () => {
    expect(keyOverridesPerBid(undefined)).toBe(KEY_OVERRIDES_PER_BID);
    expect(keyOverridesPerBid('5')).toBe(5);
    expect(keyOverridesPerBid('x')).toBe(KEY_OVERRIDES_PER_BID);
    expect(keyOverridesLeft(2, 3)).toBe(0);
    expect(keyOverridesLeft(3, 1)).toBe(2);
  });

  it('bid statuses', () => {
    expect(isBidStatus('planning')).toBe(true);
    expect(isBidStatus('draft')).toBe(false);
    expect(isBidStatus(1)).toBe(false);
  });
});

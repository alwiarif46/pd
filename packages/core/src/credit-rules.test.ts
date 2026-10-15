import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  consumeCredit,
  fitsBidCap,
  freeAllowance,
  mbCapForPlan,
  normalizeSolicitationKey,
  releaseCredit,
  reserveCredit,
  type CreditState,
} from './credits';
import { PLAN_LIMITS } from './limits';

const MB = 1024 * 1024;
const open: CreditState = { allowed: 2, used: 0, reserved: 0 };

function first(overrides: Partial<Parameters<typeof reserveCredit>[1]> = {}): Parameters<typeof reserveCredit>[1] {
  return {
    kind: 'solicitation',
    sameSha256: false,
    isFirstSolicitation: true,
    bidKey: null,
    fileKey: null,
    ...overrides,
  };
}

describe('plan rules', () => {
  it('matches the plan limits in plan 06', () => {
    expect(PLAN_LIMITS.free).toMatchObject({ rfpCreditsFirstMonth: 2, rfpCreditsSubsequent: 1, maxUsers: 2, mbPerBid: 50 });
    expect(PLAN_LIMITS.starter).toMatchObject({ rfpCreditsPerMonth: 10, maxUsers: 5, mbPerBid: 300 });
    expect(PLAN_LIMITS.growth).toMatchObject({ rfpCreditsPerMonth: 20, maxUsers: 5, mbPerBid: 300 });
  });

  it('gives paid plans a larger per-bid cap than free', () => {
    expect(mbCapForPlan('free')).toBe(50);
    expect(mbCapForPlan('starter')).toBe(300);
    expect(mbCapForPlan('growth')).toBe(300);
  });
});

describe('free periods', () => {
  it('allows 2 in the first period and 1 afterwards', () => {
    expect(freeAllowance({ isFirstPeriod: true, returningToFree: false })).toBe(2);
    expect(freeAllowance({ isFirstPeriod: false, returningToFree: false })).toBe(1);
  });

  it('starts a new period with 1 on return to free, even if it looks like a first period', () => {
    expect(freeAllowance({ isFirstPeriod: true, returningToFree: true })).toBe(1);
    expect(freeAllowance({ isFirstPeriod: false, returningToFree: true })).toBe(1);
  });
});

describe('addMonthsClamped (day-of-month clamp)', () => {
  const iso = (date: Date) => date.toISOString();

  it('clamps the 29th, 30th and 31st to the end of a short month', () => {
    expect(iso(addMonthsClamped(new Date(Date.UTC(2026, 0, 31)), 1))).toBe('2026-02-28T00:00:00.000Z');
    expect(iso(addMonthsClamped(new Date(Date.UTC(2026, 0, 30)), 1))).toBe('2026-02-28T00:00:00.000Z');
    expect(iso(addMonthsClamped(new Date(Date.UTC(2026, 0, 29)), 1))).toBe('2026-02-28T00:00:00.000Z');
    expect(iso(addMonthsClamped(new Date(Date.UTC(2026, 7, 31)), 1))).toBe('2026-09-30T00:00:00.000Z');
  });

  it('uses 29 February in a leap year', () => {
    expect(iso(addMonthsClamped(new Date(Date.UTC(2028, 0, 31)), 1))).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(addMonthsClamped(new Date(Date.UTC(2028, 0, 29)), 1))).toBe('2028-02-29T00:00:00.000Z');
  });

  it('restores the anchor day when it is applied to the anchor, not to the clamped date', () => {
    const anchor = new Date(Date.UTC(2026, 0, 31));
    expect(iso(addMonthsClamped(anchor, 2))).toBe('2026-03-31T00:00:00.000Z');
    // Chaining from the clamped date drifts to the 28th: callers must keep the anchor.
    const chained = addMonthsClamped(addMonthsClamped(anchor, 1), 1);
    expect(iso(chained)).toBe('2026-03-28T00:00:00.000Z');
  });

  it('rolls over the year and handles 12 and negative months', () => {
    expect(iso(addMonthsClamped(new Date(Date.UTC(2026, 11, 15)), 1))).toBe('2027-01-15T00:00:00.000Z');
    expect(iso(addMonthsClamped(new Date(Date.UTC(2026, 5, 10)), 12))).toBe('2027-06-10T00:00:00.000Z');
    expect(iso(addMonthsClamped(new Date(Date.UTC(2026, 2, 31)), -1))).toBe('2026-02-28T00:00:00.000Z');
    expect(iso(addMonthsClamped(new Date(Date.UTC(2026, 0, 15)), -1))).toBe('2025-12-15T00:00:00.000Z');
  });

  it('keeps the time of day and does not mutate its input', () => {
    const anchor = new Date(Date.UTC(2026, 0, 31, 13, 45, 12));
    const next = addMonthsClamped(anchor, 1);
    expect(iso(next)).toBe('2026-02-28T13:45:12.000Z');
    expect(iso(anchor)).toBe('2026-01-31T13:45:12.000Z');
  });
});

describe('MB cap per bid', () => {
  it('allows a file that lands exactly on the cap and refuses one byte over', () => {
    expect(fitsBidCap('free', 30 * MB, 20 * MB)).toBe(true);
    expect(fitsBidCap('free', 30 * MB, 20 * MB + 1)).toBe(false);
  });

  it('counts bytes already used on the bid', () => {
    expect(fitsBidCap('free', 50 * MB, 1)).toBe(false);
    expect(fitsBidCap('free', 0, 50 * MB)).toBe(true);
    expect(fitsBidCap('starter', 299 * MB, MB)).toBe(true);
    expect(fitsBidCap('starter', 299 * MB, MB + 1)).toBe(false);
  });

  // Was a suspected bug: fixed in fitsBidCap, which refuses sizes that are not positive whole
  // numbers, and in the upload route, which refuses them with 400 invalid_upload.
  it('refuses a negative or fractional incoming size', () => {
    expect(fitsBidCap('free', 50 * MB, -1)).toBe(false);
    expect(fitsBidCap('free', 0, 0.5)).toBe(false);
  });
});

describe('solicitation key', () => {
  it('upper-cases and strips everything but letters and digits', () => {
    expect(normalizeSolicitationKey('abc-26-001')).toBe('ABC26001');
    expect(normalizeSolicitationKey(' W911NF-26-R-0001 ')).toBe('W911NF26R0001');
    expect(normalizeSolicitationKey('RFP No. 2026/17')).toBe('RFPNO202617');
  });

  it('is idempotent', () => {
    const once = normalizeSolicitationKey('Ab-12.c');
    expect(normalizeSolicitationKey(once)).toBe(once);
  });

  it('accepts a file whose key differs only in punctuation and case', () => {
    const result = reserveCredit(open, first({ bidKey: 'abc-26-001', fileKey: 'ABC 26 001' }));
    expect(result.ok).toBe(true);
  });

  it('refuses a second solicitation key on the same bid, without spending a credit', () => {
    const result = reserveCredit(open, first({ isFirstSolicitation: false, bidKey: 'AAA-1', fileKey: 'BBB-2' }));
    expect(result).toEqual({ ok: false, reason: 'key_mismatch' });
  });

  it('does not compare keys when either side is unknown', () => {
    expect(reserveCredit(open, first({ bidKey: null, fileKey: 'X1' })).ok).toBe(true);
    expect(reserveCredit(open, first({ bidKey: 'X1', fileKey: null })).ok).toBe(true);
  });

  it('does not compare keys for attachments or amendments', () => {
    expect(reserveCredit(open, first({ kind: 'attachment', bidKey: 'A', fileKey: 'B' })).ok).toBe(true);
    expect(reserveCredit(open, first({ kind: 'amendment', bidKey: 'A', fileKey: 'B' })).ok).toBe(true);
  });
});

describe('credit reservation', () => {
  it('reserves one credit for the first solicitation and leaves the input untouched', () => {
    const result = reserveCredit(open, first());
    expect(result).toEqual({ ok: true, reserved: true, state: { allowed: 2, used: 0, reserved: 1 } });
    expect(open).toEqual({ allowed: 2, used: 0, reserved: 0 });
  });

  it('does not reserve for a re-upload with the same sha256', () => {
    const result = reserveCredit(open, first({ sameSha256: true }));
    expect(result).toEqual({ ok: true, reserved: false, state: open });
  });

  it('does not reserve for a second solicitation file on a bid that already holds a credit', () => {
    const result = reserveCredit(open, first({ isFirstSolicitation: false }));
    expect(result).toEqual({ ok: true, reserved: false, state: open });
  });

  it.each(['amendment', 'attachment', 'resume', 'draft'] as const)('does not reserve for a %s', (kind) => {
    const result = reserveCredit({ allowed: 0, used: 0, reserved: 0 }, first({ kind }));
    expect(result).toEqual({ ok: true, reserved: false, state: { allowed: 0, used: 0, reserved: 0 } });
  });

  it('counts used plus reserved against the allowance', () => {
    expect(reserveCredit({ allowed: 2, used: 1, reserved: 0 }, first()).ok).toBe(true);
    expect(reserveCredit({ allowed: 2, used: 1, reserved: 1 }, first())).toEqual({ ok: false, reason: 'out_of_credits' });
    expect(reserveCredit({ allowed: 2, used: 0, reserved: 2 }, first())).toEqual({ ok: false, reason: 'out_of_credits' });
    expect(reserveCredit({ allowed: 2, used: 2, reserved: 0 }, first())).toEqual({ ok: false, reason: 'out_of_credits' });
    expect(reserveCredit({ allowed: 0, used: 0, reserved: 0 }, first())).toEqual({ ok: false, reason: 'out_of_credits' });
  });

  it('lets a same-sha256 re-upload through even when out of credits', () => {
    const empty = { allowed: 1, used: 1, reserved: 0 };
    expect(reserveCredit(empty, first({ sameSha256: true })).ok).toBe(true);
  });

  it('consumes a reservation: reserved down, used up, total unchanged', () => {
    const state = { allowed: 2, used: 0, reserved: 1 };
    const next = consumeCredit(state);
    expect(next).toEqual({ allowed: 2, used: 1, reserved: 0 });
    expect(next.used + next.reserved).toBe(state.used + state.reserved);
    expect(state).toEqual({ allowed: 2, used: 0, reserved: 1 });
  });

  it('releases a reservation: reserved down, used unchanged, credit available again', () => {
    const released = releaseCredit({ allowed: 1, used: 0, reserved: 1 });
    expect(released).toEqual({ allowed: 1, used: 0, reserved: 0 });
    expect(reserveCredit(released, first()).ok).toBe(true);
  });

  it('throws when there is nothing reserved to consume or release', () => {
    expect(() => consumeCredit(open)).toThrow('No reserved credit to consume');
    expect(() => releaseCredit(open)).toThrow('No reserved credit to release');
  });

  it('runs reserve, consume, then refuses the next solicitation at the limit', () => {
    let state: CreditState = { allowed: 1, used: 0, reserved: 0 };
    const reserved = reserveCredit(state, first());
    if (!reserved.ok) throw new Error('expected a reservation');
    state = consumeCredit(reserved.state);
    expect(reserveCredit(state, first())).toEqual({ ok: false, reason: 'out_of_credits' });
  });
});

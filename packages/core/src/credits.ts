import { PLAN_LIMITS, type Plan } from './limits';
import { parseIntSetting } from './retention';

export interface CreditState {
  allowed: number;
  used: number;
  reserved: number;
}

export type FileKind = 'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft';

export type ReserveResult =
  | { ok: true; state: CreditState; reserved: boolean }
  | { ok: false; reason: 'out_of_credits' | 'key_mismatch' };

export function freeAllowance(input: { isFirstPeriod: boolean; returningToFree: boolean }): number {
  if (input.returningToFree || !input.isFirstPeriod) {
    return PLAN_LIMITS.free.rfpCreditsSubsequent;
  }
  return PLAN_LIMITS.free.rfpCreditsFirstMonth;
}

/** Move an anchor date by whole months, clamping to the last day of the target month. */
export function addMonthsClamped(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const day = anchor.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()));
}

export function normalizeSolicitationKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function mbCapForPlan(plan: Plan): number {
  return PLAN_LIMITS[plan].mbPerBid;
}

/** A file size the api accepts: a whole number of bytes, at least 1. */
export function isValidFileSize(bytes: unknown): bytes is number {
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0;
}

/** False for a size that is not a positive whole number, so a bogus size never "fits". */
export function fitsBidCap(plan: Plan, usedBytes: number, incomingBytes: number): boolean {
  if (!isValidFileSize(incomingBytes) || !Number.isSafeInteger(usedBytes) || usedBytes < 0) {
    return false;
  }
  const capBytes = mbCapForPlan(plan) * 1024 * 1024;
  return usedBytes + incomingBytes <= capBytes;
}

export function reserveCredit(
  state: CreditState,
  input: {
    kind: FileKind;
    sameSha256: boolean;
    isFirstSolicitation: boolean;
    bidKey: string | null;
    fileKey: string | null;
  },
): ReserveResult {
  if (input.kind === 'solicitation' && !input.sameSha256 && input.bidKey && input.fileKey) {
    const bidKey = normalizeSolicitationKey(input.bidKey);
    const fileKey = normalizeSolicitationKey(input.fileKey);
    if (bidKey !== fileKey) {
      return { ok: false, reason: 'key_mismatch' };
    }
  }
  if (input.sameSha256 || input.kind !== 'solicitation' || !input.isFirstSolicitation) {
    return { ok: true, state, reserved: false };
  }

  if (state.used + state.reserved >= state.allowed) {
    return { ok: false, reason: 'out_of_credits' };
  }
  return {
    ok: true,
    reserved: true,
    state: { ...state, reserved: state.reserved + 1 },
  };
}

export function consumeCredit(state: CreditState): CreditState {
  if (state.reserved < 1) {
    throw new Error('No reserved credit to consume');
  }
  return { ...state, reserved: state.reserved - 1, used: state.used + 1 };
}

export function releaseCredit(state: CreditState): CreditState {
  if (state.reserved < 1) {
    throw new Error('No reserved credit to release');
  }
  return { ...state, reserved: state.reserved - 1 };
}

/**
 * Amendment key overrides allowed per bid when app_settings has no `key_overrides_per_bid`
 * (06 s4; the number is still open, proposed 2). Read the limit with `keyOverridesPerBid`.
 */
export const KEY_OVERRIDES_PER_BID = 2;

export const SETTING_KEY_OVERRIDES_PER_BID = 'key_overrides_per_bid';

/** The per-bid override limit from the app_settings value; missing or malformed gives the default. */
export function keyOverridesPerBid(value: string | null | undefined): number {
  return parseIntSetting(value, KEY_OVERRIDES_PER_BID, 0);
}

/** Overrides a bid has left: never negative, even after the limit is lowered. */
export function keyOverridesLeft(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

/**
 * RFP credits for one period of `plan`. Free: 2 in the first period after signup, then 1, and 1
 * on a return to free (06 s3). Paid plans: the plan's monthly allowance.
 */
export function periodAllowance(plan: Plan, input: { isFirstPeriod: boolean; returningToFree: boolean }): number {
  if (plan === 'free') {
    return freeAllowance(input);
  }
  return PLAN_LIMITS[plan].rfpCreditsPerMonth;
}

/**
 * The monthly period, counted from `anchor`, that contains `now`. Every period start is
 * `addMonthsClamped(anchor, index)`, so a 31st anchor gives the last day of short months and
 * returns to the 31st afterwards. An anchor after `now` is treated as `now`.
 */
export function periodContaining(anchor: Date, now: Date): { start: Date; end: Date; index: number } {
  const base = anchor.getTime() > now.getTime() ? now : anchor;
  let index = Math.max(
    0,
    (now.getUTCFullYear() - base.getUTCFullYear()) * 12 + (now.getUTCMonth() - base.getUTCMonth()),
  );
  while (index > 0 && addMonthsClamped(base, index).getTime() > now.getTime()) {
    index -= 1;
  }
  while (addMonthsClamped(base, index + 1).getTime() <= now.getTime()) {
    index += 1;
  }
  return { start: addMonthsClamped(base, index), end: addMonthsClamped(base, index + 1), index };
}

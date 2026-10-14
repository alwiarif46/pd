import { PLAN_LIMITS, type Plan } from './limits';

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

export function fitsBidCap(plan: Plan, usedBytes: number, incomingBytes: number): boolean {
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

// Credits, plan and cap from GET /api/org (09 s5.1, s5.2), shared by the shell and the bids screens.
import type { OrganizationDto, OrgPayloadDto } from '@/api';
import type { Plan } from '@/types';

export interface OrgSummary {
  creditsLeft: number;
  creditsResetOn: string;
  plan: Plan;
  mbCap: number;
}

/** 06 s3. Used only when the payload has no credits (see `summarizeOrg`). */
const MONTHLY_ALLOWANCE: Record<Plan, number> = { free: 1, starter: 10, growth: 20 };
const FREE_FIRST_MONTH_ALLOWANCE = 2;

function addMonthsClamped(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
    ),
  );
}

/** End of the monthly period, counted from `anchor`, that holds `now` (same rule as the API's credit periods). */
export function periodEndFrom(anchor: Date, now: Date): Date {
  const base = anchor.getTime() > now.getTime() ? now : anchor;
  let index = Math.max(
    0,
    (now.getUTCFullYear() - base.getUTCFullYear()) * 12 + (now.getUTCMonth() - base.getUTCMonth()),
  );
  while (index > 0 && addMonthsClamped(base, index).getTime() > now.getTime()) index -= 1;
  while (addMonthsClamped(base, index + 1).getTime() <= now.getTime()) index += 1;
  return addMonthsClamped(base, index + 1);
}

function estimateCredits(org: OrganizationDto, now: Date): { left: number; resetOn: string } {
  const plan = org.plan;
  const firstMonth = plan === 'free' && org.freeFirstMonthEnds !== null && now < new Date(org.freeFirstMonthEnds);
  const left = firstMonth ? FREE_FIRST_MONTH_ALLOWANCE : MONTHLY_ALLOWANCE[plan];
  const cycleStart = org.cycleStart ? new Date(org.cycleStart) : null;
  const cycleEnd = org.cycleEnd ? new Date(org.cycleEnd) : null;
  if (plan !== 'free' && cycleStart && cycleEnd && cycleStart <= now && now < cycleEnd) {
    return { left, resetOn: cycleEnd.toISOString() };
  }
  return { left, resetOn: periodEndFrom(new Date(org.cycleStart ?? org.createdAt), now).toISOString() };
}

/**
 * Credits left = max(0, allowed - used - reserved); the reset date is the period's end. The API sends the
 * current period even before its row exists (projected, `id: null`). The estimate below is a fallback
 * only, for a payload with `credits: null` (an older API); it is not "out of credits", and the API
 * decides at upload.
 */
export function summarizeOrg(payload: OrgPayloadDto, now: Date): OrgSummary {
  const org = payload.org;
  const plan: Plan = org?.plan ?? 'free';
  if (payload.credits) {
    const { allowed, used, reserved, periodEnd } = payload.credits;
    return { creditsLeft: Math.max(0, allowed - used - reserved), creditsResetOn: periodEnd, plan, mbCap: payload.mbCap };
  }
  if (!org) return { creditsLeft: 0, creditsResetOn: '', plan, mbCap: payload.mbCap };
  const estimate = estimateCredits(org, now);
  return { creditsLeft: estimate.left, creditsResetOn: estimate.resetOn, plan, mbCap: payload.mbCap };
}

import * as api from '@/api';
import { ApiError } from '@/api';
import type { AmendmentLinkDto, BidDto, DocumentDto, JobDto, MeDto, OrgPayloadDto, PaidPlan } from '@/api';
import type { ShellBid } from '@/types';
import { messageOf } from '@/features/shared/messages';
import { isActive, isProcessing } from '@/features/tab-frame/derive';

/** The slice of the typed API client the shell uses. Tests pass a mock. */
export interface ShellApi {
  getMe: typeof api.getMe;
  getOrg: typeof api.getOrg;
  listBids: typeof api.listBids;
  getBid: typeof api.getBid;
  listDocuments: typeof api.listDocuments;
  listJobs: typeof api.listJobs;
  listAmendmentLinks: typeof api.listAmendmentLinks;
  startCheckout: typeof api.startCheckout;
  openBillingPortal: typeof api.openBillingPortal;
  logOut: typeof api.logOut;
}

export const shellApi: ShellApi = api;

/** Poll interval while anything on the bid is queued or running. No polling when idle. */
export const POLL_MS = 3000;

/* ---- Loading ---- */

export type ShellData =
  | { kind: 'ready'; me: MeDto; org: OrgPayloadDto; bids: BidDto[] }
  /** Signed in, no organization yet: GET /api/org answers 403. */
  | { kind: 'no_org'; me: MeDto | null };

function isNoOrg(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** The user, the organization (plan, credits, role, cap) and the bid list. */
export async function loadShell(deps: ShellApi, signal?: AbortSignal): Promise<ShellData> {
  const me = deps.getMe({ signal });
  try {
    const [org, bids] = await Promise.all([deps.getOrg({ signal }), deps.listBids({ signal })]);
    return { kind: 'ready', me: await me, org, bids };
  } catch (error) {
    if (isNoOrg(error)) return { kind: 'no_org', me: await me.catch(() => null) };
    me.catch(() => undefined);
    throw error;
  }
}

export interface BidData {
  bid: BidDto;
  docs: DocumentDto[];
  jobs: JobDto[];
  links: AmendmentLinkDto[];
}

export async function loadBid(deps: ShellApi, bidId: string, signal?: AbortSignal): Promise<BidData> {
  const [bid, docs, jobs, links] = await Promise.all([
    deps.getBid(bidId, { signal }),
    deps.listDocuments(bidId, { signal }),
    deps.listJobs(bidId, { signal }),
    deps.listAmendmentLinks(bidId, { signal }),
  ]);
  return { bid, docs, jobs, links };
}

/** Poll while a job is queued or running or a file is still being scanned or read. */
export function needsPolling(data: Pick<BidData, 'docs' | 'jobs'> | null): boolean {
  if (!data) return false;
  return data.jobs.some(isActive) || data.docs.some(isProcessing);
}

/** A key that changes when a job starts, finishes or fails (not on progress), for legacy tabs to reload on. */
export function jobsKey(data: Pick<BidData, 'jobs'> | null): string {
  if (!data) return '';
  return data.jobs
    .map((job) => `${job.id}:${job.status}`)
    .sort()
    .join(',');
}

/* ---- Mapping to AppShell ---- */

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})/;

/**
 * A due date as local noon of its calendar day (`YYYY-MM-DDT12:00:00`, a valid ISO string). The API sends
 * due dates as midnight UTC, and v0's AppShell formats them with `new Date(value)`, which shows the
 * previous day in US time zones; noon local time reads as the right day everywhere. Remove when v0 formats
 * date-only values itself.
 */
export function noonOf(value: string | null): string | null {
  const match = value ? DATE_ONLY.exec(value) : null;
  return match ? `${match[1]}T12:00:00` : null;
}

export function toShellBid(bid: BidDto): ShellBid {
  return {
    id: bid.id,
    name: bid.name,
    agency: bid.agency,
    dueDate: noonOf(bid.dueDate),
    dueTime: bid.dueTime,
    timeZone: bid.timeZone,
  };
}

/** A placeholder while the bid loads, so the shell keeps its sidebar. */
export function loadingShellBid(bidId: string): ShellBid {
  return { id: bidId, name: 'Loading bid', agency: null, dueDate: null, dueTime: null, timeZone: null };
}

export function userOf(me: Pick<MeDto, 'name' | 'email'> | null): { name: string; email: string } {
  if (!me) return { name: '', email: '' };
  const name = me.name?.trim();
  return { name: name ? name : me.email, email: me.email };
}

/* ---- Upgrade ---- */

export const BILLING_UNAVAILABLE_MESSAGE = 'Billing opens when Stripe is connected.';
export const OWNER_ONLY_MESSAGE = 'Ask the organization owner to upgrade.';

export type UpgradeOutcome = { kind: 'redirect'; url: string } | { kind: 'notice'; message: string };

function upgradeNotice(error: unknown): UpgradeOutcome {
  if (error instanceof ApiError && error.status === 503) return { kind: 'notice', message: BILLING_UNAVAILABLE_MESSAGE };
  if (error instanceof ApiError && error.status === 403) return { kind: 'notice', message: OWNER_ONLY_MESSAGE };
  return { kind: 'notice', message: messageOf(error) };
}

/**
 * "Choose Starter/Growth": Stripe Checkout. An organization that already has a subscription (409) goes to
 * the billing portal instead; 503 means Stripe is not configured; 403 means the user is not the owner.
 */
export async function upgradeAction(deps: ShellApi, plan: PaidPlan): Promise<UpgradeOutcome> {
  try {
    const { url } = await deps.startCheckout(plan);
    return { kind: 'redirect', url };
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) return upgradeNotice(error);
  }
  try {
    const { url } = await deps.openBillingPortal();
    return { kind: 'redirect', url };
  } catch (error) {
    return upgradeNotice(error);
  }
}

import * as api from '@/api';
import { ApiError, SEAT_LOCKED } from '@/api';
import type { BidDto } from '@/api';
import type { BidCard, BidType, FileKind, UploadNotice } from '@/types';
import { summarizeOrg, type OrgSummary } from '@/features/shared/credits';
import { messageOf, noticeFor } from '@/features/shared/messages';

export { periodEndFrom, summarizeOrg, type OrgSummary } from '@/features/shared/credits';

/** The slice of the typed API client the bids containers use. Tests pass a mock. */
export interface BidsApi {
  listBids: typeof api.listBids;
  createBid: typeof api.createBid;
  uploadFile: typeof api.uploadFile;
  getOrg: typeof api.getOrg;
}

export const bidsApi: BidsApi = api;

/** API errors carry text meant for the user (out of credits, key mismatch, over the cap); show it as given. */
export { DUPLICATE_MESSAGE, messageOf } from '@/features/shared/messages';

/* ---- Bid list ---- */

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Calendar days from today to the due date, by date-only math in local time. A due date is a calendar
 * date, so it is never parsed as an instant: `new Date('2026-10-16')` is midnight UTC and reads a day
 * early in US time zones. Undefined when there is no (readable) due date.
 */
export function daysLeft(dueDate: string | null, now: Date): number | undefined {
  const match = dueDate ? DATE_PREFIX.exec(dueDate) : null;
  if (!match) return undefined;
  const due = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86_400_000);
}

export function toBidCard(bid: BidDto, now: Date): BidCard {
  return {
    id: bid.id,
    name: bid.name,
    agency: bid.agency ?? undefined,
    dueDate: bid.dueDate ?? undefined,
    daysLeft: daysLeft(bid.dueDate, now),
    status: bid.status,
    creditUsed: bid.creditStatus === 'reserved' || bid.creditStatus === 'consumed',
  };
}

function dueKey(card: BidCard): string | null {
  return card.dueDate ? card.dueDate.slice(0, 10) : null;
}

/**
 * Open bids first, by due date (soonest first, no date last); closed bids last, most recent due date
 * first. Ties go by name so the order is stable.
 */
export function sortBidCards(cards: BidCard[]): BidCard[] {
  const byName = (a: BidCard, b: BidCard) => a.name.localeCompare(b.name);
  const open = cards
    .filter((card) => card.status !== 'closed')
    .sort((a, b) => {
      const x = dueKey(a);
      const y = dueKey(b);
      if (x === y) return byName(a, b);
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? -1 : 1;
    });
  const closed = cards
    .filter((card) => card.status === 'closed')
    .sort((a, b) => {
      const x = dueKey(a);
      const y = dueKey(b);
      if (x === y) return byName(a, b);
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? 1 : -1;
    });
  return [...open, ...closed];
}

/* ---- Loading ---- */

export type BidsScreenData = { kind: 'ready'; cards: BidCard[]; org: OrgSummary } | { kind: 'no_org' };
export type NewBidScreenData = { kind: 'ready'; org: OrgSummary } | { kind: 'no_org' };

/**
 * GET /api/org answers 403 "No organization" for a user who has not created one yet. A 403
 * seat_locked is a member without a seat, not "no organization" (the shell shows its screen). The
 * legacy screens/Outside.tsx makes the same plain-403 check; it is left as is until v0 replaces it.
 */
function isNoOrg(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code !== SEAT_LOCKED;
}

export async function loadBidsScreen(deps: BidsApi, now: Date, signal?: AbortSignal): Promise<BidsScreenData> {
  try {
    const [bids, payload] = await Promise.all([deps.listBids({ signal }), deps.getOrg({ signal })]);
    return { kind: 'ready', cards: sortBidCards(bids.map((bid) => toBidCard(bid, now))), org: summarizeOrg(payload, now) };
  } catch (error) {
    if (isNoOrg(error)) return { kind: 'no_org' };
    throw error;
  }
}

export async function loadNewBidScreen(deps: BidsApi, now: Date, signal?: AbortSignal): Promise<NewBidScreenData> {
  try {
    return { kind: 'ready', org: summarizeOrg(await deps.getOrg({ signal }), now) };
  } catch (error) {
    if (isNoOrg(error)) return { kind: 'no_org' };
    throw error;
  }
}

/* ---- Create a bid and upload its files ---- */

export interface PlannedUpload {
  file: File;
  kind: FileKind;
}

export function isPdf(file: File): boolean {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
}

/**
 * The first PDF is the solicitation and the rest are attachments. The solicitation goes first: the API
 * refuses attachments until the bid has one (`solicitation_first`), and uploading it reserves the credit.
 * With no PDF in the set, the first file stands in as the solicitation so the others are not refused.
 */
export function planUploads(files: File[]): PlannedUpload[] {
  if (files.length === 0) return [];
  const at = Math.max(0, files.findIndex(isPdf));
  return [
    { file: files[at], kind: 'solicitation' },
    ...files.filter((_, index) => index !== at).map((file): PlannedUpload => ({ file, kind: 'attachment' })),
  ];
}

export interface UploadProgressInfo {
  /** Zero-based position in the upload order. */
  index: number;
  total: number;
  fileName: string;
}

export type CreateBidResult =
  | { ok: false; message: string }
  | { ok: true; bidId: string; notices: UploadNotice[] };

/**
 * Creates the bid, then uploads one file at a time. If the bid was created, the result is `ok` even when
 * an upload failed: the notices say what happened and the screen goes to the bid's documents anyway. A
 * failed solicitation stops the run (everything else depends on it); a failed attachment does not.
 */
export async function createBidAction(
  deps: BidsApi,
  input: { name: string; bidType: BidType; files: File[] },
  onProgress?: (info: UploadProgressInfo) => void,
): Promise<CreateBidResult> {
  let bid: BidDto;
  try {
    bid = await deps.createBid({ name: input.name, bidType: input.bidType });
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }

  const plan = planUploads(input.files);
  const notices: UploadNotice[] = [];
  for (const [index, { file, kind }] of plan.entries()) {
    onProgress?.({ index, total: plan.length, fileName: file.name });
    const id = `${bid.id}:${index}`;
    try {
      const result = await deps.uploadFile(bid.id, file, kind);
      if (result.duplicate) {
        notices.push(noticeFor('duplicate', file, id));
      }
    } catch (error) {
      notices.push(noticeFor(error, file, id));
      if (kind === 'solicitation') break;
    }
  }
  return { ok: true, bidId: bid.id, notices };
}

import { ApiError } from '@/api';
import type { FormStatus, RowFlag, UploadNotice } from '@/types';

export const FALLBACK_MESSAGE = 'Something went wrong. Try again.';

/** API errors carry text meant for the user; show it as given. Anything else gets `fallback`. */
export function messageOf(error: unknown, fallback = FALLBACK_MESSAGE): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

/** A failed save or submit as a `FormStatus` (09 s5): the ApiError message as given, else the fallback. */
export function toFormStatus(error: unknown, fallback = FALLBACK_MESSAGE): FormStatus {
  return { state: 'error', message: messageOf(error, fallback) };
}

/** The shown text for a duplicate upload (05 s3.10). */
export const DUPLICATE_MESSAGE = 'Already uploaded.';

/**
 * The notice for one file of an upload (09 s5.11 `UploadNotice`): a refusal shows the API's message as
 * given (cap, key mismatch, solicitation first, out of credits); `'duplicate'` is the 05 s3.10 info line.
 */
export function noticeFor(outcome: unknown, file: { name: string }, id: string): UploadNotice {
  if (outcome === 'duplicate') return { id, fileName: file.name, tone: 'info', message: DUPLICATE_MESSAGE };
  return { id, fileName: file.name, tone: 'error', message: messageOf(outcome) };
}

const KNOWN_FLAGS: readonly RowFlag[] = ['maybe_not_requirement', 'page_estimated', 'ocr', 'quote_unverified'];

/**
 * A row's flags for the ui (09 s5.12 `RowFlag`): the known strings from the API, once each and in a fixed
 * order, plus `quote_unverified` for an AI row whose quote was not found on its page.
 */
export function toFlags(row: { flags: string[] | null; origin: 'ai' | 'user' | null; quoteVerified: boolean }): RowFlag[] {
  const present = new Set<string>(row.flags ?? []);
  if (row.origin === 'ai' && !row.quoteVerified) present.add('quote_unverified');
  return KNOWN_FLAGS.filter((flag) => present.has(flag));
}

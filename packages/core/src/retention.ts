import type { FileKind } from './credits';
import type { Plan } from './limits';

/**
 * File retention (03 s39, 07 s2). Pure functions: the api computes the dates it shows from
 * them, and the future retention and restore jobs use the same rules.
 */

/** Days a file stays live after upload, and after the bid's due date on paid plans. */
export const LIVE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a.getTime() >= b.getTime() ? a : b;
}

export interface DocumentRetentionInput {
  plan: Plan;
  kind: FileKind;
  uploadedAt: Date;
  dueDate: Date | null;
  retentionExtendedUntil: Date | null;
}

/**
 * When a file's live copy goes to the archive (03 s39):
 * - Free: upload plus 90 days.
 * - Starter and Growth: the later of upload plus 90 days and the due date plus 90 days, or the
 *   bid's `retention_extended_until` if the owner set a later date.
 * - Resumes, on every plan: upload plus 90 days.
 */
export function documentLiveUntil(input: DocumentRetentionInput): Date {
  const byUpload = addDays(input.uploadedAt, LIVE_DAYS);
  if (input.kind === 'resume' || input.plan === 'free') {
    return byUpload;
  }
  const byDue = input.dueDate ? addDays(input.dueDate, LIVE_DAYS) : null;
  return later(later(byUpload, byDue), input.retentionExtendedUntil)!;
}

export interface BidRetentionInput {
  plan: Plan;
  /** The latest upload of any kind still on the bid (not deleted), or null. */
  latestUploadAt: Date | null;
  /** The latest upload that is not a resume (not deleted), or null. */
  latestNonResumeUploadAt: Date | null;
  dueDate: Date | null;
}

/**
 * The date the bid's files stay live until without an extension (5.11 "Files stay live until"):
 * - Paid: the later of the latest non-resume upload plus 90 days and the due date plus 90 days.
 * - Free: the latest upload plus 90 days.
 * Null when neither date exists.
 */
export function bidDefaultLiveUntil(input: BidRetentionInput): Date | null {
  if (input.plan === 'free') {
    return input.latestUploadAt ? addDays(input.latestUploadAt, LIVE_DAYS) : null;
  }
  const byUpload = input.latestNonResumeUploadAt ? addDays(input.latestNonResumeUploadAt, LIVE_DAYS) : null;
  const byDue = input.dueDate ? addDays(input.dueDate, LIVE_DAYS) : null;
  return later(byUpload, byDue);
}

/**
 * The later of the default and the owner's extension. An extension counts on paid plans only,
 * as in `documentLiveUntil`: a bid that kept an extension after a move to Free shows the Free date.
 */
export function bidFilesLiveUntil(input: BidRetentionInput & { retentionExtendedUntil: Date | null }): Date | null {
  const fallback = bidDefaultLiveUntil(input);
  if (input.plan === 'free') {
    return fallback;
  }
  return later(fallback, input.retentionExtendedUntil);
}

// ---------------------------------------------------------------------------
// Settings in app_settings (key/value text). Owner decisions are open (05 s3.10, 07 s2), so
// the values are read at request time and fall back to these defaults.
// ---------------------------------------------------------------------------

export const SETTING_RESTORE_FREE_ALLOWED = 'restore_free_allowed';
export const SETTING_RESTORE_WINDOW_DAYS = 'restore_window_days';

export const DEFAULT_RESTORE_FREE_ALLOWED = true;
export const DEFAULT_RESTORE_WINDOW_DAYS = 7;

/** 'true'/'false' (also 1/0, yes/no, any case); anything else gives the fallback. */
export function parseBooleanSetting(value: string | null | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

/** A whole number at least `min`; anything else gives the fallback. */
export function parseIntSetting(value: string | null | undefined, fallback: number, min = 0): number {
  if (value === null || value === undefined || !/^\s*\d+\s*$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
}

export interface RestoreSettings {
  freeAllowed: boolean;
  windowDays: number;
}

/** Restore settings from app_settings values (missing or malformed values use the defaults). */
export function restoreSettings(values: Record<string, string | undefined>): RestoreSettings {
  return {
    freeAllowed: parseBooleanSetting(values[SETTING_RESTORE_FREE_ALLOWED], DEFAULT_RESTORE_FREE_ALLOWED),
    windowDays: parseIntSetting(values[SETTING_RESTORE_WINDOW_DAYS], DEFAULT_RESTORE_WINDOW_DAYS, 1),
  };
}

/** Whether an organization on `plan` may restore archived files. */
export function canRestore(plan: Plan, settings: RestoreSettings): boolean {
  return plan !== 'free' || settings.freeAllowed;
}

/**
 * For the future restore worker: once a file is back on the server at `restoredAt`, it stays
 * until this date (`archive_objects.restored_until`), then is deleted from the server again.
 */
export function restoredUntil(restoredAt: Date, settings: RestoreSettings): Date {
  return addDays(restoredAt, settings.windowDays);
}

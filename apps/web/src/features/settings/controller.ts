import * as api from '@/api';
import type { BidDto, BidPatch } from '@/api';
import type { BidSettingsProps, BidSettingsValues, DueMove } from '@/types';
import { dayOf } from '@/features/schedule/derive';

/** The calls the Settings container makes; tests pass fakes. getTab and adjustSchedule are the date change's. */
export interface SettingsApi {
  getBid: typeof api.getBid;
  updateBid: typeof api.updateBid;
  deleteBid: typeof api.deleteBid;
  getTab: typeof api.getTab;
  adjustSchedule: typeof api.adjustSchedule;
}

export const settingsApi: SettingsApi = api;

export const SAVED_MESSAGE = 'Saved.';
export const DUE_UNCHANGED_MESSAGE = 'Saved. The due date did not change.';
/** As DUE_UNCHANGED_MESSAGE, when the save sent nothing else. */
export const DUE_NOT_CHANGED_MESSAGE = 'The due date did not change.';
/** A due change whose save landed after a switch to another bid: the prompt is not opened there. */
export const dueNotAppliedMessage = (bidName: string) => `The due date of ${bidName} did not change. Open its settings to change it again.`;
export const DUE_SAVED_NOT_MOVED_MESSAGE = 'The new due date is saved. The schedule did not move.';

/** The form's values (09 s5.11 BidSettingsValues) from the stored bid. Dates are 'YYYY-MM-DD', the time 'HH:mm'. */
export function toSettingsValues(bid: BidDto): BidSettingsValues {
  return {
    name: bid.name,
    agency: bid.agency ?? '',
    bidType: bid.bidType,
    solicitationNumber: bid.solicitationNumber,
    startDate: dayOf(bid.startDate),
    dueDate: dayOf(bid.dueDate),
    dueTime: bid.dueTime ? bid.dueTime.slice(0, 5) : null,
    timeZone: bid.timeZone ?? '',
    oralsEnabled: bid.oralsEnabled,
    keepFilesLiveUntil: dayOf(bid.retentionExtendedUntil),
  };
}

/** The danger zone's credit line: a released credit (or none) has nothing to say. */
export function toCreditStatus(bid: Pick<BidDto, 'creditStatus'>): BidSettingsProps['creditStatus'] {
  return bid.creditStatus === 'reserved' || bid.creditStatus === 'consumed' ? bid.creditStatus : 'none';
}

/**
 * The PATCH for the changed fields, never the due date (the date path writes it). An empty agency is
 * cleared (null); the time zone is sent only when changed to a zone; the live-until date only when the
 * user may set it (`canKeepLive`: the owner on a paid plan; the API refuses anyone else).
 */
export function settingsPatch(before: BidSettingsValues, after: BidSettingsValues, canKeepLive: boolean): BidPatch {
  const patch: BidPatch = {};
  if (after.name !== before.name) patch.name = after.name;
  if (after.agency !== before.agency) patch.agency = after.agency.trim() === '' ? null : after.agency;
  if (after.bidType !== before.bidType) patch.bidType = after.bidType;
  if (after.solicitationNumber !== before.solicitationNumber) patch.solicitationNumber = after.solicitationNumber;
  if (after.startDate !== before.startDate) patch.startDate = after.startDate;
  if (after.dueTime !== before.dueTime) patch.dueTime = after.dueTime;
  if (after.timeZone !== before.timeZone && after.timeZone !== '') patch.timeZone = after.timeZone;
  if (after.oralsEnabled !== before.oralsEnabled) patch.oralsEnabled = after.oralsEnabled;
  if (canKeepLive && after.keepFilesLiveUntil !== before.keepFilesLiveUntil) patch.retentionExtendedUntil = after.keepFilesLiveUntil;
  return patch;
}

export type DuePlan =
  | { kind: 'none' }
  /** A first or a cleared due date: one PATCH, no prompt (shift and scale need both dates). */
  | { kind: 'direct'; dueDate: string | null }
  /** Both dates set and different: the prompt asks how to move the schedule. */
  | { kind: 'prompt'; move: DueMove };

export interface SavePlan {
  patch: BidPatch;
  due: DuePlan;
}

export function planSave(before: BidSettingsValues, after: BidSettingsValues, canKeepLive: boolean): SavePlan {
  const patch = settingsPatch(before, after, canKeepLive);
  const previousDue = before.dueDate;
  const nextDue = after.dueDate;
  if (previousDue === nextDue) return { patch, due: { kind: 'none' } };
  if (previousDue === null || nextDue === null) return { patch, due: { kind: 'direct', dueDate: nextDue } };
  return { patch, due: { kind: 'prompt', move: { previousDue, nextDue } } };
}

export const isEmptyPatch = (patch: BidPatch) => Object.keys(patch).length === 0;

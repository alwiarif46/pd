import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import type { BidSettingsValues, DateChangeMode, FormStatus } from '@/types';
import { messageOf, toFormStatus } from '@/features/shared/messages';
import { DATE_CHANGE_BUSY_MESSAGE, doneMessage, withDeadline } from '@/features/schedule/controller';
import { dateChangeHolder, useDateChangeHolder, withDateChangeLock } from '@/features/schedule/date-change-lock';
import { dayOf } from '@/features/schedule/derive';
import { useUserDateChange } from '@/features/schedule/use-user-date-change';
import { useRequiredShell } from '@/features/shell/bid-context';
import type { TabScreenProps } from '@/features/shell/registry';
import { TabFrameContainer } from '@/features/tab-frame/TabFrameContainer';
import { BidSettings } from '@/ui/settings/BidSettings';
import { DateChangePrompt } from '@/ui/settings/DateChangePrompt';
import {
  DUE_NOT_CHANGED_MESSAGE,
  DUE_SAVED_NOT_MOVED_MESSAGE,
  DUE_UNCHANGED_MESSAGE,
  dueNotAppliedMessage,
  isEmptyPatch,
  planSave,
  SAVED_MESSAGE,
  settingsApi,
  toCreditStatus,
  toSettingsValues,
  type SettingsApi,
} from './controller';

interface Props extends TabScreenProps {
  /** Test seam; defaults to the typed client. */
  api?: SettingsApi;
}

/** A form status with the bid it belongs to: the shell switches bids without remounting this container. */
interface BidStatus {
  bidId: string;
  status: FormStatus;
}

const IDLE: FormStatus = { state: 'idle' };
const SUBMITTING: FormStatus = { state: 'submitting' };
const done = (message: string): FormStatus => ({ state: 'done', message });
/** How long "Saved." stays before the form returns to idle. */
export const SAVED_SHOWN_MS = 3000;

/**
 * The Settings tab (09 s5.11 BidSettings and DateChangePrompt): the bid's fields, the due-date change, and
 * Delete bid. Settings is never blocked, locked, or bannered (deriveTabFrame), so it works before any upload.
 */
export function SettingsContainer({ bidId, api = settingsApi }: Props) {
  const shell = useRequiredShell();
  /** The user's due-date change, shared with Schedule (use-user-date-change.ts); meta: the other fields were saved first. */
  const userChange = useUserDateChange<{ othersSaved: boolean }>(api);
  const [save, setSave] = useState<BidStatus | null>(null);
  const [del, setDel] = useState<BidStatus | null>(null);
  /** Bumped when the form must drop what was typed although the stored bid did not change (Cancel). */
  const [formKey, setFormKey] = useState(0);
  /** The bid on screen, for answers that land after a bid switch. Handlers read it; render reads props. */
  const shownRef = useRef(bidId);
  useEffect(() => {
    shownRef.current = bidId;
  }, [bidId]);

  const bid = shell.bid?.id === bidId ? shell.bid : null;
  // A value-stable `bid` prop: the shell reloads the bid on every poll and on window focus, and a new
  // identity with the same values must never resync (wipe) a half-typed form.
  const valuesKey = bid ? JSON.stringify(toSettingsValues(bid)) : null;
  const values = useMemo(() => (valuesKey ? (JSON.parse(valuesKey) as BidSettingsValues) : null), [valuesKey]);

  const saveStatus = save?.bidId === bidId ? save.status : IDLE;
  const deleteStatus = del?.bidId === bidId ? del.status : IDLE;
  useEffect(() => {
    if (saveStatus.state !== 'done') return;
    const timer = setTimeout(() => setSave((s) => (s?.status === saveStatus ? null : s)), SAVED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  // The bid's date-change lock (date-change-lock.ts, shared with Schedule): this screen's own answer in
  // flight, or another screen's. v0's prompt has no busy prop, so clicks are ignored while it is held.
  const lockHolder = useDateChangeHolder(bidId);
  const mineBusy = lockHolder !== null && lockHolder === userChange.owner;
  const pending = userChange.current(bidId);

  const isOwner = shell.org.role === 'owner';
  const plan = shell.summary.plan;
  const canKeepLive = isOwner && plan !== 'free';

  const setStatus = (target: string, status: FormStatus) => setSave({ bidId: target, status });

  /** A date-change click refused because an answer for the bid holds its lock: say so unless it is this screen's. */
  const refusedBusy = (target: string) => {
    if (dateChangeHolder(target) !== userChange.owner) toast.info(DATE_CHANGE_BUSY_MESSAGE);
  };

  const onSave = (next: BidSettingsValues) => {
    if (!values || saveStatus.state === 'submitting') return;
    const target = bidId;
    const targetName = next.name || values.name;
    const { patch, due } = planSave(values, next, canKeepLive);

    if (due.kind === 'direct') {
      // A first (or cleared) due date is one PATCH with the other fields, but still a write of the bid's
      // due date: it takes the lock and its time bound, as Schedule's does, so it cannot land in the middle
      // of another screen's answer. Refused, with nothing sent, while the lock is held.
      const run = withDateChangeLock(target, () => withDeadline(api.updateBid(target, { ...patch, dueDate: due.dueDate })), userChange.owner);
      if (!run) {
        refusedBusy(target);
        return;
      }
      setStatus(target, SUBMITTING);
      run
        .then(
          () => setStatus(target, done(SAVED_MESSAGE)),
          (error: unknown) => setStatus(target, toFormStatus(error)),
        )
        .finally(() => shell.refresh());
      return;
    }

    if (isEmptyPatch(patch) && due.kind === 'none') {
      setStatus(target, done(SAVED_MESSAGE));
      return;
    }

    // The other fields are saved first; a due change then opens the prompt (Cancel keeps them saved).
    setStatus(target, SUBMITTING);
    const othersSaved = !isEmptyPatch(patch);
    const first = othersSaved ? api.updateBid(target, patch) : Promise.resolve(null);
    first.then(
      () => {
        if (othersSaved) shell.refresh();
        if (due.kind === 'none') {
          setStatus(target, done(SAVED_MESSAGE));
          return;
        }
        const unchanged = othersSaved ? DUE_UNCHANGED_MESSAGE : DUE_NOT_CHANGED_MESSAGE;
        if (shownRef.current !== target) {
          // The user switched bids while the other fields saved: the prompt would open on a bid no longer
          // shown, so the due date is left as it is, and said so by name. The form on screen is the other
          // bid's, so it is not touched (this container stays mounted across a bid switch).
          toast.info(dueNotAppliedMessage(targetName));
          setStatus(target, done(unchanged));
          return;
        }
        // Refused while an answer for the bid is being applied (Schedule's, perhaps).
        if (!userChange.open(target, due.move, { othersSaved })) {
          toast.info(DATE_CHANGE_BUSY_MESSAGE);
          setStatus(target, done(unchanged));
          setFormKey((k) => k + 1); // drop the typed due date; this bid's form is the one on screen
          return;
        }
        setStatus(target, IDLE);
      },
      (error: unknown) => {
        setStatus(target, toFormStatus(error));
        shell.refresh();
      },
    );
  };

  // OPUS STEP: the user's due-date change, two writes to shared bid state (the due date, then the
  // schedule), applied by the hook shared with Schedule (use-user-date-change.ts: resolveDateChange with
  // its re-reads, stale detection and progress kept across retries, under the per-bid lock). Refused at
  // once, with nothing sent, while any answer for the bid is in flight (a double click, or Schedule's).
  // Toasts and shell.refresh() stay here; the answer still lands and releases the lock if this unmounts.
  const onChoose = (mode: DateChangeMode) => {
    const target = bidId;
    const run = userChange.resolve(target, mode);
    if (!run) {
      refusedBusy(target);
      return;
    }
    run
      .then((outcome) => {
        switch (outcome.kind) {
          case 'done':
            toast.success(doneMessage(outcome.result));
            setStatus(target, done(SAVED_MESSAGE));
            break;
          case 'stale':
          case 'check':
            toast.error(outcome.message);
            setStatus(target, { state: 'error', message: outcome.message });
            break;
          case 'failed':
          case 'adjust_failed':
            // The prompt stays open with the returned progress; a retry neither skips nor repeats a write.
            toast.error(outcome.message);
            break;
        }
      })
      .catch((error: unknown) => toast.error(messageOf(error)))
      .finally(() => shell.refresh());
  };

  const onCancel = () => {
    // This screen's answer is being applied; it closes the prompt itself.
    if (dateChangeHolder(bidId) === userChange.owner) return;
    const open = userChange.current(bidId);
    if (!open) return;
    userChange.cancel(bidId);
    const message = open.dueSaved ? DUE_SAVED_NOT_MOVED_MESSAGE : open.meta.othersSaved ? DUE_UNCHANGED_MESSAGE : DUE_NOT_CHANGED_MESSAGE;
    toast.info(message);
    setStatus(bidId, done(message));
    // The stored bid may equal what the form was given, so the typed due date is dropped by a remount.
    setFormKey((k) => k + 1);
    shell.refresh();
  };

  const onDeleteBid = () => {
    if (deleteStatus.state === 'submitting') return;
    const target = bidId;
    setDel({ bidId: target, status: SUBMITTING });
    api.deleteBid(target).then(
      () => {
        setDel(null);
        shell.refresh();
        window.location.hash = '#/bids';
      },
      (error: unknown) => setDel({ bidId: target, status: toFormStatus(error) }),
    );
  };

  let body;
  if (!shell.bidLoaded || !bid || !values) {
    // A failed bid load is the shell's to show.
    body = (
      <div role="status" aria-label="Loading settings">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-64 w-full" />
      </div>
    );
  } else {
    body = (
      <>
        <BidSettings
          key={`${bidId}/${formKey}`}
          bid={values}
          plan={plan}
          isOwner={isOwner}
          filesLiveUntil={dayOf(bid.filesLiveUntil)}
          creditStatus={toCreditStatus(bid)}
          saveStatus={saveStatus}
          deleteStatus={deleteStatus}
          onSave={onSave}
          onDeleteBid={onDeleteBid}
        />
        {pending && (
          <DateChangePrompt
            open
            previousDue={pending.due.previousDue}
            nextDue={pending.due.nextDue}
            onChoose={(mode) => {
              if (mineBusy) return; // this screen's answer is in flight
              onChoose(mode);
            }}
            onCancel={onCancel}
          />
        )}
      </>
    );
  }

  return (
    <TabFrameContainer tab="settings" title="Settings">
      {body}
    </TabFrameContainer>
  );
}

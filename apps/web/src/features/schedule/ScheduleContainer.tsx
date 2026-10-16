import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isAbortError, type ScheduleActivityDto } from '@/api';
import { RowDetail } from '@/components/RowDetail';
import { SourceViewer } from '@/components/SourceViewer';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { ActivityDraft, DateChangeMode, DueMove, ScheduleDateChange, ScheduleExportFormat, ScheduleTemplateId } from '@/types';
import { messageOf } from '@/features/shared/messages';
import { useRequiredShell } from '@/features/shell/bid-context';
import { jobsKey } from '@/features/shell/controller';
import { LegacyFrame } from '@/features/shell/LegacyFrame';
import type { TabScreenProps } from '@/features/shell/registry';
import { TabFrameContainer } from '@/features/tab-frame/TabFrameContainer';
import {
  csvSafe,
  exportFileName,
  scheduleExporter,
  scheduleIcs,
  schedulePrintHtml,
  scheduleSheet,
  type ScheduleExporter,
} from '@/schedule/export';
import { plural } from '@/schedule/format';
import { ScheduleTab } from '@/schedule/ScheduleTab';
import { doneMessage, NO_PROGRESS, resolveDateChange, scheduleApi, type DateChangeProgress, type ScheduleApi } from './controller';
import {
  ACTIVITY_OPTIONS,
  dateChangeSummary,
  dayOf,
  dueLabelOf,
  holidaysFor,
  localToday,
  msToNextLocalDay,
  sortActivities,
  templateOptions,
  toCreateBody,
  toRowPatch,
  toScheduleActivity,
} from './derive';

interface Props extends TabScreenProps {
  /** Test seams; default to the typed client, the browser downloads, and the clock. */
  api?: ScheduleApi;
  exporter?: ScheduleExporter;
  now?: () => Date;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; activities: ScheduleActivityDto[]; workdaysOnly: boolean };

interface Source {
  documentId: string;
  page: number;
  pageEnd: number | null;
  quote: string | null;
}

/** A date change waiting for an answer, tied to the bid it was opened on, with what its tries wrote. */
interface PendingChange {
  bidId: string;
  change: ScheduleDateChange;
  /** The user's move, typed for resolveDateChange (the change above keeps previousDue nullable for amendments). */
  due: DueMove;
  /** What earlier tries already wrote (controller.ts DateChangeProgress). */
  progress: DateChangeProgress;
  /** A try saved the new due date but did not move the schedule. */
  dueSaved: boolean;
}

/** A row's move being saved, and the latest target asked for while it was. */
interface MoveQueue {
  next: { start: string; end: string } | null;
}

const defaultNow = () => new Date();
const TEMPLATES = templateOptions();
const LOADING: LoadState = { kind: 'loading' };
const NO_DTOS: ScheduleActivityDto[] = [];
const asTimestamp = (day: string) => `${day}T00:00:00.000Z`;
const rowKey = (bidId: string, id: string) => `${bidId}/${id}`;

/** The Schedule tab (05 s3.2): loads the bid's activities, renders the src/schedule port, and wires its actions. */
export function ScheduleContainer({ bidId, selectedRowId, api = scheduleApi, exporter = scheduleExporter, now = defaultNow }: Props) {
  const shell = useRequiredShell();
  const [today, setToday] = useState(() => localToday(now()));
  const [load, setLoad] = useState<{ bidId: string; state: LoadState } | null>(null);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState<PendingChange | null>(null);
  /** Bids with a date-change answer being applied; the ref guards double clicks, the state draws it. */
  const [busyBids, setBusyBids] = useState<readonly string[]>([]);
  const busyRef = useRef(new Set<string>());
  /** Per bid and row: moves being saved (one PATCH at a time, latest target last) and lock toggles. */
  const movesRef = useRef(new Map<string, MoveQueue>());
  const locksRef = useRef(new Set<string>());
  const [source, setSource] = useState<Source | null>(null);
  /** The bid whose schedule is on screen (set when a load succeeds). */
  const shownRef = useRef<string | null>(null);
  const jobKey = jobsKey({ jobs: shell.jobs });

  // `today` follows the clock: at the next local midnight, and whenever the window comes back.
  useEffect(() => {
    const update = () => setToday(localToday(now()));
    const timer = setTimeout(update, msToNextLocalDay(now()) + 1000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [now, today]);

  useEffect(() => {
    const abort = new AbortController();
    api.getTab(bidId, 'schedule', { signal: abort.signal }).then(
      (payload) => {
        shownRef.current = bidId;
        setLoad({ bidId, state: { kind: 'ready', activities: payload.activities, workdaysOnly: payload.workdaysOnly } });
      },
      (error: unknown) => {
        if (isAbortError(error)) return;
        // A failed reload keeps the schedule already shown for this bid.
        if (shownRef.current === bidId) toast.error(messageOf(error));
        else setLoad({ bidId, state: { kind: 'error', message: messageOf(error) } });
      },
    );
    return () => abort.abort();
  }, [api, bidId, version, jobKey]);

  const state: LoadState = load?.bidId === bidId ? load.state : LOADING;
  const dtos = state.kind === 'ready' ? state.activities : NO_DTOS;
  const workdaysOnly = state.kind === 'ready' ? state.workdaysOnly : true;
  const open = pending?.bidId === bidId ? pending : null;
  const dateChange = open?.change ?? null;
  const dateBusy = busyBids.includes(bidId);
  const bid = shell.bid;
  const startDate = dayOf(bid?.startDate ?? null);
  const dueDate = dayOf(bid?.dueDate ?? null);
  const dueLabel = dueLabelOf(bid);

  const activities = useMemo(() => {
    const ids = new Set(dtos.map((d) => d.id));
    return sortActivities(dtos.map((d) => toScheduleActivity(d, ids)));
  }, [dtos]);
  // From the stored origin, as the server's replace counts: a row with no origin shows as added by
  // hand but is not removed.
  const replaceCounts = useMemo(() => {
    const unlocked = dtos.filter((d) => !d.locked);
    return {
      template: unlocked.filter((d) => d.origin === 'template').length,
      user: unlocked.filter((d) => d.origin === 'user').length,
    };
  }, [dtos]);
  const holidays = useMemo(() => holidaysFor({ today, startDate, dueDate, activities }), [today, startDate, dueDate, activities]);
  const hasAiRows = activities.some((a) => a.origin === 'ai');
  const summary = useMemo(
    () =>
      dateChange && dateChange.previousDue !== null
        ? dateChangeSummary(activities, { previousDue: dateChange.previousDue, nextDue: dateChange.nextDue }, { anchor: startDate, workdaysOnly })
        : null,
    [activities, dateChange, startDate, workdaysOnly],
  );

  const reload = () => setVersion((n) => n + 1);
  const afterSave = () => {
    reload();
    shell.refresh();
  };
  const fail = (error: unknown) => {
    toast.error(messageOf(error));
    reload();
  };
  const mutate = (call: () => Promise<unknown>) => {
    call().then(afterSave, fail);
  };
  const setReady = (update: (ready: Extract<LoadState, { kind: 'ready' }>) => Extract<LoadState, { kind: 'ready' }>) => {
    setLoad((prev) => (prev?.bidId === bidId && prev.state.kind === 'ready' ? { bidId, state: update(prev.state) } : prev));
  };
  const patchLocal = (id: string, patch: Partial<ScheduleActivityDto>) =>
    setReady((ready) => ({ ...ready, activities: ready.activities.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));

  // One PATCH per row at a time: moves asked for while one is saving (held arrow keys) wait, and only
  // the latest is sent, so the saves cannot land out of order.
  const sendMove = (key: string, id: string, start: string, end: string) => {
    movesRef.current.set(key, { next: null });
    api.updateRow(bidId, 'schedule_activities', id, { startDate: start, endDate: end }).then(
      () => {
        const next = movesRef.current.get(key)?.next;
        if (next) {
          sendMove(key, id, next.start, next.end);
          return;
        }
        movesRef.current.delete(key);
        afterSave();
      },
      (error: unknown) => {
        movesRef.current.delete(key);
        fail(error);
      },
    );
  };

  const onMoveActivity = (id: string, start: string, end: string) => {
    const dto = dtos.find((d) => d.id === id);
    if (!dto || dto.locked) return;
    patchLocal(id, { startDate: asTimestamp(start), endDate: asTimestamp(end) });
    const key = rowKey(bidId, id);
    const queued = movesRef.current.get(key);
    if (queued) queued.next = { start, end };
    else sendMove(key, id, start, end);
  };

  const onToggleLock = (id: string, locked: boolean) => {
    const key = rowKey(bidId, id);
    if (locksRef.current.has(key)) return; // a second click while the first is saving
    locksRef.current.add(key);
    patchLocal(id, { locked });
    api.updateRow(bidId, 'schedule_activities', id, { locked }).then(
      () => {
        locksRef.current.delete(key);
        afterSave();
      },
      (error: unknown) => {
        locksRef.current.delete(key);
        fail(error);
      },
    );
  };

  const onApplyTemplate = (template: ScheduleTemplateId, replace: boolean) => {
    api.seedSchedule(bidId, { template, replace }).then(
      (result) => {
        setReady((ready) => ({ ...ready, activities: result.activities }));
        const added = `Added ${plural(result.added, '1 activity', `${result.added} activities`)}`;
        toast.success(`${added}${result.replaced ? `, removed ${result.replaced}` : ''}.`);
        shell.refresh();
      },
      fail,
    );
  };

  const onSetWorkdaysOnly = (value: boolean) => {
    const was = workdaysOnly;
    setReady((ready) => ({ ...ready, workdaysOnly: value }));
    api.updateBid(bidId, { scheduleWorkdaysOnly: value }).then(
      () => shell.refresh(),
      (error: unknown) => {
        setReady((ready) => ({ ...ready, workdaysOnly: was }));
        toast.error(messageOf(error));
        shell.refresh();
      },
    );
  };

  const onChangeDueDate = (next: string) => {
    if (dueDate === null) {
      api.updateBid(bidId, { dueDate: next }).then(() => {
        toast.success('Due date set.');
        afterSave();
      }, fail);
      return;
    }
    if (next === dueDate || busyRef.current.has(bidId)) return;
    setPending({
      bidId,
      change: { origin: 'user', previousDue: dueDate, nextDue: next, amendmentNo: null, sourcePage: null, sourceQuote: null },
      due: { previousDue: dueDate, nextDue: next },
      progress: NO_PROGRESS,
      dueSaved: false,
    });
  };

  // OPUS STEP: two writes to shared bid state (due date, then the schedule). resolveDateChange re-reads
  // the bid and the schedule on every try, and the pending change carries what earlier tries wrote, so a
  // retry after a lost response neither skips the due date nor repeats an adjust that already landed
  // (controller.ts says what stays open: an adjust still running on the server).
  const onResolveDateChange = async (mode: DateChangeMode) => {
    if (!open || busyRef.current.has(open.bidId)) return;
    const record = open;
    const same = (p: PendingChange | null): p is PendingChange => p !== null && p.change === record.change;
    busyRef.current.add(record.bidId);
    setBusyBids((ids) => [...ids, record.bidId]);
    try {
      const outcome = await resolveDateChange(api, record.bidId, record.due, mode, record.progress);
      switch (outcome.kind) {
        case 'done':
          toast.success(doneMessage(outcome.result));
          setPending((p) => (same(p) ? null : p));
          break;
        case 'stale':
        case 'check':
          toast.error(outcome.message);
          setPending((p) => (same(p) ? null : p));
          break;
        case 'adjust_failed':
        case 'failed': {
          toast.error(outcome.message);
          const dueSaved = outcome.kind === 'adjust_failed' || record.dueSaved;
          setPending((p) => (same(p) ? { ...p, progress: outcome.progress, dueSaved } : p));
          break;
        }
      }
    } finally {
      busyRef.current.delete(record.bidId);
      setBusyBids((ids) => ids.filter((id) => id !== record.bidId));
      reload();
      shell.refresh();
    }
  };

  const onCancelDateChange = () => {
    if (busyRef.current.has(bidId)) return; // the answer is being applied; it closes the prompt itself
    setPending((p) => (p?.bidId === bidId ? null : p));
  };

  const onOpenSource = (id: string) => {
    const dto = dtos.find((d) => d.id === id);
    if (!dto?.documentId || dto.sourcePage === null) {
      toast.info('No source page for this activity.');
      return;
    }
    setSource({ documentId: dto.documentId, page: dto.sourcePage, pageEnd: dto.sourcePageEnd, quote: dto.sourceQuote });
  };

  const onExport = (format: ScheduleExportFormat) => {
    const name = bid?.name ?? 'schedule';
    switch (format) {
      case 'csv':
        exporter.csv(exportFileName(name, 'csv'), csvSafe(scheduleSheet(activities, { workdaysOnly })));
        break;
      case 'xlsx':
        exporter.xlsx(exportFileName(name, 'xlsx'), scheduleSheet(activities, { workdaysOnly }));
        break;
      case 'ics':
        exporter.ics(exportFileName(name, 'ics'), scheduleIcs(activities, { calendarName: `${name} schedule`, now: now() }));
        break;
      case 'print':
        exporter.print(schedulePrintHtml({ title: `${name} schedule`, dueLabel, activities, workdaysOnly }));
        break;
    }
  };

  let body;
  if (state.kind === 'loading') {
    body = (
      <div role="status" aria-label="Loading schedule">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-64 w-full" />
      </div>
    );
  } else if (state.kind === 'error') {
    body = (
      <div role="alert" className="flex max-w-md flex-col items-start gap-3 text-ink">
        <p className="text-sm text-due">{state.message}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setLoad(null);
            reload();
          }}
        >
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <ScheduleTab
        activities={activities}
        holidays={holidays}
        templates={TEMPLATES}
        activityOptions={ACTIVITY_OPTIONS}
        today={today}
        startDate={startDate}
        dueDate={dueDate}
        dueLabel={dueLabel}
        workdaysOnly={workdaysOnly}
        selectedRowId={selectedRowId}
        dateChange={dateChange}
        dateChangeSummary={summary}
        dateChangeBusy={dateBusy}
        dateChangeDueSaved={open?.dueSaved ?? false}
        replaceCounts={replaceCounts}
        onAddActivity={(d: ActivityDraft) => mutate(() => api.createTabRow(bidId, 'schedule', toCreateBody(d)))}
        onEditActivity={(id, p) => mutate(() => api.updateRow(bidId, 'schedule_activities', id, toRowPatch(p)))}
        onDeleteActivity={(id) => mutate(() => api.deleteRow(bidId, 'schedule_activities', id))}
        onMoveActivity={onMoveActivity}
        onToggleLock={onToggleLock}
        onApplyTemplate={onApplyTemplate}
        onSetWorkdaysOnly={onSetWorkdaysOnly}
        onResolveDateChange={(mode) => void onResolveDateChange(mode)}
        onCancelDateChange={onCancelDateChange}
        onChangeDueDate={onChangeDueDate}
        onOpenRow={(id) => shell.openRow(id)}
        onOpenSource={onOpenSource}
        onOpenDateChangeSource={() => undefined} // wired with the amendment answer (next step)
        onExport={onExport}
      />
    );
  }

  return (
    <>
      <TabFrameContainer tab="schedule" title="Schedule" hasAiRows={hasAiRows}>
        {body}
      </TabFrameContainer>
      {selectedRowId && (
        <LegacyFrame>
          <RowDetail
            bidId={bidId}
            table="schedule_activities"
            rowId={selectedRowId}
            federal={bid?.bidType === 'federal'}
            documents={shell.docs}
            onClose={() => shell.openRow(null)}
            onOpenSource={(row) => {
              if (row.documentId) {
                setSource({
                  documentId: row.documentId,
                  page: row.sourcePage ?? 1,
                  pageEnd: row.sourcePageEnd ?? null,
                  quote: row.sourceQuote ?? null,
                });
              }
            }}
            onSaved={afterSave}
          />
        </LegacyFrame>
      )}
      {source && (
        <LegacyFrame>
          <SourceViewer {...source} onClose={() => setSource(null)} />
        </LegacyFrame>
      )}
    </>
  );
}

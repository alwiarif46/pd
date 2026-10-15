import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isAbortError, type ScheduleActivityDto } from '@/api';
import { RowDetail } from '@/components/RowDetail';
import { SourceViewer } from '@/components/SourceViewer';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { ActivityDraft, DateChangeMode, ScheduleDateChange, ScheduleExportFormat, ScheduleTemplateId } from '@/types';
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

/** A date change waiting for an answer, tied to the bid it was opened on. */
interface PendingChange {
  bidId: string;
  change: ScheduleDateChange;
}

const defaultNow = () => new Date();
const TEMPLATES = templateOptions();
const LOADING: LoadState = { kind: 'loading' };
const NO_DTOS: ScheduleActivityDto[] = [];
const asTimestamp =(day: string) => `${day}T00:00:00.000Z`;

/** The Schedule tab (05 s3.2): loads the bid's activities, renders the src/schedule port, and wires its actions. */
export function ScheduleContainer({ bidId, selectedRowId, api = scheduleApi, exporter = scheduleExporter, now = defaultNow }: Props) {
  const shell = useRequiredShell();
  const [today] = useState(() => localToday(now()));
  const [load, setLoad] = useState<{ bidId: string; state: LoadState } | null>(null);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [dateBusy, setDateBusy] = useState(false);
  const busyRef = useRef(false);
  /** What earlier tries of the open date change already wrote (controller.ts DateChangeProgress). */
  const progressRef = useRef<{ change: ScheduleDateChange; progress: DateChangeProgress } | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  /** The bid whose schedule is on screen (set when a load succeeds). */
  const shownRef = useRef<string | null>(null);
  const jobKey = jobsKey({ jobs: shell.jobs });

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
  const dateChange = pending?.bidId === bidId ? pending.change : null;
  const bid = shell.bid;
  const startDate = dayOf(bid?.startDate ?? null);
  const dueDate = dayOf(bid?.dueDate ?? null);
  const dueLabel = dueLabelOf(bid);

  const activities = useMemo(() => {
    const ids = new Set(dtos.map((d) => d.id));
    return sortActivities(dtos.map((d) => toScheduleActivity(d, ids)));
  }, [dtos]);
  const holidays = useMemo(() => holidaysFor({ today, startDate, dueDate, activities }), [today, startDate, dueDate, activities]);
  const hasAiRows = activities.some((a) => a.origin === 'ai');
  const summary = useMemo(
    () => (dateChange ? dateChangeSummary(activities, dateChange, { anchor: startDate, workdaysOnly }) : null),
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

  const onMoveActivity = (id: string, start: string, end: string) => {
    const dto = dtos.find((d) => d.id === id);
    if (!dto || dto.locked) return;
    setReady((ready) => ({
      ...ready,
      activities: ready.activities.map((d) => (d.id === id ? { ...d, startDate: asTimestamp(start), endDate: asTimestamp(end) } : d)),
    }));
    mutate(() => api.updateRow(bidId, 'schedule_activities', id, { startDate: start, endDate: end }));
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
    if (next === dueDate) return;
    progressRef.current = null;
    setPending({ bidId, change: { previousDue: dueDate, nextDue: next, amendmentNo: null, sourcePage: null, sourceQuote: null } });
  };

  // OPUS STEP: two writes to shared bid state (due date, then the schedule). resolveDateChange re-reads
  // the bid and the schedule on every try, and progressRef carries what earlier tries wrote, so a retry
  // after a lost response neither skips the due date nor moves the schedule twice.
  const onResolveDateChange = async (mode: DateChangeMode) => {
    if (busyRef.current || !pending || pending.bidId !== bidId) return;
    const record = pending;
    const prior = progressRef.current?.change === record.change ? progressRef.current.progress : NO_PROGRESS;
    busyRef.current = true;
    setDateBusy(true);
    const close = () => setPending((p) => (p === record ? null : p));
    try {
      const outcome = await resolveDateChange(api, record.bidId, record.change, mode, prior);
      switch (outcome.kind) {
        case 'done':
          progressRef.current = null;
          toast.success(doneMessage(outcome.result));
          close();
          break;
        case 'stale':
        case 'check':
          progressRef.current = null;
          toast.error(outcome.message);
          close();
          break;
        case 'adjust_failed':
        case 'failed':
          progressRef.current = { change: record.change, progress: outcome.progress };
          toast.error(outcome.message);
          break;
      }
    } finally {
      busyRef.current = false;
      setDateBusy(false);
      reload();
      shell.refresh();
    }
  };

  const onCancelDateChange = () => {
    progressRef.current = null;
    setPending(null);
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
        onAddActivity={(d: ActivityDraft) => mutate(() => api.createTabRow(bidId, 'schedule', toCreateBody(d)))}
        onEditActivity={(id, p) => mutate(() => api.updateRow(bidId, 'schedule_activities', id, toRowPatch(p)))}
        onDeleteActivity={(id) => mutate(() => api.deleteRow(bidId, 'schedule_activities', id))}
        onMoveActivity={onMoveActivity}
        onToggleLock={(id, locked) => mutate(() => api.updateRow(bidId, 'schedule_activities', id, { locked }))}
        onApplyTemplate={onApplyTemplate}
        onSetWorkdaysOnly={onSetWorkdaysOnly}
        onResolveDateChange={(mode) => void onResolveDateChange(mode)}
        onCancelDateChange={onCancelDateChange}
        onChangeDueDate={onChangeDueDate}
        onOpenRow={(id) => shell.openRow(id)}
        onOpenSource={onOpenSource}
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

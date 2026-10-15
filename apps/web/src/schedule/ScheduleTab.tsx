import { useMemo, useState } from 'react';
import { addIsoDays, countWorkdays, diffIsoDays } from '@pd/core/schedule';
import { Download, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ActivityDraft, ScheduleActivity, ScheduleTabProps, ScheduleTemplateId, ScheduleView } from '@/types';
import { EmptyState } from '@/ui/common/EmptyState';
import { SourceLink } from '@/ui/common/SourceLink';
import { ActivityPanel } from './ActivityPanel';
import { DateChangePrompt } from './DateChangePrompt';
import { DueDateDialog } from './DueDateDialog';
import { formatRange, monthOf } from './format';
import { EXPORT_OPTIONS } from './labels';
import { MilestoneList } from './MilestoneList';
import { ScheduleCalendar } from './ScheduleCalendar';
import { TemplateConfirm } from './TemplateConfirm';

type Panel = { mode: 'add' } | { mode: 'edit'; id: string } | null;

/** Only the fields that differ from the activity, as the edit patch. */
function draftDiff(activity: ScheduleActivity, draft: ActivityDraft): Partial<ActivityDraft> {
  const patch: Partial<ActivityDraft> = {};
  if (draft.label !== activity.label) patch.label = draft.label;
  if (draft.kind !== activity.kind) patch.kind = draft.kind;
  if (draft.reviewColor !== activity.reviewColor) patch.reviewColor = draft.reviewColor;
  if (draft.start !== activity.start) patch.start = draft.start;
  if (draft.end !== (activity.end ?? null)) patch.end = draft.end;
  if (draft.owner !== activity.owner) patch.owner = draft.owner;
  if (draft.locked !== activity.locked) patch.locked = draft.locked;
  return patch;
}

function Countdown({ today, dueDate }: { today: string; dueDate: string }) {
  const d = diffIsoDays(today, dueDate);
  if (d < 0) {
    return <p className="text-sm text-due">{`The due date passed ${-d} ${-d === 1 ? 'day' : 'days'} ago`}</p>;
  }
  if (d === 0) return <p className="text-lg font-semibold text-due">Due today</p>;
  const w = countWorkdays(addIsoDays(today, 1), dueDate, { workdaysOnly: true });
  return (
    <div>
      <p>
        <span className="font-numeric text-2xl tabular-nums">{w}</span>
        {` ${w === 1 ? 'workday' : 'workdays'} left`}
      </p>
      <p className="text-sm text-muted-foreground">{`${d} calendar ${d === 1 ? 'day' : 'days'}`}</p>
    </div>
  );
}

export function ScheduleTab(p: ScheduleTabProps) {
  const [view, setView] = useState<ScheduleView>('calendar');
  const [month, setMonth] = useState(() => {
    const selected = p.activities.find((a) => a.id === p.selectedRowId);
    return monthOf(selected?.start ?? p.today);
  });
  const [panel, setPanel] = useState<Panel>(null);
  const [templateId, setTemplateId] = useState<ScheduleTemplateId | ''>(p.templates[0]?.id ?? '');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);

  const holidays = useMemo(() => new Map(p.holidays.map((h) => [h.date, h.name])), [p.holidays]);
  const template = p.templates.find((t) => t.id === templateId) ?? null;
  const templateCount = p.activities.filter((a) => a.origin === 'template' && !a.locked).length;
  const userCount = p.activities.filter((a) => a.origin === 'user' && !a.locked).length;
  const aiRows = p.activities.filter((a) => a.origin === 'ai');
  const editing = panel?.mode === 'edit' ? (p.activities.find((a) => a.id === panel.id) ?? null) : null;

  const openAdd = () => setPanel({ mode: 'add' });
  const selectActivity = (id: string) => setPanel({ mode: 'edit', id });

  const submitPanel = (draft: ActivityDraft) => {
    if (editing) {
      const patch = draftDiff(editing, draft);
      if (Object.keys(patch).length > 0) p.onEditActivity(editing.id, patch);
    } else {
      p.onAddActivity(draft);
    }
    setPanel(null);
  };

  return (
    <section aria-labelledby="schedule-title" className="flex flex-col gap-4 text-ink">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 id="schedule-title" className="text-xl font-semibold">
            Schedule
          </h1>
          <p className="text-sm text-muted-foreground">{p.dueLabel ? `Due ${p.dueLabel}` : 'No due date yet'}</p>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setDueOpen(true)}>
              {p.dueDate ? 'Change due date' : 'Set due date'}
            </Button>
          </div>
        </div>
        {p.dueDate && <Countdown today={p.today} dueDate={p.dueDate} />}
      </header>

      <Tabs value={view} onValueChange={(v) => setView(v as ScheduleView)} className="gap-4">
        <div role="toolbar" aria-label="Schedule tools" className="flex flex-wrap items-end gap-4">
          <TabsList>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
            <TabsTrigger value="list">Milestones</TabsTrigger>
          </TabsList>
          <div className="grid gap-1">
            <Label htmlFor="schedule-template">Template</Label>
            <div className="flex items-center gap-2">
              <Select value={templateId} onValueChange={(v) => setTemplateId(v as ScheduleTemplateId)}>
                <SelectTrigger id="schedule-template" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {p.templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                disabled={p.dueDate === null || template === null}
                onClick={() => setConfirmOpen(true)}
              >
                Apply template
              </Button>
            </div>
            {p.dueDate === null && (
              <p className="text-sm text-muted-foreground">Set the due date first. Templates count back from it.</p>
            )}
          </div>
          <div className="flex items-start gap-2">
            <Switch
              id="schedule-workdays"
              checked={p.workdaysOnly}
              onCheckedChange={p.onSetWorkdaysOnly}
              aria-describedby="schedule-workdays-help"
            />
            <div className="grid gap-1">
              <Label htmlFor="schedule-workdays">Workdays only</Label>
              <p id="schedule-workdays-help" className="max-w-56 text-sm text-muted-foreground">
                Shift, scale, and templates skip weekends and US federal holidays.
              </p>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline">
                <Download />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {EXPORT_OPTIONS.map((option) => (
                <DropdownMenuItem key={option.format} onSelect={() => p.onExport(option.format)}>
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" onClick={openAdd}>
            <Plus />
            Add activity
          </Button>
        </div>

        {p.activities.length === 0 ? (
          <EmptyState
            title="No items found"
            text="No dates were found in the solicitation yet. Apply a template or add an activity by hand."
            action={{ label: 'Add activity', onClick: openAdd }}
          />
        ) : (
          <>
            <TabsContent value="calendar" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
              <ScheduleCalendar
                activities={p.activities}
                holidays={holidays}
                today={p.today}
                dueDate={p.dueDate}
                month={month}
                selectedRowId={p.selectedRowId}
                onMonthChange={setMonth}
                onSelect={selectActivity}
                onMove={p.onMoveActivity}
              />
              {aiRows.length > 0 && (
                <aside aria-labelledby="schedule-ai-title" className="grid content-start gap-2">
                  <h2 id="schedule-ai-title" className="text-sm font-semibold">
                    Dates from the solicitation
                  </h2>
                  <ul className="grid gap-2 text-sm">
                    {aiRows.map((a) => (
                      <li key={a.id} className="grid gap-0.5 border-b border-line pb-2">
                        <span className="font-medium">{a.label}</span>
                        <span className="font-numeric text-muted-foreground">
                          {a.start ? formatRange(a.start, a.end) : 'No date'}
                        </span>
                        <SourceLink
                          page={a.sourcePage}
                          pageEnd={a.sourcePageEnd}
                          rowLabel={a.label}
                          onOpen={() => p.onOpenSource(a.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </aside>
              )}
            </TabsContent>
            <TabsContent value="list">
              <MilestoneList
                activities={p.activities}
                today={p.today}
                workdaysOnly={p.workdaysOnly}
                selectedRowId={p.selectedRowId}
                onSelect={selectActivity}
                onOpenRow={p.onOpenRow}
                onToggleLock={p.onToggleLock}
                onOpenSource={p.onOpenSource}
              />
            </TabsContent>
          </>
        )}
      </Tabs>

      {panel && (
        <ActivityPanel
          key={editing?.id ?? 'new'}
          open
          activity={editing}
          activityOptions={p.activityOptions}
          defaultStart={null}
          workdaysOnly={p.workdaysOnly}
          onSubmit={submitPanel}
          onDelete={
            editing
              ? () => {
                  p.onDeleteActivity(editing.id);
                  setPanel(null);
                }
              : null
          }
          onOpenSource={editing ? () => p.onOpenSource(editing.id) : null}
          onClose={() => setPanel(null)}
        />
      )}

      <TemplateConfirm
        open={confirmOpen}
        template={template}
        dueDate={p.dueDate}
        templateCount={templateCount}
        userCount={userCount}
        onApply={(replace) => {
          setConfirmOpen(false);
          if (template) p.onApplyTemplate(template.id, replace);
        }}
        onCancel={() => setConfirmOpen(false)}
      />

      <DueDateDialog
        open={dueOpen}
        dueDate={p.dueDate}
        onSubmit={(next) => {
          setDueOpen(false);
          p.onChangeDueDate(next);
        }}
        onCancel={() => setDueOpen(false)}
      />

      {p.dateChange && (
        <DateChangePrompt
          open
          previousDue={p.dateChange.previousDue}
          nextDue={p.dateChange.nextDue}
          amendmentNo={p.dateChange.amendmentNo}
          summary={p.dateChangeSummary}
          workdaysOnly={p.workdaysOnly}
          busy={p.dateChangeBusy}
          onChoose={p.onResolveDateChange}
          onCancel={p.onCancelDateChange}
        />
      )}
    </section>
  );
}

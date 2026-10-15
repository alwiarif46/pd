// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SCHEDULE_TEMPLATES } from '@pd/core/schedule';
import { scheduleActivity } from '@/test/fixtures';
import type { ScheduleActivity, ScheduleTabProps, ScheduleTemplateOption } from '@/types';
import { ScheduleTab } from './ScheduleTab';

const TEMPLATES: ScheduleTemplateOption[] = SCHEDULE_TEMPLATES.map((t) => ({
  id: t.id as ScheduleTemplateOption['id'],
  name: t.name,
  description: t.description,
}));
const STANDARD = TEMPLATES[0]!;

function renderTab(over: Partial<ScheduleTabProps> = {}) {
  const props: ScheduleTabProps = {
    activities: [],
    holidays: [{ date: '2026-11-26', name: 'Thanksgiving Day' }],
    templates: TEMPLATES,
    activityOptions: ['First draft writing', 'Kickoff meeting', 'Pink team review'],
    today: '2026-11-20',
    startDate: null,
    dueDate: '2026-11-25',
    dueLabel: 'Wed, Nov 25, 2026 at 5:00 PM',
    workdaysOnly: true,
    selectedRowId: null,
    dateChange: null,
    dateChangeSummary: null,
    dateChangeBusy: false,
    onAddActivity: vi.fn(),
    onEditActivity: vi.fn(),
    onDeleteActivity: vi.fn(),
    onMoveActivity: vi.fn(),
    onToggleLock: vi.fn(),
    onApplyTemplate: vi.fn(),
    onSetWorkdaysOnly: vi.fn(),
    onResolveDateChange: vi.fn(),
    onCancelDateChange: vi.fn(),
    onChangeDueDate: vi.fn(),
    onOpenRow: vi.fn(),
    onOpenSource: vi.fn(),
    onExport: vi.fn(),
    ...over,
  };
  const user = userEvent.setup();
  const view = render(<ScheduleTab {...props} />);
  return { props, user, ...view };
}

const aiRow = scheduleActivity({
  id: 'act-ai',
  label: 'Proposal due',
  kind: 'submission',
  origin: 'ai',
  start: '2026-11-25',
  end: '2026-11-25',
  sourcePage: 12,
  sourceQuote: 'Proposals are due on November 25.',
});
const userRow = scheduleActivity({ id: 'act-1', label: 'First draft writing', origin: 'user' });
const userRow2 = scheduleActivity({ id: 'act-2', label: 'Pricing', origin: 'user', start: '2026-11-19', end: '2026-11-19' });
const templateRow = scheduleActivity({ id: 'act-t', label: 'Kickoff meeting', kind: 'milestone', origin: 'template', start: '2026-11-17', end: '2026-11-17' });

const bar = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-activity="${id}"]`)!;
const cell = (container: HTMLElement, day: string) => container.querySelector<HTMLElement>(`[data-date="${day}"]`)!;

async function openMilestones(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'Milestones' }));
}

describe('empty schedule', () => {
  it('shows the empty state and opens the add panel', async () => {
    const { user } = renderTab();
    expect(screen.getByText('No items found')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Add activity' })[0]!);
    expect(screen.getByText('New activity')).toBeTruthy();
  });
});

describe('template picker', () => {
  it('confirms a plain apply when nothing would be removed', async () => {
    const { user, props } = renderTab({ activities: [aiRow] });
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    expect(screen.getByText('Apply Federal standard (Pink, Red, Gold)?')).toBeTruthy();
    expect(
      screen.getByText(`${STANDARD.description} Its activities count back from the due date, Wed, Nov 25, 2026.`),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    expect(props.onApplyTemplate).toHaveBeenCalledWith('federal-standard', false);
  });

  it('warns that hand-added activities go too when replacing template activities', async () => {
    const { user, props } = renderTab({ activities: [aiRow, templateRow, userRow, userRow2] });
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Replace activities with Federal standard (Pink, Red, Gold)?')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'Hand-added activities are removed too and cannot be restored. Lock an activity first to keep it.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/1 from a template and 2 added by hand/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(props.onApplyTemplate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    await user.click(screen.getByRole('button', { name: 'Replace activities' }));
    expect(props.onApplyTemplate).toHaveBeenCalledWith('federal-standard', true);
  });

  it('offers to add beside hand-added activities, or replace them', async () => {
    const { user, props } = renderTab({ activities: [aiRow, userRow] });
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Hand-added activities are removed too and cannot be restored/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Add beside them' }));
    expect(props.onApplyTemplate).toHaveBeenLastCalledWith('federal-standard', false);
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    await user.click(screen.getByRole('button', { name: 'Replace activities' }));
    expect(props.onApplyTemplate).toHaveBeenLastCalledWith('federal-standard', true);
  });

  it('is disabled without a due date', () => {
    renderTab({ dueDate: null, dueLabel: null, activities: [aiRow] });
    expect((screen.getByRole('button', { name: 'Apply template' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Set the due date first. Templates count back from it.')).toBeTruthy();
    expect(screen.getByText('No due date yet')).toBeTruthy();
  });
});

describe('toolbar', () => {
  it('turns Workdays only off', async () => {
    const { user, props } = renderTab({ activities: [aiRow] });
    await user.click(screen.getByRole('switch', { name: 'Workdays only' }));
    expect(props.onSetWorkdaysOnly).toHaveBeenCalledWith(false);
  });

  it('exports in each format', async () => {
    const { user, props } = renderTab({ activities: [aiRow] });
    const pairs: [string, string][] = [
      ['Excel workbook (.xlsx)', 'xlsx'],
      ['Calendar file (.ics)', 'ics'],
      ['Spreadsheet (.csv)', 'csv'],
      ['Print', 'print'],
    ];
    for (const [label, format] of pairs) {
      await user.click(screen.getByRole('button', { name: 'Export' }));
      await user.click(screen.getByRole('menuitem', { name: label }));
      expect(props.onExport).toHaveBeenLastCalledWith(format);
    }
  });

  it('asks for a new due date', async () => {
    const { user, props } = renderTab({ activities: [aiRow] });
    await user.click(screen.getByRole('button', { name: 'Change due date' }));
    const input = screen.getByLabelText('New due date') as HTMLInputElement;
    expect(input.value).toBe('2026-11-25');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '2026-11-30' } });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(props.onChangeDueDate).toHaveBeenCalledWith('2026-11-30');
  });

  it('offers Set due date without one', () => {
    renderTab({ dueDate: null, dueLabel: null, activities: [aiRow] });
    expect(screen.getByRole('button', { name: 'Set due date' })).toBeTruthy();
  });
});

describe('countdown', () => {
  it('counts workdays and calendar days', () => {
    renderTab({ activities: [aiRow] });
    expect(screen.getByText(/workdays left/).parentElement?.textContent).toContain('3 workdays left');
    expect(screen.getByText('5 calendar days')).toBeTruthy();
  });

  it('says Due today', () => {
    renderTab({ activities: [aiRow], today: '2026-11-25' });
    expect(screen.getByText('Due today')).toBeTruthy();
  });

  it('says how long ago the date passed', () => {
    renderTab({ activities: [aiRow], today: '2026-11-27' });
    expect(screen.getByText('The due date passed 2 days ago')).toBeTruthy();
  });
});

describe('milestone list', () => {
  it('shows a source control on AI rows and the origin of the others', async () => {
    const { user, props } = renderTab({ activities: [aiRow, userRow, templateRow] });
    await openMilestones(user);
    await user.click(screen.getByRole('button', { name: 'Open source for Proposal due, page 12' }));
    expect(props.onOpenSource).toHaveBeenCalledWith('act-ai');
    expect(screen.getByText('Added by user')).toBeTruthy();
    expect(screen.getByText('From template')).toBeTruthy();
  });

  it('locks, opens details, and marks the selected row', async () => {
    const { user, props, container } = renderTab({ activities: [userRow], selectedRowId: 'act-1' });
    await openMilestones(user);
    await user.click(screen.getByRole('checkbox', { name: 'Lock First draft writing' }));
    expect(props.onToggleLock).toHaveBeenCalledWith('act-1', true);
    await user.click(screen.getByRole('button', { name: 'Details for First draft writing' }));
    expect(props.onOpenRow).toHaveBeenCalledWith('act-1');
    expect(container.querySelector('[data-row="act-1"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('says so when an amendment superseded a row', async () => {
    const superseded = scheduleActivity({ id: 'act-s', label: 'Old date', amendment: { kind: 'superseded', amendmentNo: 2, replacedById: null } });
    const { user } = renderTab({ activities: [superseded] });
    await openMilestones(user);
    expect(screen.getByText('Superseded by Amd 2')).toBeTruthy();
  });

  it('counts days when workdays only is off', async () => {
    const { user } = renderTab({ activities: [userRow], workdaysOnly: false });
    await openMilestones(user);
    expect(screen.getByRole('columnheader', { name: 'Days' })).toBeTruthy();
  });
});

describe('calendar', () => {
  it('lists the dates from the solicitation with their source link', async () => {
    const { user, props } = renderTab({ activities: [aiRow, userRow] });
    expect(screen.getByText('Dates from the solicitation')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open source for Proposal due, page 12' }));
    expect(props.onOpenSource).toHaveBeenCalledWith('act-ai');
  });

  it('moves an activity by dragging it to another day', () => {
    const { props, container } = renderTab({ activities: [userRow] });
    const data = { setData: vi.fn(), getData: vi.fn(() => 'act-1') };
    fireEvent.dragStart(bar(container, 'act-1'), { dataTransfer: data });
    fireEvent.dragOver(cell(container, '2026-11-19'), { dataTransfer: data });
    fireEvent.drop(cell(container, '2026-11-19'), { dataTransfer: data });
    expect(props.onMoveActivity).toHaveBeenCalledWith('act-1', '2026-11-19', '2026-11-21');
  });

  it('moves a day, or a week with Shift, from the keyboard', async () => {
    const { user, props, container } = renderTab({ activities: [userRow] });
    bar(container, 'act-1').focus();
    await user.keyboard('{ArrowRight}');
    expect(props.onMoveActivity).toHaveBeenLastCalledWith('act-1', '2026-11-17', '2026-11-19');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(props.onMoveActivity).toHaveBeenLastCalledWith('act-1', '2026-11-23', '2026-11-25');
  });

  it('does not move a locked activity', async () => {
    const locked = scheduleActivity({ locked: true });
    const { user, props, container } = renderTab({ activities: [locked] });
    expect(bar(container, 'act-1').getAttribute('draggable')).toBe('false');
    bar(container, 'act-1').focus();
    await user.keyboard('{ArrowRight}');
    expect(props.onMoveActivity).not.toHaveBeenCalled();
  });

  it('shows holidays and changes the month', async () => {
    const { user } = renderTab({ activities: [userRow] });
    expect(screen.getByText('Thanksgiving Day')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
  });

  it('lists undated activities below the grid', () => {
    renderTab({ activities: [userRow, scheduleActivity({ id: 'act-u', label: 'Orals prep', start: null, end: null })] });
    expect(screen.getByText('Not on the calendar yet (1)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Orals prep' })).toBeTruthy();
  });
});

describe('activity panel', () => {
  it('adds an activity with a custom name and dates', async () => {
    const { user, props } = renderTab({ activities: [userRow] });
    await user.click(screen.getByRole('button', { name: 'Add activity' }));
    await user.type(screen.getByLabelText('Custom activity name'), 'Pen test');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-12-03' } });
    expect(screen.getByText('3 workdays')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add activity' }));
    expect(props.onAddActivity).toHaveBeenCalledWith({
      label: 'Pen test',
      kind: 'writing',
      reviewColor: null,
      start: '2026-12-01',
      end: '2026-12-03',
      owner: null,
      locked: false,
    });
  });

  it('sets the kind from a standard name', async () => {
    const { user, props } = renderTab({ activities: [userRow] });
    await user.click(screen.getByRole('button', { name: 'Add activity' }));
    await user.click(screen.getByRole('combobox', { name: 'Activity' }));
    await user.click(screen.getByRole('option', { name: 'Pink team review' }));
    await user.click(screen.getByRole('button', { name: 'Add activity' }));
    expect(props.onAddActivity).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Pink team review', kind: 'review', reviewColor: 'pink' }),
    );
  });

  it('rejects an end date before the start date', async () => {
    const { user, props } = renderTab({ activities: [userRow] });
    await user.click(screen.getByRole('button', { name: 'Add activity' }));
    await user.type(screen.getByLabelText('Custom activity name'), 'Pen test');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-12-03' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-12-01' } });
    await user.click(screen.getByRole('button', { name: 'Add activity' }));
    expect(screen.getByRole('alert').textContent).toBe('The end date is before the start date.');
    expect(props.onAddActivity).not.toHaveBeenCalled();
  });

  it('asks for a name, and for a start date before an end date', async () => {
    const { user, props } = renderTab({ activities: [userRow] });
    await user.click(screen.getByRole('button', { name: 'Add activity' }));
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-12-01' } });
    await user.click(screen.getByRole('button', { name: 'Add activity' }));
    const messages = screen.getAllByRole('alert').map((node) => node.textContent);
    expect(messages).toEqual(['Enter an activity name.', 'Set a start date first.']);
    expect(props.onAddActivity).not.toHaveBeenCalled();
  });

  it('keeps the dates of a locked solicitation row until it is unlocked', async () => {
    const locked: ScheduleActivity = { ...aiRow, locked: true };
    const { user } = renderTab({ activities: [locked] });
    await user.click(screen.getByRole('button', { name: /^Proposal due,/ }));
    const start = screen.getByLabelText('Start date') as HTMLInputElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText('Unlock to change the dates.')).toBeTruthy();
    expect(screen.getByText('From the solicitation')).toBeTruthy();
    expect(screen.getByText('Proposals are due on November 25.')).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: 'Lock dates' }));
    expect(start.disabled).toBe(false);
  });

  it('sends only the changed fields when editing', async () => {
    const { user, props } = renderTab({ activities: [userRow] });
    await user.click(screen.getByRole('button', { name: /^First draft writing,/ }));
    await user.type(screen.getByLabelText('Owner'), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(props.onEditActivity).toHaveBeenCalledWith('act-1', { owner: 'Sam' });
  });

  it('sends nothing when nothing changed', async () => {
    const { user, props } = renderTab({ activities: [userRow] });
    await user.click(screen.getByRole('button', { name: /^First draft writing,/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(props.onEditActivity).not.toHaveBeenCalled();
    expect(screen.queryByText('Edit activity')).toBeNull();
  });

  it('deletes after a confirm', async () => {
    const { user, props } = renderTab({ activities: [userRow] });
    await user.click(screen.getByRole('button', { name: /^First draft writing,/ }));
    await user.click(screen.getByRole('button', { name: 'Delete activity' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Delete First draft writing?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete activity' }));
    expect(props.onDeleteActivity).toHaveBeenCalledWith('act-1');
  });
});

describe('date-change prompt', () => {
  it('shows while a change is waiting and answers through the callbacks', async () => {
    const { user, props } = renderTab({
      activities: [aiRow],
      dateChange: { previousDue: '2026-11-25', nextDue: '2026-12-02', amendmentNo: 2, sourcePage: null, sourceQuote: null },
    });
    expect(screen.getByText('Amendment 2 moved the due date')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Scale dates' }));
    expect(props.onResolveDateChange).toHaveBeenCalledWith('scale');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancelDateChange).toHaveBeenCalled();
  });
});

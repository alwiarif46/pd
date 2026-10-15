// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ApiError, type AdjustScheduleDto, type ScheduleActivityDto } from '@/api';
import { bidDto, docDto, jobDto, meDto, orgPayload, organizationDto, scheduleActivityDto } from '@/test/fixtures';
import { ShellContext, type ShellContextValue } from '@/features/shell/bid-context';
import type { ScheduleExporter } from '@/schedule/export';
import type { ScheduleApi } from './controller';
import { ScheduleContainer } from './ScheduleContainer';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

const ts = (day: string) => `${day}T00:00:00.000Z`;
const userRow = scheduleActivityDto();
const aiRow = scheduleActivityDto({
  id: 'act-ai',
  label: 'Proposal due',
  kind: 'submission',
  origin: 'ai',
  startDate: ts('2026-11-25'),
  endDate: null,
  sourcePage: 12,
  sourceQuote: 'Proposals are due on November 25.',
});
const adjusted: AdjustScheduleDto = {
  ok: true,
  requestedMode: 'shift',
  mode: 'shift',
  workdaysOnly: true,
  unit: 'workdays',
  delta: 4,
  moved: 1,
  moves: [],
};

function shellValue(over: Partial<ShellContextValue> = {}): ShellContextValue {
  return {
    me: meDto(),
    org: orgPayload({ org: organizationDto({ plan: 'starter' }) }),
    summary: { plan: 'starter', creditsLeft: 5, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 300 },
    bids: [bidDto()],
    bidId: 'bid-1',
    tab: 'schedule',
    bid: bidDto({ dueDate: ts('2026-11-25'), dueTime: '17:00' }),
    docs: [docDto()],
    jobs: [],
    links: [],
    bidLoaded: true,
    selectedRowId: null,
    refresh: vi.fn(),
    openRow: vi.fn(),
    openUpgrade: vi.fn(),
    confirm: vi.fn(async () => true),
    ...over,
  };
}

function mockApi(activities: ScheduleActivityDto[] = [userRow, aiRow], over: Partial<ScheduleApi> = {}): ScheduleApi {
  return {
    getTab: vi.fn(async () => ({ activities, workdaysOnly: true })) as unknown as ScheduleApi['getTab'],
    createTabRow: vi.fn(async () => userRow) as unknown as ScheduleApi['createTabRow'],
    updateRow: vi.fn(async () => userRow) as unknown as ScheduleApi['updateRow'],
    deleteRow: vi.fn(async () => ({ ok: true as const })),
    seedSchedule: vi.fn(async () => ({ ok: true as const, template: 'federal-standard' as const, added: 9, replaced: 2, activities })),
    adjustSchedule: vi.fn(async () => adjusted),
    getBid: vi.fn(async () => bidDto({ dueDate: ts('2026-11-25') })),
    updateBid: vi.fn(async () => bidDto()),
    ...over,
  };
}

function mockExporter(): ScheduleExporter {
  return { csv: vi.fn(), xlsx: vi.fn(), ics: vi.fn(), print: vi.fn() };
}

function renderContainer(opts: { api?: ScheduleApi; shell?: Partial<ShellContextValue>; exporter?: ScheduleExporter } = {}) {
  const api = opts.api ?? mockApi();
  const exporter = opts.exporter ?? mockExporter();
  const shell = shellValue(opts.shell);
  const user = userEvent.setup();
  const view = render(
    <ShellContext.Provider value={shell}>
      <ScheduleContainer
        bidId="bid-1"
        tab="schedule"
        selectedRowId={null}
        api={api}
        exporter={exporter}
        now={() => new Date(2026, 10, 20, 9)}
      />
    </ShellContext.Provider>,
  );
  return { api, exporter, shell, user, ...view };
}

const ready = () => screen.findByRole('heading', { name: 'Schedule', level: 1 });

async function changeDueTo(user: ReturnType<typeof userEvent.setup>, day: string) {
  await user.click(screen.getByRole('button', { name: 'Change due date' }));
  fireEvent.change(screen.getByLabelText('New due date'), { target: { value: day } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('ScheduleContainer: loading and tab states', () => {
  it('loads and shows the activities', async () => {
    const { api } = renderContainer();
    await ready();
    expect(api.getTab).toHaveBeenCalledWith('bid-1', 'schedule', expect.anything());
    expect(screen.getByText('Dates from the solicitation')).toBeTruthy();
    expect(screen.getByText('Due Wed, Nov 25, 2026 at 5:00 PM (America/New_York)')).toBeTruthy();
  });

  it('shows the no solicitation state without the schedule', async () => {
    renderContainer({ shell: { docs: [] } });
    expect(await screen.findByText('No solicitation yet')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Schedule', level: 1 })).toBeNull();
  });

  it('shows out of credits', async () => {
    renderContainer({
      shell: { bid: bidDto({ creditStatus: null }), summary: { plan: 'starter', creditsLeft: 0, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 300 } },
    });
    expect(await screen.findByText('You are out of RFP credits')).toBeTruthy();
  });

  it('blocks on a failed dates step', async () => {
    renderContainer({ shell: { jobs: [jobDto({ type: 'ai:dates', status: 'failed' })] } });
    expect(await screen.findByText('This step did not finish')).toBeTruthy();
  });

  it('shows processing with the schedule', async () => {
    renderContainer({ shell: { jobs: [jobDto({ type: 'ai:dates', status: 'running', progress: 40 })] } });
    await ready();
    expect(screen.getByRole('heading', { name: 'Processing' })).toBeTruthy();
  });

  it('is not locked on Free', async () => {
    renderContainer({ shell: { summary: { plan: 'free', creditsLeft: 1, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 50 } } });
    await ready();
  });

  it('shows the empty state', async () => {
    renderContainer({ api: mockApi([]) });
    expect(await screen.findByText('No items found')).toBeTruthy();
  });

  it('shows a load error and tries again', async () => {
    const api = mockApi();
    vi.mocked(api.getTab).mockRejectedValueOnce(new ApiError('Could not load.', 500));
    const { user } = renderContainer({ api });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not load.')).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await ready();
    expect(api.getTab).toHaveBeenCalledTimes(2);
  });

  it('keeps the loaded schedule when a reload fails', async () => {
    const api = mockApi();
    const { user } = renderContainer({ api });
    await ready();
    vi.mocked(api.getTab).mockRejectedValueOnce(new ApiError('Could not load.', 500));
    await user.click(screen.getByRole('tab', { name: 'Milestones' }));
    await user.click(screen.getByRole('checkbox', { name: 'Lock First draft writing' }));
    expect(api.updateRow).toHaveBeenCalledWith('bid-1', 'schedule_activities', 'act-1', { locked: true });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load.'));
    expect(screen.getByRole('heading', { name: 'Schedule', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ScheduleContainer: actions', () => {
  it('reports template refusals as given', async () => {
    const api = mockApi([userRow]);
    vi.mocked(api.seedSchedule)
      .mockRejectedValueOnce(new ApiError('This schedule already has template activities.', 409, 'schedule_template_exists'))
      .mockRejectedValueOnce(new ApiError('Set the due date in Bid settings first.', 409, 'due_date_required'));
    const { user } = renderContainer({ api });
    await ready();
    for (const message of ['This schedule already has template activities.', 'Set the due date in Bid settings first.']) {
      await user.click(screen.getByRole('button', { name: 'Apply template' }));
      await user.click(await screen.findByRole('button', { name: 'Add beside them' }));
      await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith(message));
    }
  });

  it('replaces activities with a template, then refreshes the shell', async () => {
    const template = scheduleActivityDto({ id: 'act-t', origin: 'template', label: 'Pink team review' });
    const { api, shell, user } = renderContainer({ api: mockApi([template, userRow]) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    await user.click(await screen.findByRole('button', { name: 'Replace activities' }));
    await waitFor(() => expect(shell.refresh).toHaveBeenCalled());
    expect(api.seedSchedule).toHaveBeenCalledWith('bid-1', { template: 'federal-standard', replace: true });
    expect(toast.success).toHaveBeenCalledWith('Added 9 activities, removed 2.');
  });

  it('saves Workdays only, and reverts the switch when it fails', async () => {
    const api = mockApi();
    vi.mocked(api.updateBid).mockRejectedValueOnce(new ApiError('No.', 500));
    const { user } = renderContainer({ api });
    await ready();
    const toggle = screen.getByRole('switch', { name: 'Workdays only' });
    await user.click(toggle);
    expect(api.updateBid).toHaveBeenCalledWith('bid-1', { scheduleWorkdaysOnly: false });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(toast.error).toHaveBeenCalledWith('No.');
  });

  it('moves an activity by drag, and reloads after a lock refusal', async () => {
    const api = mockApi([userRow]);
    vi.mocked(api.updateRow).mockRejectedValueOnce(new ApiError('This activity is locked.', 409, 'activity_locked'));
    const { container } = renderContainer({ api });
    await ready();
    const data = { setData: vi.fn(), getData: vi.fn(() => 'act-1') };
    const bar = container.querySelector('[data-activity="act-1"]') as HTMLElement;
    const cell = container.querySelector('[data-date="2026-11-19"]') as HTMLElement;
    fireEvent.dragStart(bar, { dataTransfer: data });
    fireEvent.dragOver(cell, { dataTransfer: data });
    fireEvent.drop(cell, { dataTransfer: data });
    expect(api.updateRow).toHaveBeenCalledWith('bid-1', 'schedule_activities', 'act-1', {
      startDate: '2026-11-19',
      endDate: '2026-11-21',
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This activity is locked.'));
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });

  it('exports with the bid name', async () => {
    const { exporter, user } = renderContainer();
    await ready();
    const pick = async (label: string) => {
      await user.click(screen.getByRole('button', { name: 'Export' }));
      await user.click(await screen.findByRole('menuitem', { name: label }));
    };
    await pick('Excel workbook (.xlsx)');
    const [name, rows] = vi.mocked(exporter.xlsx).mock.calls[0]!;
    expect(name).toBe('va-ehr-support-schedule.xlsx');
    expect(rows[0]?.[0]).toBe('Activity');
    await pick('Calendar file (.ics)');
    expect(vi.mocked(exporter.ics).mock.calls[0]?.[1]).toContain('BEGIN:VCALENDAR');
    await pick('Print');
    expect(vi.mocked(exporter.print).mock.calls[0]?.[0]).toContain('Wed, Nov 25, 2026 at 5:00 PM (America/New_York)');
  });

  it('says when an AI row has no source page', async () => {
    const noDoc = scheduleActivityDto({ ...aiRow, documentId: null });
    const { user } = renderContainer({ api: mockApi([noDoc]) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Open source for Proposal due, page 12' }));
    expect(toast.info).toHaveBeenCalledWith('No source page for this activity.');
  });
});

describe('ScheduleContainer: due date change', () => {
  it('shows the prompt with the summary and shifts: bid, due date, schedule, in order', async () => {
    const { api, shell, user } = renderContainer();
    await ready();
    await changeDueTo(user, '2026-12-02');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Moves 2 unlocked activities 4 workdays later.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Shift dates' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0]!;
    expect(order(api.getBid)).toBeLessThan(order(api.updateBid));
    expect(order(api.updateBid)).toBeLessThan(order(api.adjustSchedule));
    expect(api.updateBid).toHaveBeenCalledWith('bid-1', { dueDate: '2026-12-02' });
    expect(api.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'shift', previousDue: '2026-11-25', nextDue: '2026-12-02' });
    expect(toast.success).toHaveBeenCalledWith('Moved 1 activity.');
    expect(shell.refresh).toHaveBeenCalled();
  });

  it('saves nothing on Cancel', async () => {
    const { api, user } = renderContainer();
    await ready();
    await changeDueTo(user, '2026-12-02');
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.getBid).not.toHaveBeenCalled();
    expect(api.updateBid).not.toHaveBeenCalled();
    expect(api.adjustSchedule).not.toHaveBeenCalled();
  });

  it('keeps the prompt open when the adjust fails, and the retry does not save the due date again', async () => {
    const api = mockApi();
    vi.mocked(api.adjustSchedule).mockRejectedValueOnce(new ApiError('Bad date.', 400, 'invalid_date'));
    const { user } = renderContainer({ api });
    await ready();
    await changeDueTo(user, '2026-12-02');
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Shift dates' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('The new due date is saved, but the schedule did not move. Bad date.'),
    );
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Shift dates' }) as HTMLButtonElement).disabled).toBe(false));

    // The server now has the next date: the retry adjusts without a second PATCH.
    vi.mocked(api.getBid).mockResolvedValue(bidDto({ dueDate: ts('2026-12-02') }));
    await user.click(within(dialog).getByRole('button', { name: 'Shift dates' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.updateBid).toHaveBeenCalledTimes(1);
    expect(api.adjustSchedule).toHaveBeenCalledTimes(2);
  });

  it('does not adjust twice when a lost adjust response was applied', async () => {
    const api = mockApi([userRow]);
    vi.mocked(api.adjustSchedule).mockRejectedValueOnce(new ApiError('The API is not reachable', 0));
    const { user } = renderContainer({ api });
    await ready();
    await changeDueTo(user, '2026-12-02');
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Shift dates' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));

    vi.mocked(api.getBid).mockResolvedValue(bidDto({ dueDate: ts('2026-12-02') }));
    vi.mocked(api.getTab).mockResolvedValue({
      activities: [scheduleActivityDto({ startDate: ts('2026-11-20'), endDate: ts('2026-11-24') })],
      workdaysOnly: true,
    } as never);
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Shift dates' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(dialog).getByRole('button', { name: 'Shift dates' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenLastCalledWith(expect.stringContaining('may already have moved'));
  });

  it('warns about a move of 0 workdays', async () => {
    const { user } = renderContainer({ shell: { bid: bidDto({ dueDate: ts('2026-11-27') }) } });
    await ready();
    await changeDueTo(user, '2026-11-28');
    expect(await screen.findByText(/That is 0 workdays/)).toBeTruthy();
  });

  it('sets a missing due date at once, with no prompt', async () => {
    const { api, user } = renderContainer({ shell: { bid: bidDto({ dueDate: null }) } });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Set due date' }));
    fireEvent.change(screen.getByLabelText('New due date'), { target: { value: '2026-12-02' } });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.updateBid).toHaveBeenCalledWith('bid-1', { dueDate: '2026-12-02' }));
    expect(api.adjustSchedule).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Due date set.');
  });
});

// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ApiError, type AdjustScheduleDto, type PendingDateChangeDto, type ScheduleActivityDto } from '@/api';
import { mockFetch } from '@/test/fetch';
import { bidDto, docDto, jobDto, meDto, orgPayload, organizationDto, scheduleActivityDto, tabProposalDto } from '@/test/fixtures';
import { NEW_ROW_MISSING_MESSAGE, ROW_ALREADY_CLOSED_MESSAGE } from '@/features/proposals/controller';
import { ShellContext, type ShellContextValue } from '@/features/shell/bid-context';
import type { ScheduleExporter } from '@/schedule/export';
import { AMENDMENT_GONE_MESSAGE, type ScheduleApi } from './controller';
import { ScheduleContainer } from './ScheduleContainer';
import { useUserDateChange, type UserDateChangeApi } from './use-user-date-change';

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
    getTab: vi.fn(async () => ({ activities, workdaysOnly: true, proposals: [], pendingDateChange: null })) as unknown as ScheduleApi['getTab'],
    createTabRow: vi.fn(async () => userRow) as unknown as ScheduleApi['createTabRow'],
    updateRow: vi.fn(async () => userRow) as unknown as ScheduleApi['updateRow'],
    deleteRow: vi.fn(async () => ({ ok: true as const })),
    seedSchedule: vi.fn(async () => ({ ok: true as const, template: 'federal-standard' as const, added: 9, replaced: 2, activities })),
    adjustSchedule: vi.fn(async () => adjusted),
    getBid: vi.fn(async () => bidDto({ dueDate: ts('2026-11-25') })),
    updateBid: vi.fn(async () => bidDto()),
    confirmAmendmentLink: vi.fn(async () => ({ ok: true as const, status: 'confirmed' as const, amendmentStatus: 'applied' as const })),
    rejectAmendmentLink: vi.fn(async () => ({ ok: true as const, status: 'rejected' as const, amendmentStatus: 'applied' as const })),
    ...over,
  };
}

function mockExporter(): ScheduleExporter {
  return { csv: vi.fn(), xlsx: vi.fn(), ics: vi.fn(), print: vi.fn() };
}

function renderContainer(
  opts: { api?: ScheduleApi; shell?: Partial<ShellContextValue>; exporter?: ScheduleExporter; now?: () => Date } = {},
) {
  const api = opts.api ?? mockApi();
  const exporter = opts.exporter ?? mockExporter();
  const shell = shellValue(opts.shell);
  const now = opts.now ?? (() => new Date(2026, 10, 20, 9));
  const user = userEvent.setup();
  const tree = (bidId: string, value: ShellContextValue) => (
    <ShellContext.Provider value={value}>
      <ScheduleContainer bidId={bidId} tab="schedule" selectedRowId={null} api={api} exporter={exporter} now={now} />
    </ShellContext.Provider>
  );
  const view = render(tree('bid-1', shell));
  /** The shell switching bids without remounting the container (the same registered component). */
  const switchTo = (bidId: string, over: Partial<ShellContextValue> = {}) => view.rerender(tree(bidId, shellValue({ bidId, ...over })));
  return { api, exporter, shell, user, switchTo, ...view };
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    const save = deferred<never>();
    vi.mocked(api.updateBid).mockReturnValueOnce(save.promise);
    const { user } = renderContainer({ api });
    await ready();
    const toggle = screen.getByRole('switch', { name: 'Workdays only' });
    await user.click(toggle);
    expect(api.updateBid).toHaveBeenCalledWith('bid-1', { scheduleWorkdaysOnly: false });
    expect(toggle.getAttribute('aria-checked')).toBe('false'); // optimistic, while saving
    save.reject(new ApiError('No.', 500));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(toast.error).toHaveBeenCalledWith('No.');
  });

  it('sends one move at a time for held arrow keys, then only the latest', async () => {
    const api = mockApi([userRow]);
    const first = deferred<ScheduleActivityDto>();
    vi.mocked(api.updateRow).mockReturnValueOnce(first.promise as never);
    const { user, container } = renderContainer({ api });
    await ready();
    (container.querySelector('[data-activity="act-1"]') as HTMLElement).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(api.updateRow).toHaveBeenCalledTimes(1);
    expect(api.updateRow).toHaveBeenLastCalledWith('bid-1', 'schedule_activities', 'act-1', { startDate: '2026-11-17', endDate: '2026-11-19' });
    first.resolve(userRow);
    await waitFor(() => expect(api.updateRow).toHaveBeenCalledTimes(2));
    expect(api.updateRow).toHaveBeenLastCalledWith('bid-1', 'schedule_activities', 'act-1', { startDate: '2026-11-19', endDate: '2026-11-21' });
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2)); // one reload, after the last save
  });

  it('locks at once and ignores a second click while saving', async () => {
    const api = mockApi([userRow]);
    const save = deferred<ScheduleActivityDto>();
    vi.mocked(api.updateRow).mockReturnValueOnce(save.promise as never);
    const { user } = renderContainer({ api });
    await ready();
    await user.click(screen.getByRole('tab', { name: 'Milestones' }));
    const box = screen.getByRole('checkbox', { name: 'Lock First draft writing' });
    await user.click(box);
    expect(box.getAttribute('aria-checked')).toBe('true');
    await user.click(box);
    expect(api.updateRow).toHaveBeenCalledTimes(1);
    expect(api.updateRow).toHaveBeenCalledWith('bid-1', 'schedule_activities', 'act-1', { locked: true });
    save.resolve(userRow);
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });

  it('counts a replace from the stored origin: a row with none is kept by the server', async () => {
    const legacy = scheduleActivityDto({ id: 'act-old', origin: null, label: 'Old row' });
    const { user } = renderContainer({ api: mockApi([legacy]) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByText(/Hand-added activities/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Apply template' })).toBeTruthy();
  });

  it('moves today forward when the window comes back on a later day', async () => {
    let clock = new Date(2026, 10, 20, 9);
    renderContainer({ now: () => clock });
    await ready();
    expect(screen.getByText(/workdays left/).parentElement?.textContent).toContain('3 workdays left');
    clock = new Date(2026, 10, 23, 9);
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByText(/workdays? left/).parentElement?.textContent).toContain('2 workdays left'));
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
      proposals: [],
      pendingDateChange: null,
    } as never);
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Shift dates' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(within(dialog).getByRole('button', { name: 'Shift dates' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenLastCalledWith(expect.stringContaining('may already have moved'));
  });

  it('ignores Escape while an answer is being applied, then closes when it is done', async () => {
    const api = mockApi();
    const adjust = deferred<AdjustScheduleDto>();
    vi.mocked(api.adjustSchedule).mockReturnValueOnce(adjust.promise);
    const { user } = renderContainer({ api });
    await ready();
    await changeDueTo(user, '2026-12-02');
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Shift dates' }));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalled());
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    adjust.resolve(adjusted);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Moved 1 activity.');
  });

  it('closes on a stale due date without writing', async () => {
    const api = mockApi();
    vi.mocked(api.getBid).mockResolvedValue(bidDto({ dueDate: ts('2026-12-09') }));
    const { user } = renderContainer({ api });
    await ready();
    await changeDueTo(user, '2026-12-02');
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep dates' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.error).toHaveBeenCalledWith('The due date changed while this was open. Check the new date and try again.');
    expect(api.updateBid).not.toHaveBeenCalled();
    expect(api.adjustSchedule).not.toHaveBeenCalled();
  });

  it('says the due date is saved after a try that did not move the schedule', async () => {
    const api = mockApi();
    vi.mocked(api.adjustSchedule).mockRejectedValueOnce(new ApiError('Bad date.', 400, 'invalid_date'));
    const { user } = renderContainer({ api });
    await ready();
    await changeDueTo(user, '2026-12-02');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/The new due date is saved/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Shift dates' }));
    expect(await within(dialog).findByText('The new due date is saved. Choose how to move the schedule.')).toBeTruthy();
  });

  it('keeps a pending change with its bid when the shell switches bids', async () => {
    const { api, user, switchTo } = renderContainer();
    await ready();
    await changeDueTo(user, '2026-12-02');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    switchTo('bid-2', { bid: bidDto({ id: 'bid-2', name: 'Navy IT', dueDate: ts('2026-12-15') }) });
    await waitFor(() => expect(api.getTab).toHaveBeenCalledWith('bid-2', 'schedule', expect.anything()));
    expect(screen.queryByRole('dialog')).toBeNull();
    await ready();
    switchTo('bid-1', { bid: bidDto({ dueDate: ts('2026-11-25'), dueTime: '17:00' }) });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/from Wed, Nov 25, 2026 to Wed, Dec 2, 2026/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Shift dates' }));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledWith('bid-1', expect.objectContaining({ nextDue: '2026-12-02' })));
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

describe('ScheduleContainer: amendment date change', () => {
  const change: PendingDateChangeDto = {
    amendmentId: 'amd-3',
    amendmentNo: 3,
    previousDue: '2026-11-25',
    nextDue: '2026-12-02',
    sourcePage: 4,
    sourceQuote: 'Proposals are now due December 2.',
  };
  const TITLE = 'Amendment 3 moved the due date';

  function pendingApi(pending: PendingDateChangeDto | null = change, over: Partial<ScheduleApi> = {}): ScheduleApi {
    return mockApi([userRow, aiRow], {
      getTab: vi.fn(async () => ({
        activities: [userRow, aiRow],
        workdaysOnly: true,
        proposals: [],
        pendingDateChange: pending,
      })) as unknown as ScheduleApi['getTab'],
      ...over,
    });
  }

  const prompt = () => screen.findByRole('dialog', { name: TITLE });
  const button = (dialog: HTMLElement, name: string) => within(dialog).getByRole('button', { name }) as HTMLButtonElement;

  it.each([
    ['shift', 'Shift dates', adjusted, 'Due date set to Wed, Dec 2, 2026. Moved 1 activity.'],
    ['scale', 'Scale dates', { ...adjusted, requestedMode: 'scale', mode: 'scale' }, 'Due date set to Wed, Dec 2, 2026. Moved 1 activity.'],
    ['keep', 'Keep dates', { ...adjusted, requestedMode: 'keep', mode: 'keep', moved: 0 }, 'Due date set to Wed, Dec 2, 2026. Kept the schedule dates.'],
  ] as const)('opens on its own and answers %s with the amendmentId alone', async (mode, label, result, message) => {
    const api = pendingApi(change, { adjustSchedule: vi.fn(async () => result as AdjustScheduleDto) });
    const { shell, user } = renderContainer({ api });
    const dialog = await prompt();
    expect(within(dialog).getByText('“Proposals are now due December 2.”')).toBeTruthy();
    expect(within(dialog).getByText("Your answer sets the bid's due date to Wed, Dec 2, 2026.")).toBeTruthy();
    await user.click(button(dialog, label));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
    expect(api.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode, amendmentId: 'amd-3' });
    expect(api.getBid).not.toHaveBeenCalled();
    expect(api.updateBid).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(message);
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
    expect(shell.refresh).toHaveBeenCalled();
    // The reload still returns the change (the payload lags the answer): it stays closed.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review date change' })).toBeNull();
  });

  it('sends one answer for a double click', async () => {
    const adjust = deferred<AdjustScheduleDto>();
    const api = pendingApi(change, { adjustSchedule: vi.fn(() => adjust.promise) });
    const { user } = renderContainer({ api });
    const dialog = await prompt();
    const shift = button(dialog, 'Shift dates');
    fireEvent.click(shift);
    fireEvent.click(shift);
    await waitFor(() => expect(shift.disabled).toBe(true));
    await user.click(shift);
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
    adjust.resolve(adjusted);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
  });

  it('leaves a notice on Cancel that reopens the prompt', async () => {
    const api = pendingApi();
    const { user } = renderContainer({ api });
    await user.click(button(await prompt(), 'Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Amendment 3 moves the due date to Wed, Dec 2, 2026.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Review date change' }));
    expect(await prompt()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review date change' })).toBeNull();
    expect(api.adjustSchedule).not.toHaveBeenCalled();
  });

  it('offers only Keep dates when the bid had no due date', async () => {
    const api = pendingApi({ ...change, previousDue: null });
    const { user } = renderContainer({ api, shell: { bid: bidDto({ dueDate: null }) } });
    const dialog = await screen.findByRole('dialog', { name: 'Amendment 3 set the due date' });
    expect(within(dialog).queryByRole('button', { name: 'Shift dates' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Scale dates' })).toBeNull();
    const keep = button(dialog, 'Keep dates');
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await user.click(keep);
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'keep', amendmentId: 'amd-3' }));
  });

  it('closes on 409 date_change_resolved, reloads, and does not reopen', async () => {
    const message = 'This date change was already answered. Reload to see the current dates.';
    const api = pendingApi(change, {
      adjustSchedule: vi.fn(async () => Promise.reject(new ApiError(message, 409, 'date_change_resolved'))),
    });
    const { shell, user } = renderContainer({ api });
    await user.click(button(await prompt(), 'Shift dates'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.info).toHaveBeenCalledWith(message);
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
    expect(shell.refresh).toHaveBeenCalled();
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review date change' })).toBeNull();
  });

  it('closes on 404 and reloads', async () => {
    const api = pendingApi(change, { adjustSchedule: vi.fn(async () => Promise.reject(new ApiError('Not found.', 404))) });
    const { user } = renderContainer({ api });
    await user.click(button(await prompt(), 'Keep dates'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.info).toHaveBeenCalledWith(AMENDMENT_GONE_MESSAGE);
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });

  it('keeps the prompt on a failure, and the retry sends the same body', async () => {
    const api = pendingApi();
    vi.mocked(api.adjustSchedule).mockRejectedValueOnce(new ApiError('Server error.', 500));
    const { user } = renderContainer({ api });
    const dialog = await prompt();
    await user.click(button(dialog, 'Shift dates'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server error.'));
    await waitFor(() => expect(button(dialog, 'Shift dates').disabled).toBe(false));
    expect(screen.getByRole('dialog', { name: TITLE })).toBeTruthy();
    await user.click(button(dialog, 'Shift dates'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.adjustSchedule).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.adjustSchedule).mock.calls[1]).toEqual(['bid-1', { mode: 'shift', amendmentId: 'amd-3' }]);
    expect(api.updateBid).not.toHaveBeenCalled();
  });

  it("still answers the user's own change through the old path", async () => {
    const api = pendingApi();
    const { user } = renderContainer({ api });
    await user.click(button(await prompt(), 'Cancel'));
    await changeDueTo(user, '2026-12-09');
    const dialog = await screen.findByRole('dialog', { name: 'The due date changed' });
    expect(within(dialog).queryByText(/Proposals are now due/)).toBeNull();
    await user.click(button(dialog, 'Shift dates'));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalled());
    const first = (fn: unknown, n = 0) => vi.mocked(fn as () => void).mock.invocationCallOrder[n]!;
    expect(first(api.getBid)).toBeLessThan(first(api.updateBid));
    // getTab's second call is resolveDateChange's read of the schedule, between the PATCH and the adjust.
    expect(first(api.updateBid)).toBeLessThan(first(api.getTab, 1));
    expect(first(api.getTab, 1)).toBeLessThan(first(api.adjustSchedule));
    expect(api.updateBid).toHaveBeenCalledWith('bid-1', { dueDate: '2026-12-09' });
    expect(vi.mocked(api.adjustSchedule).mock.calls[0]).toEqual([
      'bid-1',
      { mode: 'shift', previousDue: '2026-11-25', nextDue: '2026-12-09' },
    ]);
  });

  it('closes the prompt to open the amendment source, and brings it back when the viewer closes', async () => {
    const fetchMock = mockFetch();
    const amendment = docDto({ id: 'doc-amd', kind: 'amendment', amendmentNo: 3 });
    const { user } = renderContainer({ api: pendingApi(), shell: { docs: [docDto(), amendment] } });
    await user.click(within(await prompt()).getByRole('button', { name: 'Open source for Amendment 3, page 4' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: TITLE })).toBeNull());
    expect(screen.getByText('Amendment 3 moves the due date to Wed, Dec 2, 2026.')).toBeTruthy();
    const viewer = document.querySelector('.app-shell [aria-label="Source viewer"]') as HTMLElement;
    expect(viewer).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/documents/doc-amd/view-token'))).toBe(true));
    await user.click(within(viewer).getByRole('button', { name: 'Close' }));
    const dialog = await prompt();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.querySelector('[aria-label="Source viewer"]')).toBeNull();
  });

  it('opens the source from the notice, and the notice stays when the viewer closes', async () => {
    mockFetch();
    const amendment = docDto({ id: 'doc-amd', kind: 'amendment', amendmentNo: 3 });
    const { user } = renderContainer({ api: pendingApi(), shell: { docs: [docDto(), amendment] } });
    await user.click(button(await prompt(), 'Cancel'));
    const notice = screen.getByRole('region', { name: 'Amendment date change' });
    await user.click(within(notice).getByRole('button', { name: 'Open source for Amendment 3, page 4' }));
    const viewer = document.querySelector('.app-shell [aria-label="Source viewer"]') as HTMLElement;
    await user.click(within(viewer).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: TITLE })).toBeNull();
    expect(screen.getByRole('region', { name: 'Amendment date change' })).toBeTruthy();
  });

  it('shows No source and keeps the quote when no amendment document resolves', async () => {
    const { user } = renderContainer({ api: pendingApi(), shell: { docs: [docDto(), docDto({ id: 'gone', kind: 'amendment', amendmentNo: 3, liveStatus: 'deleted' })] } });
    const dialog = await prompt();
    expect(within(dialog).getByText('No source')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Open source/ })).toBeNull();
    expect(within(dialog).getByText('“Proposals are now due December 2.”')).toBeTruthy();
    await user.click(button(dialog, 'Cancel'));
    const notice = screen.getByRole('region', { name: 'Amendment date change' });
    expect(within(notice).getByText('No source')).toBeTruthy();
    expect(within(notice).getByText('“Proposals are now due December 2.”')).toBeTruthy();
  });

  it('closes only the answered bid when the shell switches bids during the answer', async () => {
    const adjust = deferred<AdjustScheduleDto>();
    const api = pendingApi(change, { adjustSchedule: vi.fn(() => adjust.promise) });
    const { user, switchTo } = renderContainer({ api });
    await user.click(button(await prompt(), 'Shift dates'));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledTimes(1));
    // bid-2 has the same amendment change waiting: its prompt is a different change, and not busy.
    switchTo('bid-2', { bid: bidDto({ id: 'bid-2', dueDate: ts('2026-11-25') }) });
    await waitFor(() => expect(api.getTab).toHaveBeenCalledWith('bid-2', 'schedule', expect.anything()));
    const other = await prompt();
    expect(button(other, 'Shift dates').disabled).toBe(false);
    adjust.resolve(adjusted);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.getByRole('dialog', { name: TITLE })).toBeTruthy();
    switchTo('bid-1', { bid: bidDto({ dueDate: ts('2026-11-25') }) });
    await waitFor(() => expect(vi.mocked(api.getTab).mock.calls.filter(([id]) => id === 'bid-1')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading schedule' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Schedule', level: 1 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('ScheduleContainer: amendment proposals', () => {
  const proposed = scheduleActivityDto({
    id: 'act-new',
    label: 'Proposal due',
    kind: 'submission',
    origin: 'ai',
    startDate: ts('2026-12-02'),
    endDate: null,
    documentId: 'doc-amd',
    sourcePage: 4,
  });
  const mine = scheduleActivityDto({ id: 'act-mine', label: 'Proposal due', kind: 'submission', startDate: ts('2026-11-25'), endDate: null });

  function proposalApi(over: Partial<ScheduleApi> = {}, dto = tabProposalDto(proposed, { oldRowIds: ['act-mine'], sourceQuote: 'Due December 2.' })) {
    return mockApi([mine], {
      getTab: vi.fn(async () => ({ activities: [mine], workdaysOnly: true, proposals: [dto], pendingDateChange: null })) as unknown as ScheduleApi['getTab'],
      ...over,
    });
  }

  const card = () => screen.findByRole('article', { name: 'Amendment 2: Proposal due' });

  it('lists the proposal from the payload', async () => {
    renderContainer({ api: proposalApi() });
    const article = await card();
    expect(screen.getByRole('heading', { name: 'Changes from amendments' })).toBeTruthy();
    expect(within(article).getByText(/^Replaces Proposal due, /)).toBeTruthy();
    expect(within(article).getByText('“Due December 2.”')).toBeTruthy();
  });

  it('inserts, then reloads the tab and the shell', async () => {
    const api = proposalApi();
    const { shell, user } = renderContainer({ api });
    await user.click(within(await card()).getByRole('button', { name: 'Insert Amendment 2: Proposal due' }));
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
    expect(api.confirmAmendmentLink).toHaveBeenCalledWith('link-a');
    expect(toast.success).toHaveBeenCalledWith('Inserted the change from Amendment 2.');
    expect(shell.refresh).toHaveBeenCalled();
    expect(api.updateBid).not.toHaveBeenCalled();
    expect(api.adjustSchedule).not.toHaveBeenCalled();
  });

  it('dismisses', async () => {
    const api = proposalApi();
    const { user } = renderContainer({ api });
    await user.click(within(await card()).getByRole('button', { name: 'Dismiss Amendment 2: Proposal due' }));
    await waitFor(() => expect(api.rejectAmendmentLink).toHaveBeenCalledWith('link-a'));
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenCalledWith('Dismissed the change from Amendment 2. Your row stays.');
  });

  it.each([
    ['row_already_closed', ROW_ALREADY_CLOSED_MESSAGE],
    ['new_row_missing', NEW_ROW_MISSING_MESSAGE],
  ])('shows the web wording for 409 %s and reloads', async (code, message) => {
    const api = proposalApi({ confirmAmendmentLink: vi.fn(async () => Promise.reject(new ApiError('API text.', 409, code))) });
    const { user } = renderContainer({ api });
    await user.click(within(await card()).getByRole('button', { name: 'Insert Amendment 2: Proposal due' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
  });

  it('sends one Insert for a double click', async () => {
    const confirm = deferred<never>();
    const api = proposalApi({ confirmAmendmentLink: vi.fn(() => confirm.promise) });
    renderContainer({ api });
    const insert = within(await card()).getByRole('button', { name: 'Insert Amendment 2: Proposal due' });
    fireEvent.click(insert);
    fireEvent.click(insert);
    fireEvent.click(within(await card()).getByRole('button', { name: 'Dismiss Amendment 2: Proposal due' }));
    expect(api.confirmAmendmentLink).toHaveBeenCalledTimes(1);
    expect(api.rejectAmendmentLink).not.toHaveBeenCalled();
    await waitFor(() => expect((insert as HTMLButtonElement).disabled).toBe(true));
    confirm.reject(new ApiError('Gone.', 404));
    await waitFor(() => expect((insert as HTMLButtonElement).disabled).toBe(false));
  });

  it('opens the proposed row in the amendment document', async () => {
    const fetchMock = mockFetch();
    const { user } = renderContainer({ api: proposalApi() });
    await user.click(within(await card()).getByRole('button', { name: 'Open source for Proposal due, page 4' }));
    expect(document.querySelector('.app-shell [aria-label="Source viewer"]')).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/documents/doc-amd/view-token'))).toBe(true));
  });

  it('says when the row has no source document', async () => {
    const api = proposalApi({}, tabProposalDto({ ...proposed, documentId: null }, { oldRowIds: ['act-mine'] }));
    const { user } = renderContainer({ api });
    await user.click(within(await card()).getByRole('button', { name: 'Open source for Proposal due, page 4' }));
    expect(toast.info).toHaveBeenCalledWith('No source page for this row.');
    expect(document.querySelector('[aria-label="Source viewer"]')).toBeNull();
  });

});

describe('ScheduleContainer: amendment date change, guards and sources', () => {
  const change: PendingDateChangeDto = {
    amendmentId: 'amd-3',
    amendmentNo: 3,
    previousDue: '2026-11-25',
    nextDue: '2026-12-02',
    sourcePage: 4,
    sourceQuote: 'Proposals are now due December 2.',
  };
  const TITLE = 'Amendment 3 moved the due date';
  const pendingApi = (pending: PendingDateChangeDto = change, over: Partial<ScheduleApi> = {}) =>
    mockApi([userRow, aiRow], {
      getTab: vi.fn(async () => ({ activities: [userRow, aiRow], workdaysOnly: true, proposals: [], pendingDateChange: pending })) as unknown as ScheduleApi['getTab'],
      ...over,
    });
  const prompt = () => screen.findByRole('dialog', { name: TITLE });
  const button = (dialog: HTMLElement, name: string) => within(dialog).getByRole('button', { name }) as HTMLButtonElement;

  it('does not guess the source document of an amendment without a number', async () => {
    const numberless = docDto({ id: 'doc-x', kind: 'amendment', amendmentNo: null });
    const api = mockApi([userRow], {
      getTab: vi.fn(async () => ({
        activities: [userRow],
        workdaysOnly: true,
        proposals: [],
        pendingDateChange: { amendmentId: 'amd-9', amendmentNo: null, previousDue: '2026-11-25', nextDue: '2026-12-02', sourcePage: 2, sourceQuote: null },
      })) as unknown as ScheduleApi['getTab'],
    });
    renderContainer({ api, shell: { docs: [docDto(), numberless] } });
    const dialog = await screen.findByRole('dialog', { name: 'An amendment moved the due date' });
    expect(within(dialog).getByText('No source')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Open source/ })).toBeNull();
  });

  it('opens a different change by itself when the reload after an answer returns one', async () => {
    const api = pendingApi();
    const later: PendingDateChangeDto = { ...change, amendmentId: 'amd-4', amendmentNo: 4, nextDue: '2026-12-09', sourceQuote: null };
    vi.mocked(api.getTab)
      .mockResolvedValueOnce({ activities: [userRow, aiRow], workdaysOnly: true, proposals: [], pendingDateChange: change } as never)
      .mockResolvedValueOnce({ activities: [userRow, aiRow], workdaysOnly: true, proposals: [], pendingDateChange: later } as never);
    const { user } = renderContainer({ api });
    await user.click(button(await prompt(), 'Keep dates'));
    const next = await screen.findByRole('dialog', { name: 'Amendment 4 moved the due date' });
    expect(within(next).getByText("Your answer sets the bid's due date to Wed, Dec 9, 2026.")).toBeTruthy();
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
  });

  it('ignores Change due date while an amendment answer is being applied', async () => {
    const adjust = deferred<AdjustScheduleDto>();
    const api = pendingApi(change, { adjustSchedule: vi.fn(() => adjust.promise) });
    const { user } = renderContainer({ api });
    await user.click(button(await prompt(), 'Shift dates'));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledTimes(1));
    // The modal hides the header; drive it directly, as a stray click or a second tab of focus could.
    fireEvent.click(screen.getByRole('button', { name: 'Change due date', hidden: true }));
    fireEvent.change(await screen.findByLabelText('New due date'), { target: { value: '2026-12-09' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue', hidden: true }));
    adjust.resolve(adjusted);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(api.getTab).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog', { name: 'The due date changed' })).toBeNull();
    expect(api.getBid).not.toHaveBeenCalled();
    expect(api.updateBid).not.toHaveBeenCalled();
  });

  it('offers no amendment answer while the user change is being applied, and brings the notice back afterwards', async () => {
    const bid = deferred<ReturnType<typeof bidDto>>();
    const api = pendingApi(change, { getBid: vi.fn(() => bid.promise) });
    const { user } = renderContainer({ api });
    await user.click(button(await prompt(), 'Cancel'));
    await changeDueTo(user, '2026-12-09');
    const mine = await screen.findByRole('dialog', { name: 'The due date changed' });
    await user.click(button(mine, 'Shift dates'));
    await waitFor(() => expect(api.getBid).toHaveBeenCalled());
    // The user's prompt takes precedence: no amendment prompt or notice to answer from.
    expect(screen.queryByRole('dialog', { name: TITLE })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review date change', hidden: true })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'The due date changed' })).toBeTruthy();
    bid.resolve(bidDto({ dueDate: ts('2026-11-25') }));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.adjustSchedule).mock.calls[0]![1]).not.toHaveProperty('amendmentId');
    // The amendment's change comes back as the notice once the user's is done.
    expect(await screen.findByRole('button', { name: 'Review date change' })).toBeTruthy();
  });

  it("hides a source opened on one bid after the shell switches to another", async () => {
    mockFetch();
    const { user, switchTo } = renderContainer({ api: mockApi([{ ...aiRow, documentId: 'doc-1' }]) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Open source for Proposal due, page 12' }));
    expect(document.querySelector('[aria-label="Source viewer"]')).toBeTruthy();
    switchTo('bid-2', { bid: bidDto({ id: 'bid-2', dueDate: ts('2026-12-15') }) });
    expect(document.querySelector('[aria-label="Source viewer"]')).toBeNull();
  });
});

describe('ScheduleContainer: the date-change lock shared with other screens (Settings)', () => {
  const change: PendingDateChangeDto = {
    amendmentId: 'amd-3',
    amendmentNo: 3,
    previousDue: '2026-11-25',
    nextDue: '2026-12-02',
    sourcePage: 4,
    sourceQuote: 'Proposals are now due December 2.',
  };
  const TITLE = 'Amendment 3 moved the due date';
  const pendingApi = (over: Partial<ScheduleApi> = {}) =>
    mockApi([userRow, aiRow], {
      getTab: vi.fn(async () => ({ activities: [userRow, aiRow], workdaysOnly: true, proposals: [], pendingDateChange: change })) as unknown as ScheduleApi['getTab'],
      ...over,
    });
  const prompt = () => screen.findByRole('dialog', { name: TITLE });
  const button = (dialog: HTMLElement, name: string) => within(dialog).getByRole('button', { name }) as HTMLButtonElement;

  /** Settings stand-in: the same hook on its own api, rendered apart from the Schedule tab. */
  function otherScreen(api: UserDateChangeApi) {
    return renderHook(() => useUserDateChange<null>(api));
  }

  it('does not answer the amendment while another screen applies a user change on the bid, then does', async () => {
    const bid = deferred<ReturnType<typeof bidDto>>();
    const settingsApi = mockApi([userRow], { getBid: vi.fn(() => bid.promise) });
    const settings = otherScreen(settingsApi);
    act(() => {
      settings.result.current.open('bid-1', { previousDue: '2026-11-25', nextDue: '2026-12-09' }, null);
    });
    let run: Promise<unknown> | null = null;
    act(() => {
      run = settings.result.current.resolve('bid-1', 'shift');
    });
    // Settings unmounts (a tab switch) while its answer is still being applied; Schedule mounts next.
    settings.unmount();

    const api = pendingApi();
    const { user } = renderContainer({ api });
    const dialog = await prompt();
    const shift = button(dialog, 'Shift dates');
    expect(shift.disabled).toBe(true);
    fireEvent.click(shift);
    fireEvent.click(button(dialog, 'Cancel'));
    expect(api.adjustSchedule).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: TITLE })).toBeTruthy();

    await act(async () => {
      bid.resolve(bidDto({ dueDate: ts('2026-11-25') }));
      await run;
    });
    await waitFor(() => expect(button(dialog, 'Shift dates').disabled).toBe(false));
    await user.click(button(dialog, 'Shift dates'));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'shift', amendmentId: 'amd-3' }));
    expect(api.adjustSchedule).toHaveBeenCalledTimes(1);
  });

  it("refuses another screen's user change while the amendment answer is being applied, and allows it after", async () => {
    const adjust = deferred<AdjustScheduleDto>();
    const api = pendingApi({ adjustSchedule: vi.fn(() => adjust.promise) });
    const { user } = renderContainer({ api });
    await user.click(button(await prompt(), 'Shift dates'));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledTimes(1));

    const settingsApi = mockApi([userRow]);
    const settings = otherScreen(settingsApi);
    act(() => {
      expect(settings.result.current.open('bid-1', { previousDue: '2026-11-25', nextDue: '2026-12-09' }, null)).toBe(false);
    });
    expect(settings.result.current.current('bid-1')).toBeNull();
    // Another bid is not blocked.
    act(() => {
      expect(settings.result.current.open('bid-2', { previousDue: '2026-11-25', nextDue: '2026-12-09' }, null)).toBe(true);
    });

    adjust.resolve(adjusted);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => {
      expect(settings.result.current.open('bid-1', { previousDue: '2026-12-02', nextDue: '2026-12-09' }, null)).toBe(true);
    });
    expect(settingsApi.getBid).not.toHaveBeenCalled();
  });

  it("disables the user prompt's answers while another screen's answer on the bid is in flight", async () => {
    const api = mockApi();
    const { user } = renderContainer({ api });
    await ready();
    await changeDueTo(user, '2026-12-02');
    const dialog = await screen.findByRole('dialog');

    const bid = deferred<ReturnType<typeof bidDto>>();
    const settings = otherScreen(mockApi([userRow], { getBid: vi.fn(() => bid.promise) }));
    act(() => {
      settings.result.current.open('bid-1', { previousDue: '2026-11-25', nextDue: '2026-12-09' }, null);
    });
    let run: Promise<unknown> | null = null;
    act(() => {
      run = settings.result.current.resolve('bid-1', 'keep');
    });
    await waitFor(() => expect(button(dialog, 'Shift dates').disabled).toBe(true));
    fireEvent.click(button(dialog, 'Shift dates'));
    expect(api.getBid).not.toHaveBeenCalled();

    await act(async () => {
      bid.resolve(bidDto({ dueDate: ts('2026-11-25') }));
      await run;
    });
    await waitFor(() => expect(button(dialog, 'Shift dates').disabled).toBe(false));
    await user.click(button(dialog, 'Shift dates'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'shift', previousDue: '2026-11-25', nextDue: '2026-12-02' });
  });
});

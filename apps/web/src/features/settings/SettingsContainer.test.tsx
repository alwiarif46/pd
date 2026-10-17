// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ApiError, type AdjustScheduleDto, type BidDto } from '@/api';
import { bidDto, docDto, meDto, orgPayload, organizationDto } from '@/test/fixtures';
import { DATE_CHANGE_BUSY_MESSAGE, STALE_MESSAGE } from '@/features/schedule/controller';
import { lockedDateChangeBids, tryLockDateChange } from '@/features/schedule/date-change-lock';
import { ShellContext, type ShellContextValue } from '@/features/shell/bid-context';
import { DUE_NOT_CHANGED_MESSAGE, DUE_SAVED_NOT_MOVED_MESSAGE, DUE_UNCHANGED_MESSAGE, type SettingsApi } from './controller';
import { SettingsContainer } from './SettingsContainer';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

// The date-change lock is module state: a test that leaves one held fails here, not in a later test.
afterEach(async () => {
  await waitFor(() => expect(lockedDateChangeBids()).toEqual([]));
  vi.clearAllMocks();
  window.location.hash = '';
});

const ts = (day: string) => `${day}T00:00:00.000Z`;
const adjusted: AdjustScheduleDto = {
  ok: true,
  requestedMode: 'shift',
  mode: 'shift',
  workdaysOnly: true,
  unit: 'workdays',
  delta: 8,
  moved: 3,
  moves: [],
};
const paid = { plan: 'growth' as const, creditsLeft: 5, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 300 };
const free = { plan: 'free' as const, creditsLeft: 1, creditsResetOn: '2026-11-01T00:00:00.000Z', mbCap: 50 };

function shellValue(over: Partial<ShellContextValue> = {}): ShellContextValue {
  return {
    me: meDto(),
    org: orgPayload({ org: organizationDto({ plan: 'growth' }), role: 'owner' }),
    summary: paid,
    bids: [bidDto()],
    bidId: 'bid-1',
    tab: 'settings',
    bid: bidDto({ filesLiveUntil: ts('2027-02-01') }),
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

function mockApi(over: Partial<SettingsApi> = {}): SettingsApi {
  return {
    getBid: vi.fn(async () => bidDto()),
    updateBid: vi.fn(async () => bidDto()),
    deleteBid: vi.fn(async () => ({ ok: true as const })),
    getTab: vi.fn(async () => ({ activities: [], workdaysOnly: true, proposals: [], pendingDateChange: null })) as unknown as SettingsApi['getTab'],
    adjustSchedule: vi.fn(async () => adjusted),
    ...over,
  };
}

function renderContainer(opts: { api?: SettingsApi; shell?: Partial<ShellContextValue> } = {}) {
  const api = opts.api ?? mockApi();
  const shell = shellValue(opts.shell);
  const user = userEvent.setup();
  const tree = (value: ShellContextValue) => (
    <ShellContext.Provider value={value}>
      <SettingsContainer bidId={value.bidId ?? 'bid-1'} tab="settings" selectedRowId={null} api={api} />
    </ShellContext.Provider>
  );
  const view = render(tree(shell));
  /** The shell reloading the bid (a poll, window focus): a new object for the same or new values. */
  const reloadBid = (bid: BidDto) => view.rerender(tree({ ...shell, bid }));
  /** The shell switching bids without remounting the container (the same registered component). */
  const switchTo = (bid: BidDto) => view.rerender(tree({ ...shell, bidId: bid.id, bid }));
  return { api, shell, user, reloadBid, switchTo, ...view };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ready = () => screen.findByRole('heading', { name: 'Bid settings', level: 1 });
const setDue = (day: string) => fireEvent.change(screen.getByLabelText('Due date'), { target: { value: day } });
const saveButton = () => screen.getByRole('button', { name: 'Save changes' });
const prompt = () => screen.findByRole('dialog', { name: 'The due date moved' });
const choice = (label: 'Shift dates' | 'Scale dates' | 'Keep dates') => screen.getByRole('button', { name: new RegExp(`^${label}`) });

describe('SettingsContainer: states', () => {
  it('shows a skeleton until the bid is loaded', () => {
    renderContainer({ shell: { bidLoaded: false, bid: null } });
    expect(screen.getByRole('status', { name: 'Loading settings' })).toBeTruthy();
  });

  it('shows the stored values and the credit sentence', async () => {
    renderContainer();
    await ready();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('VA EHR Support');
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-11-03');
    expect((screen.getByLabelText('Due time') as HTMLInputElement).value).toBe('14:00');
    expect(screen.getByText('The reserved RFP credit is released.')).toBeTruthy();
  });

  it('is not blocked without a solicitation', async () => {
    renderContainer({ shell: { docs: [] } });
    await ready();
    expect(screen.queryByText('No solicitation yet')).toBeNull();
  });
});

describe('SettingsContainer: keep files live, by role and plan', () => {
  it('lets the owner on a paid plan edit it, with the date formatted', async () => {
    renderContainer();
    await ready();
    expect((screen.getByLabelText(/Keep files live until/) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/Files stay live until Feb 1, 2027 unless you extend it/)).toBeTruthy();
  });

  it('shows it read-only to a member on a paid plan', async () => {
    renderContainer({ shell: { org: orgPayload({ org: organizationDto({ plan: 'growth' }), role: 'member' }) } });
    await ready();
    expect((screen.getByLabelText(/Keep files live until/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Only the bid owner can change this.')).toBeTruthy();
  });

  it.each(['owner', 'member'] as const)('disables it on Free for the %s', async (role) => {
    renderContainer({ shell: { summary: free, org: orgPayload({ role }) } });
    await ready();
    expect((screen.getByLabelText(/Keep files live until/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Paid plans can keep files live longer.')).toBeTruthy();
  });

  it('sends the live-until date for the owner on a paid plan', async () => {
    const { api, user } = renderContainer();
    await ready();
    fireEvent.change(screen.getByLabelText(/Keep files live until/), { target: { value: '2027-03-01' } });
    await user.click(saveButton());
    await waitFor(() => expect(api.updateBid).toHaveBeenCalledWith('bid-1', { retentionExtendedUntil: '2027-03-01' }));
  });
});

describe('SettingsContainer: save', () => {
  it('sends only the changed fields, shows Saved., and refreshes the shell', async () => {
    const { api, shell, user } = renderContainer();
    await ready();
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'VA EHR Recompete');
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'));
    expect(api.updateBid).toHaveBeenCalledTimes(1);
    expect(api.updateBid).toHaveBeenCalledWith('bid-1', { name: 'VA EHR Recompete' });
    expect(shell.refresh).toHaveBeenCalled();
    expect(api.getBid).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a save error as given', async () => {
    const api = mockApi({ updateBid: vi.fn(async () => Promise.reject(new ApiError('That solicitation number is locked.', 409))) });
    const { user } = renderContainer({ api });
    await ready();
    await user.type(screen.getByLabelText('Agency'), ' (VHA)');
    await user.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toBe('That solicitation number is locked.');
  });

  it('keeps a half-typed form when the shell reloads an equal bid', async () => {
    const { user, reloadBid } = renderContainer();
    await ready();
    await user.type(screen.getByLabelText('Name'), ' draft');
    reloadBid(bidDto({ filesLiveUntil: ts('2027-02-01') }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('VA EHR Support draft');
  });
});

describe('SettingsContainer: the due-date change', () => {
  it('saves the other fields, prompts, and Shift goes getBid, PATCH due, getTab, adjust', async () => {
    const { api, shell, user } = renderContainer();
    await ready();
    await user.type(screen.getByLabelText('Name'), ' II');
    setDue('2026-11-13');
    await user.click(saveButton());
    const dialog = await prompt();
    expect(within(dialog).getByText('The due date moved from Tue, Nov 3 to Fri, Nov 13. Move the schedule with it?')).toBeTruthy();
    expect(api.updateBid).toHaveBeenCalledTimes(1);
    expect(api.updateBid).toHaveBeenCalledWith('bid-1', { name: 'VA EHR Support II' }); // no dueDate in the first save

    await user.click(choice('Shift dates'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Moved 3 activities.'));
    expect(api.updateBid).toHaveBeenLastCalledWith('bid-1', { dueDate: '2026-11-13' });
    expect(api.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode: 'shift', previousDue: '2026-11-03', nextDue: '2026-11-13' });
    const order = [
      vi.mocked(api.getBid).mock.invocationCallOrder[0],
      vi.mocked(api.updateBid).mock.invocationCallOrder[1],
      vi.mocked(api.getTab).mock.invocationCallOrder[0],
      vi.mocked(api.adjustSchedule).mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(api.getTab).toHaveBeenCalledWith('bid-1', 'schedule');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('Saved.');
    expect(shell.refresh).toHaveBeenCalled();
  });

  it.each([
    ['Scale dates', 'scale'],
    ['Keep dates', 'keep'],
  ] as const)('answers %s with mode %s', async (label, mode) => {
    const { api, user } = renderContainer();
    await ready();
    setDue('2026-11-13');
    await user.click(saveButton());
    await prompt();
    expect(api.updateBid).not.toHaveBeenCalled(); // nothing else changed
    await user.click(choice(label));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledWith('bid-1', { mode, previousDue: '2026-11-03', nextDue: '2026-11-13' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Cancel sends no due date, says so, and resets the form to the stored date', async () => {
    const { api, shell, user } = renderContainer();
    await ready();
    setDue('2026-11-13');
    await user.click(saveButton());
    await prompt();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.updateBid).not.toHaveBeenCalled();
    expect(api.getBid).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(DUE_NOT_CHANGED_MESSAGE); // nothing else was saved
    expect(screen.getByRole('status').textContent).toBe(DUE_NOT_CHANGED_MESSAGE);
    expect(shell.refresh).toHaveBeenCalled();
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-11-03');
  });

  it('Cancel after the other fields were saved says they were', async () => {
    const { api, user } = renderContainer();
    await ready();
    await user.type(screen.getByLabelText('Name'), ' II');
    setDue('2026-11-13');
    await user.click(saveButton());
    await prompt();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(toast.info).toHaveBeenCalledWith(DUE_UNCHANGED_MESSAGE);
    expect(api.updateBid).toHaveBeenCalledTimes(1);
  });

  it('keeps the form and opens no prompt when the other fields fail to save', async () => {
    const api = mockApi({ updateBid: vi.fn(async () => Promise.reject(new ApiError('That solicitation number is locked.', 409))) });
    const { user } = renderContainer({ api });
    await ready();
    await user.type(screen.getByLabelText('Name'), ' II');
    setDue('2026-11-13');
    await user.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toBe('That solicitation number is locked.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.getBid).not.toHaveBeenCalled();
    expect(api.updateBid).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('VA EHR Support II');
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-11-13');
  });

  it("after a switch to another bid, leaves the other bid's typed form alone and names the bid whose due date did not change", async () => {
    const api = mockApi();
    const save = deferred<BidDto>();
    vi.mocked(api.updateBid).mockReturnValueOnce(save.promise);
    const { user, switchTo } = renderContainer({ api });
    await ready();
    await user.type(screen.getByLabelText('Name'), ' II');
    setDue('2026-11-13');
    await user.click(saveButton());
    expect(api.updateBid).toHaveBeenCalledWith('bid-1', { name: 'VA EHR Support II' });

    switchTo(bidDto({ id: 'bid-2', name: 'GSA Cloud Migration', dueDate: ts('2026-12-01') }));
    await ready();
    await user.type(screen.getByLabelText('Name'), ' draft');
    await act(async () => save.resolve(bidDto()));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('The due date of VA EHR Support II did not change. Open its settings to change it again.'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('GSA Cloud Migration draft');
    expect(api.getBid).not.toHaveBeenCalled();
  });

  it('closes with the message when the due date changed elsewhere, and never PATCHes it', async () => {
    const api = mockApi({ getBid: vi.fn(async () => bidDto({ dueDate: ts('2026-11-20') })) });
    const { user } = renderContainer({ api });
    await ready();
    setDue('2026-11-13');
    await user.click(saveButton());
    await prompt();
    await user.click(choice('Shift dates'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(STALE_MESSAGE));
    expect(api.updateBid).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toBe(STALE_MESSAGE);
  });

  it('keeps the prompt when the adjust fails, and a retry sends no second due PATCH', async () => {
    const api = mockApi();
    vi.mocked(api.adjustSchedule).mockRejectedValueOnce(new ApiError('Adjust failed.', 500));
    // After the first try the stored due date is the new one.
    vi.mocked(api.getBid).mockResolvedValueOnce(bidDto()).mockResolvedValue(bidDto({ dueDate: ts('2026-11-13') }));
    const { user } = renderContainer({ api });
    await ready();
    setDue('2026-11-13');
    await user.click(saveButton());
    await prompt();
    await user.click(choice('Shift dates'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The new due date is saved, but the schedule did not move. Adjust failed.'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.click(choice('Shift dates'));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledTimes(2));
    expect(api.updateBid).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Cancel after a failed adjust says the due date is saved', async () => {
    const api = mockApi();
    vi.mocked(api.adjustSchedule).mockRejectedValueOnce(new ApiError('Adjust failed.', 500));
    const { user } = renderContainer({ api });
    await ready();
    setDue('2026-11-13');
    await user.click(saveButton());
    await prompt();
    await user.click(choice('Shift dates'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(toast.info).toHaveBeenCalledWith(DUE_SAVED_NOT_MOVED_MESSAGE);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('ignores a second click while its answer is in flight', async () => {
    const api = mockApi();
    const adjust = deferred<AdjustScheduleDto>();
    vi.mocked(api.adjustSchedule).mockReturnValueOnce(adjust.promise);
    const { user } = renderContainer({ api });
    await ready();
    setDue('2026-11-13');
    await user.click(saveButton());
    await prompt();
    await user.click(choice('Shift dates'));
    await waitFor(() => expect(api.adjustSchedule).toHaveBeenCalledTimes(1));
    await user.click(choice('Scale dates'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.getBid).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => adjust.resolve(adjusted));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not open the prompt while Schedule holds the lock, and says so', async () => {
    const release = tryLockDateChange('bid-1', Symbol('schedule'));
    try {
      const { api, user } = renderContainer();
      await ready();
      await user.type(screen.getByLabelText('Name'), ' II');
      setDue('2026-11-13');
      await user.click(saveButton());
      await waitFor(() => expect(toast.info).toHaveBeenCalledWith(DATE_CHANGE_BUSY_MESSAGE));
      expect(api.updateBid).toHaveBeenCalledWith('bid-1', { name: 'VA EHR Support II' }); // the other fields are saved
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('status').textContent).toBe(DUE_UNCHANGED_MESSAGE);
      expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-11-03');
      expect(api.getBid).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it('says only that the due date did not change when nothing else was saved and the lock is held', async () => {
    const release = tryLockDateChange('bid-1', Symbol('schedule'));
    try {
      const { api, user } = renderContainer();
      await ready();
      setDue('2026-11-13');
      await user.click(saveButton());
      await waitFor(() => expect(toast.info).toHaveBeenCalledWith(DATE_CHANGE_BUSY_MESSAGE));
      expect(api.updateBid).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent).toBe(DUE_NOT_CHANGED_MESSAGE);
    } finally {
      release?.();
    }
  });

  it('refuses an answer while another screen holds the lock, and says so', async () => {
    const { api, user } = renderContainer();
    await ready();
    setDue('2026-11-13');
    await user.click(saveButton());
    await prompt();
    const release = tryLockDateChange('bid-1', Symbol('schedule'));
    try {
      await user.click(choice('Shift dates'));
      expect(toast.info).toHaveBeenCalledWith(DATE_CHANGE_BUSY_MESSAGE);
      expect(api.getBid).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('writes a first due date in one PATCH under the lock, with no prompt', async () => {
    const api = mockApi();
    const save = deferred<BidDto>();
    vi.mocked(api.updateBid).mockReturnValueOnce(save.promise);
    const { user } = renderContainer({ api, shell: { bid: bidDto({ dueDate: null }) } });
    await ready();
    await user.type(screen.getByLabelText('Name'), ' II');
    setDue('2026-11-13');
    await user.click(saveButton());
    expect(api.updateBid).toHaveBeenCalledWith('bid-1', { name: 'VA EHR Support II', dueDate: '2026-11-13' });
    expect(lockedDateChangeBids()).toEqual(['bid-1']);
    await act(async () => save.resolve(bidDto()));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.adjustSchedule).not.toHaveBeenCalled();
  });

  it('refuses a first due date while Schedule holds the lock', async () => {
    const release = tryLockDateChange('bid-1', Symbol('schedule'));
    try {
      const { api, user } = renderContainer({ shell: { bid: bidDto({ dueDate: null }) } });
      await ready();
      setDue('2026-11-13');
      await user.click(saveButton());
      expect(toast.info).toHaveBeenCalledWith(DATE_CHANGE_BUSY_MESSAGE);
      expect(api.updateBid).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it('clears the due date in one PATCH, with no prompt', async () => {
    const { api, user } = renderContainer();
    await ready();
    setDue('');
    await user.click(saveButton());
    await waitFor(() => expect(api.updateBid).toHaveBeenCalledWith('bid-1', { dueDate: null }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SettingsContainer: delete', () => {
  async function openDelete(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Delete bid' }));
    return screen.findByRole('alertdialog');
  }

  it('needs the typed bid name, deletes, refreshes, and goes to the bids list', async () => {
    const { api, shell, user } = renderContainer({ shell: { bid: bidDto({ creditStatus: 'consumed' }) } });
    await ready();
    const dialog = await openDelete(user);
    expect(within(dialog).getByText('Delete VA EHR Support?')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'This deletes the bid, its files, its archive copies, and every tab. The RFP credit used for this bid is not returned.',
      ),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Delete bid' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Type VA EHR Support to confirm'), 'VA EHR Support');
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    await waitFor(() => expect(window.location.hash).toBe('#/bids'));
    expect(api.deleteBid).toHaveBeenCalledWith('bid-1');
    expect(shell.refresh).toHaveBeenCalled();
  });

  it('shows a delete error inside the open dialog', async () => {
    const api = mockApi({ deleteBid: vi.fn(async () => Promise.reject(new ApiError('The bid could not be deleted.', 500))) });
    const { user } = renderContainer({ api });
    await ready();
    const dialog = await openDelete(user);
    await user.type(within(dialog).getByLabelText('Type VA EHR Support to confirm'), 'VA EHR Support');
    await user.click(within(dialog).getByRole('button', { name: 'Delete bid' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('alertdialog')).getByText(
          'This deletes the bid, its files, its archive copies, and every tab. The reserved RFP credit is released. The bid could not be deleted.',
        ),
      ).toBeTruthy(),
    );
    expect(window.location.hash).not.toBe('#/bids');
  });
});

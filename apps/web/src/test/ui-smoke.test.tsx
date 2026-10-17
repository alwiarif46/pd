// @vitest-environment jsdom
// Smoke renders of every integrated v0 component (src/ui) with its sample data: catches runtime breaks
// (a missing import, a crash on null) that tsc cannot. Tests live here, not in src/ui, which is generated.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProcessingState } from '@/types';
import { LogIn } from '@/ui/auth/LogIn';
import { ResetPassword } from '@/ui/auth/ResetPassword';
import { ResetRequest } from '@/ui/auth/ResetRequest';
import { SignUp } from '@/ui/auth/SignUp';
import { Verify } from '@/ui/auth/Verify';
import { BidsList } from '@/ui/bids/BidsList';
import { NewBid } from '@/ui/bids/NewBid';
import { OutOfCreditsMessage } from '@/ui/bids/OutOfCreditsMessage';
import { SAMPLE_BIDS, SAMPLE_CREDITS_RESET_ON } from '@/ui/bids/sample-data';
import { AmendmentConfirm } from '@/ui/common/AmendmentConfirm';
import { EmptyState } from '@/ui/common/EmptyState';
import { LockedTab } from '@/ui/common/LockedTab';
import { MarkingPrompt } from '@/ui/common/MarkingPrompt';
import { ProcessingBanner } from '@/ui/common/ProcessingBanner';
import { SAMPLE_AMENDMENTS, SAMPLE_MARKINGS, SAMPLE_PROCESSING } from '@/ui/common/sample-data';
import { SourceLink } from '@/ui/common/SourceLink';
import { TabFrame } from '@/ui/common/TabFrame';
import { AppShell } from '@/ui/shell/AppShell';
import { ConfirmDialog } from '@/ui/shell/ConfirmDialog';
import { UpgradeDialog } from '@/ui/shell/UpgradeDialog';

const noop = () => undefined;
const idle = { state: 'idle' } as const;

describe('auth', () => {
  it('renders each screen', () => {
    render(<LogIn status={idle} onLogIn={noop} onForgotPassword={noop} onSignUp={noop} />);
    render(<SignUp status={idle} onSignUp={noop} onLogIn={noop} onOpenPrivacy={noop} />);
    render(
      <Verify
        email="dana@example.gov"
        phone="2025550100"
        step="phone"
        status={{ state: 'error', message: 'That code is wrong.' }}
        onSubmitCode={noop}
        onResendEmail={noop}
        onResendCode={noop}
        onLogIn={noop}
      />,
    );
    render(<ResetRequest status={{ state: 'done', message: 'Sent.' }} onRequest={noop} onLogIn={noop} />);
    render(<ResetPassword status={idle} onSetPassword={noop} onLogIn={noop} />);
    expect(screen.getByText('That code is wrong.')).toBeTruthy();
  });
});

describe('bids', () => {
  it('renders the list with the sample bids', () => {
    render(
      <BidsList
        bids={SAMPLE_BIDS}
        creditsLeft={3}
        creditsResetOn={SAMPLE_CREDITS_RESET_ON}
        onOpen={noop}
        onCreate={noop}
        onUpgrade={noop}
      />,
    );
    expect(screen.getAllByText(SAMPLE_BIDS[0].name).length).toBeGreaterThan(0);
  });

  it('renders an empty list, new bid, and the out-of-credits message', () => {
    render(<BidsList bids={[]} creditsLeft={0} creditsResetOn={SAMPLE_CREDITS_RESET_ON} onOpen={noop} onCreate={noop} onUpgrade={noop} />);
    render(
      <NewBid
        creditsLeft={0}
        creditsResetOn={SAMPLE_CREDITS_RESET_ON}
        plan="free"
        mbCap={50}
        status={{ state: 'submitting' }}
        onCreate={noop}
        onCancel={noop}
        onUpgrade={noop}
      />,
    );
    render(<OutOfCreditsMessage creditsResetOn={SAMPLE_CREDITS_RESET_ON} onUpgrade={noop} />);
  });
});

describe('shell', () => {
  const bid = {
    id: '1',
    name: 'VA EHR Support Services',
    agency: 'Department of Veterans Affairs',
    dueDate: '2026-11-03',
    dueTime: '14:00',
    timeZone: 'America/New_York',
  };
  const base = {
    bids: [{ id: '1', name: 'VA EHR Support Services' }],
    plan: 'free' as const,
    creditsLeft: 3,
    creditsResetOn: '2026-11-01',
    tabSignals: [],
    user: { name: 'Dana Reyes', email: 'dana.reyes@example.gov' },
    detail: null,
    onSelectTab: noop,
    onSwitchBid: noop,
    onOpenPage: noop,
    onUpgrade: noop,
    onSignOut: noop,
  };

  it('renders inside a bid with the tab list and locked paid tabs', () => {
    render(
      <AppShell {...base} bid={bid} activeTab="overview" activePage={null} oralsEnabled={false}>
        <p>Tab content</p>
      </AppShell>,
    );
    expect(screen.getByText('Tab content')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Outline (locked)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Orals/ })).toBeNull();
    // Date-only strings: v0 splits them itself.
    expect(screen.getByText('Due Nov 3, 2:00 PM ET')).toBeTruthy();
    expect(screen.getByText(/resets Nov 1/)).toBeTruthy();
  });

  it('opens Account, Privacy and Sign out from the account menu', async () => {
    const onOpenPage = vi.fn();
    const onSignOut = vi.fn();
    render(
      <AppShell {...base} bid={bid} activeTab="overview" activePage={null} oralsEnabled onOpenPage={onOpenPage} onSignOut={onSignOut}>
        <p>Tab content</p>
      </AppShell>,
    );
    const menu = () => userEvent.click(screen.getByRole('button', { name: 'Account menu for Dana Reyes' }));
    await menu();
    expect(await screen.findByText('dana.reyes@example.gov')).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Account' }));
    await menu();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Privacy' }));
    await menu();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(onOpenPage.mock.calls).toEqual([['account'], ['privacy']]);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('switches bids from the bid switcher', async () => {
    const onSwitchBid = vi.fn();
    render(
      <AppShell
        {...base}
        bids={[{ id: '1', name: 'VA EHR Support Services' }, { id: '2', name: 'Navy IT' }]}
        bid={bid}
        activeTab="overview"
        activePage={null}
        oralsEnabled
        onSwitchBid={onSwitchBid}
      >
        <p>Tab content</p>
      </AppShell>,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Bid' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Navy IT' }));
    expect(onSwitchBid).toHaveBeenCalledWith('2');
  });

  it('sends both a locked and an open tab click to onSelectTab', async () => {
    const onUpgrade = vi.fn();
    const onSelectTab = vi.fn();
    render(
      <AppShell {...base} bid={bid} activeTab="overview" activePage={null} oralsEnabled onUpgrade={onUpgrade} onSelectTab={onSelectTab}>
        <p>Tab content</p>
      </AppShell>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Outline (locked)' }));
    expect(onSelectTab).toHaveBeenCalledWith('outline');
    expect(onUpgrade).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSelectTab).toHaveBeenCalledWith('schedule');
  });

  it('shows each tab signal with its aria-label', () => {
    render(
      <AppShell
        {...base}
        plan="growth"
        bid={bid}
        activeTab="overview"
        activePage={null}
        oralsEnabled
        tabSignals={[
          { tab: 'documents', signal: 'processing' },
          { tab: 'compliance', signal: 'failed' },
          { tab: 'schedule', signal: 'waiting' },
        ]}
      >
        <p>Tab content</p>
      </AppShell>,
    );
    expect(screen.getByRole('button', { name: 'Documents, Processing' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compliance, Failed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Schedule, Needs you' })).toBeTruthy();
  });

  it('opens the tab list in a sheet from the Menu button', async () => {
    const onSelectTab = vi.fn();
    render(
      <AppShell {...base} plan="growth" bid={bid} activeTab="overview" activePage={null} oralsEnabled onSelectTab={onSelectTab}>
        <p>Tab content</p>
      </AppShell>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const sheet = await screen.findByRole('dialog');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Documents' }));
    expect(onSelectTab).toHaveBeenCalledWith('documents');
  });

  it('opens Bids and Organization outside a bid', async () => {
    const onOpenPage = vi.fn();
    render(
      <AppShell {...base} bid={null} activeTab={null} activePage="bids" oralsEnabled onOpenPage={onOpenPage}>
        <p>Page</p>
      </AppShell>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Bids' }));
    await userEvent.click(screen.getByRole('button', { name: 'Organization' }));
    expect(onOpenPage.mock.calls).toEqual([['bids'], ['organization']]);
  });

  it('renders outside a bid with a detail column', () => {
    render(
      <AppShell {...base} bid={null} activeTab={null} activePage="bids" oralsEnabled plan="growth" detail={<p>Detail</p>}>
        <p>Page</p>
      </AppShell>,
    );
    expect(screen.getByRole('button', { name: 'Organization' })).toBeTruthy();
    expect(screen.getByText('Detail')).toBeTruthy();
    expect(within(screen.getByRole('complementary', { name: 'Row detail' })).getByText('Detail')).toBeTruthy();
  });

  it('always draws its children, also for a locked tab on Free', () => {
    render(
      <AppShell {...base} bid={bid} activeTab="outline" activePage={null} oralsEnabled>
        <p>Locked tab from the container</p>
      </AppShell>,
    );
    expect(screen.getByText('Locked tab from the container')).toBeTruthy();
  });

  it('shows Upgrade plan in the top bar only at 0 credits', () => {
    const { rerender } = render(
      <AppShell {...base} bid={bid} activeTab="overview" activePage={null} oralsEnabled>
        <p>Tab content</p>
      </AppShell>,
    );
    expect(screen.queryByRole('button', { name: 'Upgrade plan' })).toBeNull();
    rerender(
      <AppShell {...base} creditsLeft={0} bid={bid} activeTab="overview" activePage={null} oralsEnabled>
        <p>Tab content</p>
      </AppShell>,
    );
    expect(screen.getByRole('button', { name: 'Upgrade plan' })).toBeTruthy();
  });

  it('renders the dialogs open', () => {
    render(
      <UpgradeDialog
        open
        reason="out_of_credits"
        plan="starter"
        creditsLeft={0}
        creditsResetOn="2026-11-01T00:00:00.000Z"
        onChoosePlan={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Choose Growth' })).toBeTruthy();
    render(
      <ConfirmDialog
        open
        title="Delete VA EHR?"
        body="This cannot be undone."
        confirmLabel="Delete bid"
        typeToConfirm="VA EHR"
        busy={false}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete bid' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('common', () => {
  const frame = {
    tab: 'overview' as const,
    title: 'Overview',
    plan: 'free' as const,
    processing: null,
    waiting: null,
    overCap: null,
    draftNotice: false,
    onUploadSolicitation: noop,
    onRetry: noop,
    onUpgrade: noop,
  };

  it('renders every TabFrame block', () => {
    render(<TabFrame {...frame} block={{ kind: 'no_solicitation' }}>x</TabFrame>);
    render(<TabFrame {...frame} block={{ kind: 'failed', reason: 'We could not read this file.' }}>x</TabFrame>);
    render(<TabFrame {...frame} block={{ kind: 'locked', description: 'Paid.' }}>x</TabFrame>);
    render(
      <TabFrame {...frame} block={{ kind: 'out_of_credits', creditsLeft: 0, creditsResetOn: '2026-11-01T12:00:00' }}>
        x
      </TabFrame>,
    );
    expect(screen.getByText('We could not read this file.')).toBeTruthy();
    expect(screen.getByText('No solicitation yet')).toBeTruthy();
  });

  it('renders TabFrame banners around the content', () => {
    render(
      <TabFrame
        {...frame}
        block={null}
        processing={SAMPLE_PROCESSING}
        waiting={<MarkingPrompt fileName="rfp.pdf" markings={SAMPLE_MARKINGS} page={12} busy={false} onConfirm={noop} onRemoveFile={noop} />}
        overCap={{ usedBytes: 60 * 1048576, capMb: 50 }}
        draftNotice
      >
        <p>Rows</p>
      </TabFrame>,
    );
    expect(screen.getByText('Rows')).toBeTruthy();
    expect(screen.getByText('Needs you')).toBeTruthy();
  });

  it('renders the shared pieces with the sample data', () => {
    render(<AmendmentConfirm proposals={SAMPLE_AMENDMENTS} busyIds={['proposal-adds']} onConfirm={noop} onReject={noop} onOpenSource={noop} />);
    render(<EmptyState title="No items found" text="Add one by hand." action={{ label: 'Add item', onClick: noop }} />);
    render(<LockedTab tab="outline" title="Outline" description="Paid." onUpgrade={noop} />);
    const idleState: ProcessingState = { steps: [], queuePosition: null, etaSeconds: 30 };
    render(<ProcessingBanner processing={idleState} />);
    render(<SourceLink page={12} pageEnd={13} rowLabel="C.3.2" onOpen={noop} />);
    render(<SourceLink page={null} pageEnd={null} rowLabel="C.3.2" onOpen={noop} />);
    expect(screen.getByRole('button', { name: 'Open source for C.3.2, pages 12 to 13' })).toBeTruthy();
    expect(screen.getByText('No source')).toBeTruthy();
  });
});

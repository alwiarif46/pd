// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcceptInvite } from './AcceptInvite';
import type { AcceptInviteProps, InviteStep } from './types';

afterEach(cleanup);

const CODE = `${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}.${'b'.repeat(64)}`;

function setup(step: InviteStep, over: Partial<AcceptInviteProps> = {}) {
  const props: AcceptInviteProps = {
    step,
    submitting: false,
    onSubmitCode: vi.fn(),
    onAccept: vi.fn(),
    onSignUp: vi.fn(),
    onLogIn: vi.fn(),
    onSignOut: vi.fn(),
    onRetry: vi.fn(),
    onContinue: vi.fn(),
    ...over,
  };
  render(<AcceptInvite {...props} />);
  return props;
}

describe('AcceptInvite', () => {
  it('submits a well-formed code', async () => {
    const props = setup({ kind: 'enter_code' });
    await userEvent.type(screen.getByLabelText('Invite code'), `  ${CODE} `);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(props.onSubmitCode).toHaveBeenCalledWith(CODE);
  });

  it('shows an inline error for a bad code and does not submit', async () => {
    const props = setup({ kind: 'enter_code' });
    await userEvent.type(screen.getByLabelText('Invite code'), 'nonsense');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(props.onSubmitCode).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Invite code').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/does not look like an invite code/)).toBeTruthy();
  });

  it('offers Create account and Log in when signed out', async () => {
    const props = setup({ kind: 'signed_out' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(props.onSignUp).toHaveBeenCalledTimes(1);
    expect(props.onLogIn).toHaveBeenCalledTimes(1);
  });

  it('shows the email and accepts on click', async () => {
    const props = setup({ kind: 'ready', email: 'a@b.com' });
    expect(screen.getByText('You are signed in as a@b.com.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Join organization' }));
    expect(props.onAccept).toHaveBeenCalledTimes(1);
  });

  it('disables the button while submitting', () => {
    setup({ kind: 'ready', email: 'a@b.com' }, { submitting: true });
    expect((screen.getByRole('button', { name: 'Joining...' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('continues after joining', async () => {
    const props = setup({ kind: 'joined', orgName: 'Acme' });
    expect(screen.getByText('You joined Acme.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Shaavir PD' }));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('seats_full shows an alert and Try again', async () => {
    const props = setup({ kind: 'failed', reason: 'seats_full', message: 'No free seat.' });
    expect(screen.getByRole('alert').textContent).toContain('No free seat.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('email_mismatch offers sign out', async () => {
    const props = setup({ kind: 'failed', reason: 'email_mismatch', message: 'Wrong address.' });
    expect(screen.getByRole('alert')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out and use another account' }));
    expect(props.onSignOut).toHaveBeenCalledTimes(1);
  });

  it('other failures lead back into the app', async () => {
    const props = setup({ kind: 'failed', reason: 'expired', message: 'Expired.' });
    await userEvent.click(screen.getByRole('button', { name: 'Open Shaavir PD' }));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });
});

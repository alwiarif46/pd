// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeatLocked } from './SeatLocked';

afterEach(cleanup);

function setup(over: { checking?: boolean; email?: string } = {}) {
  const onCheckAgain = vi.fn();
  const onSignOut = vi.fn();
  render(
    <SeatLocked
      email={over.email ?? 'm@acme.com'}
      message="Your plan has no seat for you."
      checking={over.checking ?? false}
      onCheckAgain={onCheckAgain}
      onSignOut={onSignOut}
    />,
  );
  return { onCheckAgain, onSignOut };
}

describe('SeatLocked', () => {
  it('shows the message, the email and the help line', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'You have no seat right now' })).toBeTruthy();
    expect(screen.getByText('Your plan has no seat for you.')).toBeTruthy();
    expect(screen.getByText('Signed in as m@acme.com.')).toBeTruthy();
    expect(screen.getByText(/fewer seats than members/)).toBeTruthy();
  });

  it('fires Check again and Sign out', async () => {
    const { onCheckAgain, onSignOut } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('disables Check again while checking', () => {
    setup({ checking: true });
    expect((screen.getByRole('button', { name: 'Checking...' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves out the email line when unknown', () => {
    setup({ email: '' });
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });
});

// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduleDateChangePromptProps } from '@/types';
import { DateChangePrompt } from './DateChangePrompt';

function setup(over: Partial<ScheduleDateChangePromptProps> = {}) {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  render(
    <DateChangePrompt
      open
      previousDue="2026-11-25"
      nextDue="2026-12-02"
      amendmentNo={null}
      summary={null}
      workdaysOnly
      busy={false}
      onChoose={onChoose}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onChoose, onCancel };
}

const button = (name: string) => screen.getByRole('button', { name });

describe('DateChangePrompt', () => {
  it('asks the question with both dates', () => {
    setup();
    expect(
      screen.getByText('The due date moved from Wed, Nov 25, 2026 to Wed, Dec 2, 2026. Move the schedule with it?'),
    ).toBeTruthy();
    expect(screen.getByText('The due date changed')).toBeTruthy();
  });

  it('answers shift, scale, keep and cancel', async () => {
    const user = userEvent.setup();
    const { onChoose, onCancel } = setup();
    await user.click(button('Shift dates'));
    await user.click(button('Scale dates'));
    await user.click(button('Keep dates'));
    expect(onChoose.mock.calls).toEqual([['shift'], ['scale'], ['keep']]);
    await user.click(button('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('puts the focus on Shift dates by default', () => {
    setup();
    expect(document.activeElement).toBe(button('Shift dates'));
  });

  it('shows the summary sentences, or the fallbacks without one', () => {
    const { unmount } = render(
      <DateChangePrompt
        open
        previousDue="2026-11-25"
        nextDue="2026-12-02"
        amendmentNo={null}
        summary={{ shift: 'S sentence.', scale: 'C sentence.', keep: 'K sentence.' }}
        workdaysOnly
        busy={false}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('S sentence.')).toBeTruthy();
    expect(screen.getByText('C sentence.')).toBeTruthy();
    expect(screen.getByText('K sentence.')).toBeTruthy();
    unmount();
    setup();
    expect(screen.getByText('Moves unlocked activities by the same number of workdays.')).toBeTruthy();
    expect(
      screen.getByText('Stretches or squeezes unlocked activities between the start date and the new due date.'),
    ).toBeTruthy();
    expect(screen.getByText('Leaves every activity where it is.')).toBeTruthy();
  });

  it('uses days in the fallback when workdays only is off', () => {
    setup({ workdaysOnly: false });
    expect(screen.getByText('Moves unlocked activities by the same number of days.')).toBeTruthy();
  });

  it('handles 0 workdays: Friday to Saturday', () => {
    setup({ previousDue: '2026-11-27', nextDue: '2026-11-28' });
    expect(screen.getByText('That is 0 workdays, because Sat, Nov 28, 2026 is not a workday. Shifting moves no activity.')).toBeTruthy();
    expect(document.activeElement).toBe(button('Keep dates'));
  });

  it('handles 0 workdays: Christmas Eve to Christmas', () => {
    setup({ previousDue: '2026-12-24', nextDue: '2026-12-25' });
    expect(screen.getByText(/That is 0 workdays, because Fri, Dec 25, 2026 is not a workday/)).toBeTruthy();
    expect(document.activeElement).toBe(button('Keep dates'));
  });

  it('has no 0 workdays line when workdays only is off', () => {
    setup({ previousDue: '2026-11-27', nextDue: '2026-11-28', workdaysOnly: false });
    expect(screen.queryByText(/0 workdays/)).toBeNull();
    expect(document.activeElement).toBe(button('Shift dates'));
  });

  it('warns when the new due date is a weekend but the move is not 0 workdays', () => {
    setup({ previousDue: '2026-11-25', nextDue: '2026-11-29' });
    expect(screen.getByText('Sun, Nov 29, 2026 is not a workday.')).toBeTruthy();
    expect(screen.queryByText(/That is 0 workdays/)).toBeNull();
  });

  it('names the amendment in the title', () => {
    setup({ amendmentNo: 3 });
    expect(screen.getByText('Amendment 3 moved the due date')).toBeTruthy();
  });

  it('disables every button while busy', () => {
    setup({ busy: true });
    for (const name of ['Cancel', 'Keep dates', 'Scale dates', 'Shift dates']) {
      expect((button(name) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

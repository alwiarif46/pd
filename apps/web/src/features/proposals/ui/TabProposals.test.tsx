// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TabProposal, TabProposalsProps } from '@/types';
import { TabProposals } from './TabProposals';

const fact: TabProposal = {
  id: 'link-a',
  rowId: 'fact-new',
  amendmentNo: 2,
  next: { kind: 'fact', label: 'Agency', value: 'GSA' },
  replaces: [
    { rowId: 'fact-1', subject: { kind: 'fact', label: 'Agency', value: 'VA' }, isAi: false, sourcePage: null, sourcePageEnd: null },
    { rowId: 'fact-ai', subject: { kind: 'fact', label: 'Agency', value: 'Veterans Affairs' }, isAi: true, sourcePage: 1, sourcePageEnd: null },
  ],
  sourcePage: 4,
  sourcePageEnd: null,
  sourceQuote: 'The contracting agency is GSA.',
};

function renderPanel(over: Partial<TabProposalsProps> = {}) {
  const props: TabProposalsProps = {
    subject: 'facts',
    proposals: [fact],
    busyIds: [],
    onInsert: vi.fn(),
    onDismiss: vi.fn(),
    onOpenSource: vi.fn(),
    ...over,
  };
  return { props, user: userEvent.setup(), ...render(<TabProposals {...props} />) };
}

describe('TabProposals', () => {
  it('draws each proposal with what it replaces and its quote', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Changes from amendments' })).toBeTruthy();
    expect(screen.getByText(/Insert the new value, or dismiss it to keep yours\./)).toBeTruthy();
    const card = screen.getByRole('article', { name: 'Amendment 2: Agency' });
    expect(within(card).getByText('Agency: GSA')).toBeTruthy();
    expect(within(card).getByText('Amd 2')).toBeTruthy();
    expect(within(card).getByText('Replaces Agency: VA')).toBeTruthy();
    expect(within(card).getByText('“The contracting agency is GSA.”')).toBeTruthy();
    expect(card.textContent).not.toMatch(/\$|confidence/i);
  });

  it('says dates for the schedule, with the range or No date', () => {
    renderPanel({
      subject: 'dates',
      proposals: [
        { ...fact, next: { kind: 'activity', label: 'Proposal due', start: '2026-12-02', end: '2026-12-02' }, replaces: [] },
        { ...fact, id: 'link-b', next: { kind: 'activity', label: 'Orals', start: null, end: null }, replaces: [] },
      ],
    });
    expect(screen.getByText(/Insert the new date, or dismiss it to keep yours\./)).toBeTruthy();
    expect(screen.getByText(/^Proposal due, /)).toBeTruthy();
    expect(screen.getByText('Orals, No date')).toBeTruthy();
    expect(screen.getAllByText('The row it replaced was removed. Insert adds this one.')).toHaveLength(2);
  });

  it('sends the link id on Insert and Dismiss', async () => {
    const { props, user } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(props.onInsert).toHaveBeenCalledWith('link-a');
    expect(props.onDismiss).toHaveBeenCalledWith('link-a');
  });

  it('disables both buttons while busy', () => {
    renderPanel({ busyIds: ['link-a'] });
    expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('has a source control for the proposal and for an AI old row, not for a user row', async () => {
    const { props, user } = renderPanel();
    await user.click(screen.getByRole('button', { name: 'Open source for Agency, page 4' }));
    expect(props.onOpenSource).toHaveBeenCalledWith('fact-new');
    await user.click(screen.getByRole('button', { name: 'Open source for the replaced Agency, page 1' }));
    expect(props.onOpenSource).toHaveBeenLastCalledWith('fact-ai');
    expect(screen.getAllByRole('button', { name: /^Open source/ })).toHaveLength(2);
  });

  it('shows No source when the proposal has no page', () => {
    renderPanel({ proposals: [{ ...fact, sourcePage: null, replaces: [] }] });
    expect(screen.getByText('No source')).toBeTruthy();
  });

  it('renders nothing without proposals', () => {
    const { container } = renderPanel({ proposals: [] });
    expect(container.innerHTML).toBe('');
  });
});

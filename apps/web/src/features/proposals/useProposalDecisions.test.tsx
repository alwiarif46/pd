// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ApiError, type AmendmentDecisionDto } from '@/api';
import type { TabProposal } from '@/types';
import { ROW_ALREADY_CLOSED_MESSAGE, type ProposalApi } from './controller';
import { useProposalDecisions } from './useProposalDecisions';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

const proposal: TabProposal = {
  id: 'link-a',
  rowId: 'fact-new',
  amendmentNo: 2,
  next: { kind: 'fact', label: 'Agency', value: 'GSA' },
  replaces: [],
  sourcePage: null,
  sourcePageEnd: null,
  sourceQuote: null,
};
const ok: AmendmentDecisionDto = { ok: true, status: 'confirmed', amendmentStatus: 'applied' };

describe('useProposalDecisions', () => {
  it('sends one decision per proposal at a time, then settles', async () => {
    let finish!: (v: AmendmentDecisionDto) => void;
    const api: ProposalApi = {
      confirmAmendmentLink: vi.fn(() => new Promise<AmendmentDecisionDto>((resolve) => (finish = resolve))),
      rejectAmendmentLink: vi.fn(async () => ok),
    };
    const onSettled = vi.fn();
    const { result } = renderHook(() => useProposalDecisions({ api, onSettled }));
    act(() => {
      result.current.decide(proposal, 'insert');
      result.current.decide(proposal, 'insert');
      result.current.decide(proposal, 'dismiss');
    });
    expect(result.current.busyIds).toEqual(['link-a']);
    expect(api.confirmAmendmentLink).toHaveBeenCalledTimes(1);
    expect(api.rejectAmendmentLink).not.toHaveBeenCalled();
    await act(async () => finish(ok));
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(result.current.busyIds).toEqual([]);
    expect(toast.success).toHaveBeenCalledWith('Inserted the change from Amendment 2.');
  });

  it('shows a refusal and still settles, and the proposal can be decided again', async () => {
    const api: ProposalApi = {
      confirmAmendmentLink: vi.fn(async () => Promise.reject(new ApiError('x', 409, 'row_already_closed'))),
      rejectAmendmentLink: vi.fn(async () => ok),
    };
    const onSettled = vi.fn();
    const { result } = renderHook(() => useProposalDecisions({ api, onSettled }));
    act(() => result.current.decide(proposal, 'insert'));
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(ROW_ALREADY_CLOSED_MESSAGE);
    act(() => result.current.decide(proposal, 'dismiss'));
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
    expect(api.rejectAmendmentLink).toHaveBeenCalledWith('link-a');
  });
});

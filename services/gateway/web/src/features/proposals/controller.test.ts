import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AmendmentDecisionDto } from '@/api';
import { FALLBACK_MESSAGE } from '@/features/shared/messages';
import {
  decideProposal,
  NEW_ROW_MISSING_MESSAGE,
  PROPOSAL_GONE_MESSAGE,
  ROW_ALREADY_CLOSED_MESSAGE,
  type ProposalApi,
} from './controller';

const decided = (status: 'confirmed' | 'rejected'): AmendmentDecisionDto => ({ ok: true, status, amendmentStatus: 'applied' });

function deps(error?: unknown): ProposalApi {
  return {
    confirmAmendmentLink: vi.fn(async () => (error ? Promise.reject(error) : decided('confirmed'))),
    rejectAmendmentLink: vi.fn(async () => (error ? Promise.reject(error) : decided('rejected'))),
  };
}

const p = { id: 'link-a', amendmentNo: 2 };

describe('decideProposal', () => {
  it('inserts by confirming the link', async () => {
    const d = deps();
    expect(await decideProposal(d, p, 'insert')).toEqual({ kind: 'done', message: 'Inserted the change from Amendment 2.' });
    expect(d.confirmAmendmentLink).toHaveBeenCalledWith('link-a');
    expect(d.rejectAmendmentLink).not.toHaveBeenCalled();
  });

  it('dismisses by rejecting the link', async () => {
    const d = deps();
    expect(await decideProposal(d, p, 'dismiss')).toEqual({
      kind: 'done',
      message: 'Dismissed the change from Amendment 2. Your row stays.',
    });
    expect(d.rejectAmendmentLink).toHaveBeenCalledWith('link-a');
    expect(d.confirmAmendmentLink).not.toHaveBeenCalled();
  });

  it('says "the amendment" without a number', async () => {
    expect((await decideProposal(deps(), { id: 'link-a', amendmentNo: null }, 'insert')).message).toBe(
      'Inserted the change from the amendment.',
    );
  });

  it.each([
    [new ApiError('Reject it instead.', 409, 'row_already_closed'), ROW_ALREADY_CLOSED_MESSAGE],
    [new ApiError('The row was removed.', 409, 'new_row_missing'), NEW_ROW_MISSING_MESSAGE],
    [new ApiError('This change was already rejected.', 409, 'link_already_decided'), 'This change was already rejected.'],
    [new ApiError('Not found.', 404), PROPOSAL_GONE_MESSAGE],
    [new ApiError('Server error.', 500), 'Server error.'],
    [new Error('boom'), FALLBACK_MESSAGE],
  ])('words a refusal: %s', async (error, message) => {
    expect(await decideProposal(deps(error), p, 'insert')).toEqual({ kind: 'refused', message });
  });
});

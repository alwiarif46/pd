import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api';
import { decideLink, runAction, upgradeReasonFor, type TabFrameApi } from './actions';

function mockApi(over: Partial<TabFrameApi> = {}): TabFrameApi {
  return {
    retryJob: vi.fn(async () => ({ id: 'job-2' })),
    confirmMarking: vi.fn(async () => ({ ok: true as const })),
    deleteDocument: vi.fn(async () => ({ ok: true as const })),
    confirmAmendmentLink: vi.fn(async () => ({ ok: true as const, status: 'confirmed' as const, amendmentStatus: 'applied' as const })),
    rejectAmendmentLink: vi.fn(async () => ({ ok: true as const, status: 'rejected' as const, amendmentStatus: 'applied' as const })),
    ...over,
  };
}

describe('runAction', () => {
  it('is ok when the call resolves, and carries the API message when it fails', async () => {
    expect(await runAction(async () => undefined)).toEqual({ ok: true });
    expect(await runAction(async () => Promise.reject(new ApiError('This file was deleted.', 409, 'document_deleted')))).toEqual({
      ok: false,
      message: 'This file was deleted.',
    });
    expect(await runAction(async () => Promise.reject(new Error('x')))).toEqual({ ok: false, message: 'Something went wrong. Try again.' });
  });
});

describe('decideLink', () => {
  it('confirms or rejects the link', async () => {
    const api = mockApi();
    await decideLink(api, 'l1', 'confirm');
    await decideLink(api, 'l2', 'reject');
    expect(api.confirmAmendmentLink).toHaveBeenCalledWith('l1');
    expect(api.rejectAmendmentLink).toHaveBeenCalledWith('l2');
  });

  it('shows a final decision conflict as given', async () => {
    const message = 'This amendment change was already decided. Decisions are final.';
    const api = mockApi({ confirmAmendmentLink: vi.fn(async () => Promise.reject(new ApiError(message, 409, 'link_already_decided'))) });
    expect(await decideLink(api, 'l1', 'confirm')).toEqual({ ok: false, message });
  });
});

describe('upgradeReasonFor', () => {
  it('maps the frame state to the dialog reason', () => {
    expect(upgradeReasonFor({ kind: 'locked', description: '' }, false)).toBe('locked_tab');
    expect(upgradeReasonFor({ kind: 'out_of_credits', creditsLeft: 0, creditsResetOn: '' }, true)).toBe('out_of_credits');
    expect(upgradeReasonFor(null, true)).toBe('over_cap');
    expect(upgradeReasonFor(null, false)).toBe('plan');
  });
});

import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api';
import { DUPLICATE_MESSAGE, messageOf, noticeFor, toFlags, toFormStatus } from './messages';

describe('messageOf and toFormStatus', () => {
  it('shows the API message as given, else the fallback', () => {
    expect(messageOf(new ApiError('Name is required', 400))).toBe('Name is required');
    expect(messageOf(new ApiError('', 500))).toBe('Something went wrong. Try again.');
    expect(messageOf(new TypeError('x'), 'Could not save.')).toBe('Could not save.');
    expect(toFormStatus(new ApiError('Too long', 400))).toEqual({ state: 'error', message: 'Too long' });
    expect(toFormStatus(null, 'Could not save.')).toEqual({ state: 'error', message: 'Could not save.' });
  });
});

describe('noticeFor', () => {
  it('turns an upload refusal into an error notice, and a duplicate into an info notice', () => {
    const file = { name: 'rfp.pdf' };
    const cap = 'This file is larger than the space left on this bid.';
    expect(noticeFor(new ApiError(cap, 413, 'bid_cap_exceeded'), file, 'n1')).toEqual({ id: 'n1', fileName: 'rfp.pdf', tone: 'error', message: cap });
    expect(noticeFor('duplicate', file, 'n2')).toEqual({ id: 'n2', fileName: 'rfp.pdf', tone: 'info', message: DUPLICATE_MESSAGE });
  });
});

describe('toFlags', () => {
  it('keeps known flags once, in order, and adds quote_unverified for AI rows', () => {
    expect(toFlags({ flags: ['ocr', 'weird', 'maybe_not_requirement', 'ocr'], origin: 'ai', quoteVerified: true })).toEqual([
      'maybe_not_requirement',
      'ocr',
    ]);
    expect(toFlags({ flags: null, origin: 'ai', quoteVerified: false })).toEqual(['quote_unverified']);
    expect(toFlags({ flags: null, origin: 'user', quoteVerified: false })).toEqual([]);
    expect(toFlags({ flags: ['quote_unverified'], origin: 'ai', quoteVerified: false })).toEqual(['quote_unverified']);
  });
});

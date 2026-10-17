import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api';
import { docDto, jobDto, linkDto } from '@/test/fixtures';
import { toProposals } from '@/features/tab-frame/derive';
import { AMENDMENT_NO_TAKEN_MESSAGE, percentOf, proposalSourceRowIds, toDoc, uploadFailureNotice } from './controller';

const doc = (over: Parameters<typeof docDto>[0] = {}) => {
  const dto = docDto(over);
  return toDoc(dto, [], [dto]);
};

describe('toDoc: fields', () => {
  it('maps the stored names and keeps the full upload timestamp and the live-until day', () => {
    expect(doc({ fileName: 'rfp.pdf', sizeBytes: 5, liveUntil: '2026-11-03T00:00:00.000Z', createdAt: '2026-10-01T12:34:56.000Z' })).toMatchObject({
      id: 'doc-1',
      name: 'rfp.pdf',
      kind: 'solicitation',
      sizeBytes: 5,
      uploadedAt: '2026-10-01T12:34:56.000Z',
      liveUntil: '2026-11-03',
      keyCheck: 'not_applicable',
    });
    expect(doc({ liveUntil: null }).liveUntil).toBeNull();
  });

  it('shows the page count, an estimate when there is no count, or nothing', () => {
    expect(doc({ pageCount: 40, pagesEstimated: 44 })).toMatchObject({ pages: 40, pagesEstimated: false });
    expect(doc({ pageCount: null, pagesEstimated: 44 })).toMatchObject({ pages: 44, pagesEstimated: true });
    expect(doc({ pageCount: null, pagesEstimated: null })).toMatchObject({ pages: null, pagesEstimated: false });
  });
});

describe('toDoc: status', () => {
  it('is live for a live file, deleted for a deleted one', () => {
    expect(doc().status).toEqual({ state: 'live' });
    expect(doc({ liveStatus: 'deleted' }).status).toEqual({ state: 'deleted' });
  });

  it('passes archived, restore requested and restoring through, and the restored-until day', () => {
    expect(doc({ liveStatus: 'archived' }).status).toEqual({ state: 'archived' });
    expect(doc({ liveStatus: 'restore_requested' }).status).toEqual({ state: 'restore_requested' });
    expect(doc({ liveStatus: 'restoring' }).status).toEqual({ state: 'restoring' });
    expect(doc({ liveStatus: 'restored', restoredUntil: '2026-11-20T00:00:00.000Z' }).status).toEqual({ state: 'restored', until: '2026-11-20' });
    // A restored file with no restored-until date has no date to show: it is simply live (Open stays available).
    expect(doc({ liveStatus: 'restored', restoredUntil: null }).status).toEqual({ state: 'live' });
  });

  it('is processing while the scan or extraction is pending, with no queue position', () => {
    expect(doc({ scanStatus: 'pending' }).status).toEqual({ state: 'processing', queuePosition: null });
    expect(doc({ extractStatus: 'pending' }).status).toEqual({ state: 'processing', queuePosition: null });
  });

  it('is processing with the lowest queue position among the file’s active jobs', () => {
    const dto = docDto();
    const jobs = [
      jobDto({ id: 'j1', status: 'pending', queuePosition: 4 }),
      jobDto({ id: 'j2', status: 'running', queuePosition: 2, type: 'classify' }),
      jobDto({ id: 'j3', status: 'pending', queuePosition: 1, documentId: 'other' }),
      jobDto({ id: 'j4', status: 'completed', queuePosition: 0 }),
    ];
    expect(toDoc(dto, jobs, [dto]).status).toEqual({ state: 'processing', queuePosition: 2 });
    expect(toDoc(dto, [jobDto({ status: 'running', queuePosition: null })], [dto]).status).toEqual({ state: 'processing', queuePosition: null });
  });

  it('is failed with a plain reason when the latest job for the file failed', () => {
    const dto = docDto();
    expect(toDoc(dto, [jobDto({ status: 'failed', type: 'scan', error: 'secret stack trace' })], [dto]).status).toEqual({
      state: 'failed',
      reason: 'We could not read this file.',
    });
    const locked = docDto({ encryption: 'user_password' });
    expect(toDoc(locked, [jobDto({ status: 'failed' })], [locked]).status).toEqual({ state: 'failed', reason: 'Upload an unlocked copy.' });
  });

  it('ignores a failure that a later job for the same step cleared, and a failure of another file', () => {
    const dto = docDto();
    const jobs = [
      jobDto({ id: 'j1', status: 'failed', createdAt: '2026-10-01T00:00:00.000Z' }),
      jobDto({ id: 'j2', status: 'completed', createdAt: '2026-10-02T00:00:00.000Z' }),
      jobDto({ id: 'j3', status: 'failed', documentId: 'other' }),
    ];
    expect(toDoc(dto, jobs, [dto]).status).toEqual({ state: 'live' });
  });

  it('shows a deleted file as deleted even when a job failed for it', () => {
    const dto = docDto({ liveStatus: 'deleted' });
    expect(toDoc(dto, [jobDto({ status: 'failed' })], [dto]).status).toEqual({ state: 'deleted' });
  });
});

describe('toDoc: marking and key check', () => {
  it('maps a blocked marking with its names and page, and falls back when none were named', () => {
    expect(doc({ markingStatus: 'blocked', markingFound: ['CUI', 'FOUO'], markingPage: 2 }).marking).toEqual({
      state: 'blocked',
      markings: ['CUI', 'FOUO'],
      page: 2,
    });
    expect(doc({ markingStatus: 'blocked', markingFound: null, markingPage: null }).marking).toEqual({
      state: 'blocked',
      markings: ['a controlled marking'],
      page: null,
    });
    expect(doc({ markingStatus: 'blocked', markingFound: [] }).marking).toMatchObject({ markings: ['a controlled marking'] });
  });

  it('maps confirmed and none', () => {
    expect(doc({ markingStatus: 'confirmed', markingFound: ['CUI'] }).marking).toEqual({ state: 'confirmed', markings: ['CUI'] });
    expect(doc({ markingStatus: 'confirmed', markingFound: null }).marking).toEqual({ state: 'confirmed', markings: [] });
    expect(doc({ markingStatus: 'none' }).marking).toEqual({ state: 'none' });
    expect(doc({ markingStatus: null }).marking).toEqual({ state: 'none' });
  });

  it('passes the key check through', () => {
    for (const keyCheck of ['not_applicable', 'ok', 'mismatch', 'overridden'] as const) {
      expect(doc({ kind: 'amendment', keyCheck }).keyCheck).toBe(keyCheck);
    }
  });
});

describe('toDoc: the amendment number fields', () => {
  it('assumes the number only when it came from the sequence', () => {
    expect(doc({ kind: 'amendment', amendmentNo: 2, amendmentNoSource: 'sequence' }).amendmentNoAssumed).toBe(true);
    expect(doc({ kind: 'amendment', amendmentNo: 2, amendmentNoSource: 'document' }).amendmentNoAssumed).toBe(false);
    expect(doc({ kind: 'amendment', amendmentNo: 2, amendmentNoSource: 'user' }).amendmentNoAssumed).toBe(false);
    expect(doc({ amendmentNoSource: null }).amendmentNoAssumed).toBe(false);
  });

  it('reports the number the file reads only when it differs from the one used', () => {
    expect(doc({ kind: 'amendment', amendmentNo: 2, amendmentNoFound: 3 }).amendmentNoFound).toBe(3);
    expect(doc({ kind: 'amendment', amendmentNo: 3, amendmentNoFound: 3 }).amendmentNoFound).toBeNull();
    expect(doc({ kind: 'amendment', amendmentNo: null, amendmentNoFound: 3 }).amendmentNoFound).toBe(3);
    expect(doc({ kind: 'amendment', amendmentNo: 2, amendmentNoFound: null }).amendmentNoFound).toBeNull();
  });

  it('needs a number only while the amendment waits for one', () => {
    expect(doc({ kind: 'amendment', amendmentStatus: 'needs_number' }).needsNumber).toBe(true);
    expect(doc({ kind: 'amendment', amendmentStatus: 'applied' }).needsNumber).toBe(false);
    expect(doc({ kind: 'amendment', amendmentStatus: null }).needsNumber).toBe(false);
  });
});

describe('upload notices', () => {
  const file = { name: 'amd.pdf' };

  it('shows the API’s message as given, and the duplicate line', () => {
    expect(uploadFailureNotice(new ApiError('Upload an unlocked copy.', 422), file, 'n1')).toEqual({
      id: 'n1',
      fileName: 'amd.pdf',
      tone: 'error',
      message: 'Upload an unlocked copy.',
    });
    expect(uploadFailureNotice(new ApiError('Amendment number must be 1 to 999', 400), file, 'n2').message).toBe('Amendment number must be 1 to 999');
  });

  it('says another amendment has the number for a 409 amendment_no_taken, and only for that code', () => {
    expect(uploadFailureNotice(new ApiError('conflict', 409, 'amendment_no_taken'), file, 'n3').message).toBe(AMENDMENT_NO_TAKEN_MESSAGE);
    expect(AMENDMENT_NO_TAKEN_MESSAGE).toBe('Another amendment on this bid already has that number.');
    expect(uploadFailureNotice(new ApiError('This file belongs to a different solicitation. Start a new bid.', 409, 'key_mismatch'), file, 'n4').message).toBe(
      'This file belongs to a different solicitation. Start a new bid.',
    );
  });

  it('falls back for an unknown error', () => {
    expect(uploadFailureNotice(new Error('boom'), file, 'n5').message).toBe('Something went wrong. Try again.');
  });
});

describe('percentOf', () => {
  it('rounds and clamps chunk progress', () => {
    expect(percentOf({ chunksSent: 1, chunkCount: 3 })).toBe(33);
    expect(percentOf({ chunksSent: 3, chunkCount: 3 })).toBe(100);
    expect(percentOf({ chunksSent: 5, chunkCount: 3 })).toBe(100);
    expect(percentOf({ chunksSent: 0, chunkCount: 0 })).toBe(0);
  });
});

describe('proposalSourceRowIds', () => {
  it('lists the old row then the new row of each card that has a source page', () => {
    const proposals = toProposals([
      linkDto({ id: 'a' }),
      linkDto({
        id: 'b',
        action: 'withdraw',
        oldRow: { rowId: 'row-x', label: 'C.4', text: 'x', sourcePage: 5 },
        newRow: null,
      }),
      linkDto({
        id: 'c',
        oldRow: { rowId: 'row-y', label: 'C.5', text: 'y', sourcePage: null },
        newRow: { rowId: 'row-z', label: 'C.5', text: 'z', sourcePage: 9 },
      }),
    ]);
    expect(proposalSourceRowIds(proposals)).toEqual(['row-old', 'row-new', 'row-x', 'row-z']);
  });
});

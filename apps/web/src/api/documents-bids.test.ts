import { describe, expect, it } from 'vitest';
import { jsonBody, jsonResponse, lastCall, mockFetch } from '../test/fetch';
import { BID_STATUSES, createBid, isBidStatus, updateBid } from './bids';
import { listDocuments, overrideSolicitationKey, restoreDocument } from './documents';
import { ApiError } from './errors';
import type { BidDto, DocumentDto } from './types';

const bid: BidDto = {
  id: 'b1',
  orgId: 'o1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  name: 'Bid',
  agency: null,
  bidType: 'federal',
  solicitationNumber: 'W912',
  solicitationKey: 'W912',
  status: 'planning',
  startDate: null,
  dueDate: '2026-12-01T00:00:00.000Z',
  dueTime: null,
  timeZone: null,
  countMode: null,
  oralsEnabled: false,
  scheduleWorkdaysOnly: true,
  creditId: null,
  creditStatus: null,
  keyOverridesUsed: 0,
  retentionExtendedUntil: null,
  defaultLiveUntil: '2027-03-01T00:00:00.000Z',
  filesLiveUntil: '2027-03-01T00:00:00.000Z',
  keyOverridesLeft: 2,
};

const doc: DocumentDto = {
  id: 'd1',
  orgId: 'o1',
  bidId: 'b1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  fileName: 'amendment-1.pdf',
  mime: 'application/pdf',
  sizeBytes: 10,
  sha256: 'x',
  kind: 'amendment',
  amendmentNo: 1,
  storagePath: null,
  viewerPath: null,
  extractMethod: 'pdf_text',
  pagesEstimated: null,
  pageCount: 3,
  encryption: 'none',
  scanStatus: 'clean',
  extractStatus: 'done',
  markingFound: ['CUI'],
  markingStatus: 'blocked',
  markingPage: 2,
  liveUntil: '2026-12-30T00:00:00.000Z',
  liveStatus: 'restored',
  restoredUntil: '2026-10-22T00:00:00.000Z',
  keyCheck: 'mismatch',
  keyReason: 'mismatch',
  keyFound: 'W912-24-R-0002',
  amendmentNoSource: 'sequence',
  amendmentNoFound: null,
  amendmentStatus: 'held',
};

describe('bid status', () => {
  it('lists the four statuses in order and recognizes only them', () => {
    expect(BID_STATUSES).toEqual(['planning', 'writing', 'submitted', 'closed']);
    expect(BID_STATUSES.every(isBidStatus)).toBe(true);
    expect(isBidStatus('draft')).toBe(false);
    expect(isBidStatus(undefined)).toBe(false);
  });

  it('updateBid sends the status and returns the bid with its live-until dates', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { ...bid, status: 'writing' }));
    const updated = await updateBid('b1', { status: 'writing' });
    expect(updated.status).toBe('writing');
    expect(updated.filesLiveUntil).toBe('2027-03-01T00:00:00.000Z');
    expect(updated.keyOverridesLeft).toBe(2);
    const call = lastCall(fetchMock);
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe('/api/bids/b1');
    expect(jsonBody(call)).toEqual({ status: 'writing' });
  });

  it('a refused status arrives as an ApiError with status 400', async () => {
    mockFetch(jsonResponse(400, { error: 'Status must be one of: planning, writing, submitted, closed.' }));
    const error = await updateBid('b1', { status: 'draft' as never }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toMatch(/planning, writing/);
  });

  it('createBid returns a planning bid', async () => {
    mockFetch(jsonResponse(201, bid));
    await expect(createBid({ name: 'Bid', bidType: 'federal' })).resolves.toMatchObject({ status: 'planning', defaultLiveUntil: bid.defaultLiveUntil });
  });
});

describe('documents', () => {
  it('listDocuments returns restoredUntil, markingPage, keyCheck, and liveUntil as sent', async () => {
    mockFetch(jsonResponse(200, [doc]));
    const [first] = await listDocuments('b1');
    expect(first).toMatchObject({
      liveStatus: 'restored',
      restoredUntil: '2026-10-22T00:00:00.000Z',
      markingPage: 2,
      keyCheck: 'mismatch',
      liveUntil: '2026-12-30T00:00:00.000Z',
    });
  });

  it('restoreDocument posts and returns the restore state', async () => {
    const fetchMock = mockFetch(jsonResponse(200, { status: 'restore_requested' }), jsonResponse(200, { status: 'restoring' }));
    await expect(restoreDocument('d1')).resolves.toEqual({ status: 'restore_requested' });
    expect(lastCall(fetchMock)).toMatchObject({ method: 'POST', url: '/api/documents/d1/restore' });
    // A repeat while the restore is pending answers with the current state.
    await expect(restoreDocument('d1')).resolves.toEqual({ status: 'restoring' });
  });

  it('a restore refused on the free plan carries the plan_required code', async () => {
    mockFetch(jsonResponse(402, { error: 'Restoring archived files needs a Starter or Growth plan.', code: 'plan_required' }));
    const error = await restoreDocument('d1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(402);
    expect((error as ApiError).code).toBe('plan_required');
  });

  it('overrideSolicitationKey returns the overrides left', async () => {
    mockFetch(jsonResponse(200, { ok: true, amendmentId: 'a1', remaining: 0 }));
    await expect(overrideSolicitationKey('d1', 'SLED addendum')).resolves.toEqual({ ok: true, amendmentId: 'a1', remaining: 0 });
  });

  it('an exhausted override limit arrives as override_limit', async () => {
    mockFetch(jsonResponse(409, { error: 'This bid has used all of its solicitation key overrides.', code: 'override_limit' }));
    const error = await overrideSolicitationKey('d1', 'again').catch((caught: unknown) => caught);
    expect((error as ApiError).code).toBe('override_limit');
  });
});

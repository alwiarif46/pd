import { describe, expect, it } from 'vitest';
import { jsonResponse, lastCall, mockFetch } from '../test/fetch';
import { listAmendmentLinks } from './amendments';
import { listJobs } from './jobs';
import type { AmendmentLinkDto, JobDto } from './types';

describe('jobs and amendment links DTOs', () => {
  it('returns the stage and ETA fields of a job as sent', async () => {
    const job = {
      id: 'j1', orgId: 'o', bidId: 'b', documentId: 'd', type: 'scan', status: 'pending', progress: 0,
      queuePosition: 2, queueDepth: 5, stage: 'scan', etaSeconds: 40, error: null, startedAt: null, finishedAt: null,
    } as unknown as JobDto;
    const fetchMock = mockFetch(jsonResponse(200, [job]));
    const [first] = await listJobs('b');
    expect(lastCall(fetchMock).url).toContain('/api/bids/b/jobs');
    expect(first.stage).toBe('scan');
    expect(first.etaSeconds).toBe(40);
    expect(first.queuePosition).toBe(2);
  });

  it('keeps a null ETA and a null stage', async () => {
    mockFetch(jsonResponse(200, [{ id: 'j2', stage: null, etaSeconds: null, queuePosition: null, queueDepth: 0 }]));
    const [first] = await listJobs('b');
    expect(first.etaSeconds).toBeNull();
    expect(first.stage).toBeNull();
  });

  it('returns the amendment number and joined rows, with a null old row on add', async () => {
    const link = {
      id: 'l1', amendmentNo: 2, action: 'add', oldRow: null,
      newRow: { rowId: 'r1', label: 'L.3', text: 'The offeror shall.', sourcePage: 4 },
    } as unknown as AmendmentLinkDto;
    mockFetch(jsonResponse(200, [link]));
    const [first] = await listAmendmentLinks('b');
    expect(first.amendmentNo).toBe(2);
    expect(first.oldRow).toBeNull();
    expect(first.newRow?.label).toBe('L.3');
  });
});

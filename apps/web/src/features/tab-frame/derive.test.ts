import { describe, expect, it } from 'vitest';
import type { Tab } from '@/types';
import { bidDto, docDto, jobDto, linkDto } from '@/test/fixtures';
import {
  deriveTabFrame,
  failedJobs,
  failureReason,
  processingState,
  tabSignals,
  toConfidence,
  toProposals,
  type BidSnapshot,
} from './derive';

const MB = 1024 * 1024;

function snapshot(over: Partial<BidSnapshot> = {}): BidSnapshot {
  return {
    plan: 'starter',
    creditsLeft: 5,
    creditsResetOn: '2026-11-01T00:00:00.000Z',
    mbCap: 300,
    bid: bidDto(),
    docs: [docDto()],
    jobs: [],
    links: [],
    ...over,
  };
}

describe('deriveTabFrame blocks', () => {
  it('locks paid tabs on Free with the tab description, and nothing else', () => {
    for (const tab of ['outline', 'resumes', 'reviews', 'production', 'orals', 'lessons'] as Tab[]) {
      const model = deriveTabFrame(snapshot({ plan: 'free', docs: [] }), tab);
      expect(model.block?.kind).toBe('locked');
      expect(model.block && 'description' in model.block && model.block.description).toBeTruthy();
      expect(model.processing).toBeNull();
    }
    expect(deriveTabFrame(snapshot({ plan: 'free' }), 'compliance').block).toBeNull();
    expect(deriveTabFrame(snapshot({ plan: 'starter' }), 'outline').block).toBeNull();
  });

  it('asks for a solicitation when there is none, or only a deleted one', () => {
    expect(deriveTabFrame(snapshot({ docs: [] }), 'overview').block).toEqual({ kind: 'no_solicitation' });
    expect(deriveTabFrame(snapshot({ docs: [docDto({ kind: 'attachment' })] }), 'compliance').block).toEqual({
      kind: 'no_solicitation',
    });
    expect(deriveTabFrame(snapshot({ docs: [docDto({ liveStatus: 'deleted' })] }), 'schedule').block).toEqual({
      kind: 'no_solicitation',
    });
  });

  it('never blocks Documents or Settings', () => {
    const ctx = snapshot({ docs: [], creditsLeft: 0, bid: bidDto({ creditStatus: null }) });
    expect(deriveTabFrame(ctx, 'documents').block).toBeNull();
    expect(deriveTabFrame(ctx, 'settings').block).toBeNull();
  });

  it('is out of credits when the bid holds no credit, none are left, and a solicitation is present', () => {
    for (const creditStatus of [null, 'released'] as const) {
      const model = deriveTabFrame(snapshot({ creditsLeft: 0, bid: bidDto({ creditStatus }) }), 'overview');
      expect(model.block).toEqual({ kind: 'out_of_credits', creditsLeft: 0, creditsResetOn: '2026-11-01T00:00:00.000Z' });
    }
    // A bid that holds its credit is not blocked; credits left means the upload can still reserve one.
    expect(deriveTabFrame(snapshot({ creditsLeft: 0, bid: bidDto({ creditStatus: 'consumed' }) }), 'overview').block).toBeNull();
    expect(deriveTabFrame(snapshot({ creditsLeft: 1, bid: bidDto({ creditStatus: null }) }), 'overview').block).toBeNull();
    // No solicitation wins over out of credits.
    expect(deriveTabFrame(snapshot({ docs: [], creditsLeft: 0, bid: bidDto({ creditStatus: null }) }), 'overview').block).toEqual({
      kind: 'no_solicitation',
    });
  });

  it('blocks with a plain reason when the solicitation failed to read, and retries that job', () => {
    const failed = jobDto({ id: 'job-f', type: 'file', status: 'failed', error: 'ENOENT /data/x' });
    const model = deriveTabFrame(snapshot({ jobs: [failed] }), 'overview');
    expect(model.block).toEqual({ kind: 'failed', reason: 'We could not read this file.' });
    expect(model.retryJobId).toBe('job-f');
    expect(JSON.stringify(model)).not.toContain('ENOENT');
  });

  it('blocks only the tab an AI stage fills', () => {
    const failed = jobDto({ type: 'classify', stage: 'ai:compliance', status: 'failed' });
    expect(deriveTabFrame(snapshot({ jobs: [failed] }), 'compliance').block?.kind).toBe('failed');
    expect(deriveTabFrame(snapshot({ jobs: [failed] }), 'overview').block).toBeNull();
  });

  it('ignores failures of other files, of deleted files, and failures a later run fixed', () => {
    const attachment = docDto({ id: 'doc-2', kind: 'attachment' });
    const otherFile = jobDto({ documentId: 'doc-2', type: 'file', status: 'failed' });
    expect(deriveTabFrame(snapshot({ docs: [docDto(), attachment], jobs: [otherFile] }), 'overview').block).toBeNull();
    const retried = [
      jobDto({ id: 'a', type: 'file', status: 'failed', createdAt: '2026-10-01T00:00:00.000Z' }),
      jobDto({ id: 'b', type: 'file', status: 'completed', createdAt: '2026-10-02T00:00:00.000Z' }),
    ];
    expect(deriveTabFrame(snapshot({ jobs: retried }), 'overview').block).toBeNull();
  });

  it('puts out of credits ahead of failed', () => {
    const ctx = snapshot({ creditsLeft: 0, bid: bidDto({ creditStatus: 'released' }), jobs: [jobDto({ type: 'scan', status: 'failed' })] });
    expect(deriveTabFrame(ctx, 'overview').block?.kind).toBe('out_of_credits');
  });
});

describe('deriveTabFrame banners', () => {
  it('shows processing above the content, not on Settings', () => {
    const jobs = [jobDto({ status: 'running', type: 'file', progress: 40, queuePosition: 2, etaSeconds: 90 })];
    expect(deriveTabFrame(snapshot({ jobs }), 'overview').processing?.steps).toHaveLength(1);
    expect(deriveTabFrame(snapshot({ jobs }), 'settings').processing).toBeNull();
  });

  it('lists blocked markings everywhere but Settings, and proposals on Compliance and Documents', () => {
    const docs = [docDto({ markingStatus: 'blocked', markingFound: ['CUI'], markingPage: 2 })];
    const links = [linkDto(), linkDto({ id: 'add', action: 'add' }), linkDto({ id: 'done', status: 'confirmed' })];
    const overview = deriveTabFrame(snapshot({ docs, links }), 'overview');
    expect(overview.markings).toEqual([{ documentId: 'doc-1', fileName: 'rfp.pdf', markings: ['CUI'], page: 2 }]);
    expect(overview.proposals).toEqual([]);
    expect(deriveTabFrame(snapshot({ docs, links }), 'compliance').proposals.map((p) => p.id)).toEqual(['link-1']);
    expect(deriveTabFrame(snapshot({ docs, links }), 'documents').proposals).toHaveLength(1);
    expect(deriveTabFrame(snapshot({ docs, links }), 'settings').markings).toEqual([]);
  });

  it('names a marking even when the scan recorded none', () => {
    const docs = [docDto({ markingStatus: 'blocked', markingFound: [] })];
    expect(deriveTabFrame(snapshot({ docs }), 'overview').markings[0].markings).toEqual(['a controlled marking']);
  });

  it('flags over the cap from live files only', () => {
    const docs = [docDto({ sizeBytes: 40 * MB }), docDto({ id: 'd2', kind: 'attachment', sizeBytes: 10 * MB })];
    expect(deriveTabFrame(snapshot({ mbCap: 50, docs }), 'documents').overCap).toEqual({ usedBytes: 50 * MB, capMb: 50 });
    const withDeleted = [docs[0], docDto({ id: 'd3', kind: 'attachment', sizeBytes: 20 * MB, liveStatus: 'deleted' })];
    expect(deriveTabFrame(snapshot({ mbCap: 50, docs: withDeleted }), 'documents').overCap).toBeNull();
  });

  it('shows the draft notice for AI rows once nothing is processing', () => {
    expect(deriveTabFrame(snapshot(), 'compliance', { hasAiRows: true }).draftNotice).toBe(true);
    expect(deriveTabFrame(snapshot(), 'compliance').draftNotice).toBe(false);
    const jobs = [jobDto({ status: 'pending' })];
    expect(deriveTabFrame(snapshot({ jobs }), 'compliance', { hasAiRows: true }).draftNotice).toBe(false);
  });
});

describe('processingState', () => {
  it('builds one step per active job with the lowest queue position and the longest wait', () => {
    const state = processingState(
      [
        jobDto({ id: 'a', type: 'scan', status: 'running', progress: 62.4, queuePosition: null, etaSeconds: 30 }),
        jobDto({ id: 'b', type: 'classify', stage: 'ai:compliance', status: 'pending', progress: 0, queuePosition: 3, etaSeconds: 240 }),
        jobDto({ id: 'c', type: 'file', status: 'pending', documentId: null, queuePosition: 5 }),
        jobDto({ id: 'd', status: 'completed' }),
      ],
      [docDto()],
    );
    expect(state).toEqual({
      steps: [
        { id: 'a', label: 'Virus scan (rfp.pdf)', status: 'running', percent: 62 },
        { id: 'b', label: 'Compliance matrix (rfp.pdf)', status: 'waiting', percent: 0 },
        { id: 'c', label: 'Read the file', status: 'waiting', percent: 100 },
      ],
      queuePosition: 3,
      etaSeconds: 240,
    });
    expect(processingState([jobDto()], [])).toBeNull();
  });
});

describe('failureReason', () => {
  it('chooses a plain reason from the file and the stage', () => {
    const job = jobDto({ type: 'file', status: 'failed' });
    expect(failureReason(job, [docDto({ encryption: 'user_password' })])).toBe('Upload an unlocked copy.');
    expect(failureReason(job, [docDto({ scanStatus: 'infected' })])).toMatch(/virus scan/);
    expect(failureReason(job, [docDto()])).toBe('We could not read this file.');
    expect(failureReason(jobDto({ type: 'x', stage: 'ai:dates' }), [docDto({ extractStatus: 'rejected' })])).toBe(
      'We could not read this file.',
    );
    expect(failureReason(jobDto({ type: 'x', stage: 'ai:dates' }), [docDto()])).toBe('Dates stopped before it finished.');
  });
});

describe('failedJobs', () => {
  it('keeps the latest job per file and type', () => {
    const jobs = [
      jobDto({ id: 'old', type: 'scan', status: 'completed', createdAt: '2026-10-01T00:00:00.000Z' }),
      jobDto({ id: 'new', type: 'scan', status: 'failed', createdAt: '2026-10-03T00:00:00.000Z' }),
      jobDto({ id: 'bid', type: 'dates', documentId: null, status: 'failed' }),
      jobDto({ id: 'gone', type: 'scan', documentId: 'missing', status: 'failed' }),
    ];
    expect(failedJobs(jobs, [docDto()]).map((job) => job.id).sort()).toEqual(['bid', 'new']);
  });
});

describe('toProposals', () => {
  it('maps proposed supersede and withdraw links; never adds', () => {
    const proposals = toProposals([
      linkDto({ confidence: '0.91' }),
      linkDto({ id: 'w', action: 'withdraw', newRow: null, confidence: null, amendmentNo: null }),
      linkDto({ id: 'a', action: 'add' }),
    ]);
    expect(proposals).toEqual([
      expect.objectContaining({ id: 'link-1', action: 'supersede', confidence: 0.91, amendmentNo: 2 }),
      expect.objectContaining({ id: 'w', action: 'withdraw', confidence: null, newRow: null, amendmentNo: 0 }),
    ]);
  });

  it('ignores fact and date links', () => {
    expect(toProposals([linkDto({ rowTable: 'bid_facts' }), linkDto({ id: 'd', rowTable: 'schedule_activities' })])).toEqual([]);
  });

  it('reads confidence strings', () => {
    expect(toConfidence('0.5')).toBe(0.5);
    expect(toConfidence('abc')).toBeNull();
    expect(toConfidence(null)).toBeNull();
  });
});

describe('tabSignals', () => {
  it('is empty when the bid is idle', () => {
    expect(tabSignals([docDto()], [jobDto()], [])).toEqual([]);
  });

  it('puts bid-wide processing on Documents and compliance processing on Compliance', () => {
    expect(tabSignals([docDto()], [jobDto({ status: 'running', type: 'scan' })], [])).toEqual([{ tab: 'documents', signal: 'processing' }]);
    expect(tabSignals([docDto({ scanStatus: 'pending' })], [], [])).toEqual([{ tab: 'documents', signal: 'processing' }]);
    expect(tabSignals([docDto()], [jobDto({ status: 'pending', stage: 'ai:compliance' })], [])).toEqual([
      { tab: 'documents', signal: 'processing' },
      { tab: 'compliance', signal: 'processing' },
    ]);
  });

  it('marks waiting for a blocked marking, a key mismatch, an amendment that needs its number, or proposed changes', () => {
    expect(tabSignals([docDto({ markingStatus: 'blocked' })], [], [])).toEqual([{ tab: 'documents', signal: 'waiting' }]);
    expect(tabSignals([docDto({ kind: 'amendment', keyCheck: 'mismatch' })], [], [])).toEqual([{ tab: 'documents', signal: 'waiting' }]);
    expect(tabSignals([docDto({ kind: 'amendment', amendmentStatus: 'needs_number' })], [], [])).toEqual([{ tab: 'documents', signal: 'waiting' }]);
    expect(tabSignals([docDto({ kind: 'amendment', amendmentStatus: 'applied' })], [], [])).toEqual([]);
    expect(tabSignals([docDto()], [], [linkDto()])).toEqual([{ tab: 'compliance', signal: 'waiting' }]);
    expect(tabSignals([docDto()], [], [linkDto({ action: 'add' })])).toEqual([]);
    expect(tabSignals([docDto()], [], [linkDto({ rowTable: 'bid_facts' })])).toEqual([]);
  });

  it('marks failed until a later run succeeds, and waiting wins over failed over processing', () => {
    const failed = jobDto({ id: 'f', status: 'failed', stage: 'ai:compliance', type: 'classify', createdAt: '2026-10-01T00:00:00.000Z' });
    expect(tabSignals([docDto()], [failed], [])).toEqual([
      { tab: 'documents', signal: 'failed' },
      { tab: 'compliance', signal: 'failed' },
    ]);
    const fixed = jobDto({ id: 'g', status: 'completed', stage: 'ai:compliance', type: 'classify', createdAt: '2026-10-02T00:00:00.000Z' });
    expect(tabSignals([docDto()], [failed, fixed], [])).toEqual([]);
    const running = jobDto({ id: 'r', status: 'running', type: 'scan' });
    expect(tabSignals([docDto({ markingStatus: 'blocked' })], [failed, running], [linkDto()])).toEqual([
      { tab: 'documents', signal: 'waiting' },
      { tab: 'compliance', signal: 'waiting' },
    ]);
  });
});

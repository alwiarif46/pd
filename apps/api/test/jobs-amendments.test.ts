import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { setQueueSource, type StageQueue } from '../src/queue-stats.js';
import { as, createTenant, type Tenant } from './helpers.js';

const unavailable = inject('dbUnavailable');

interface FakeState {
  waiting: Record<string, string[]>;
  active: Record<string, string[]>;
  durations: Record<string, number[]>;
}

function install(state: FakeState): void {
  setQueueSource((stage): StageQueue => ({
    waitingIds: async () => state.waiting[stage] ?? [],
    jobState: async (id) => {
      if (state.waiting[stage]?.includes(id)) {
        return 'waiting';
      }
      return state.active[stage]?.includes(id) ? 'active' : null;
    },
    completedDurations: async () => state.durations[stage] ?? [],
  }));
}

describe.skipIf(Boolean(unavailable))('GET jobs and amendment links', () => {
  let app: FastifyInstance;
  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    delete process.env.PD_ALLOW_BYPASS_RLS;
    getPool({ connectionString: inject('appUrl'), max: 4 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    a = await createTenant(app, 'ja');
    b = await createTenant(app, 'jb');
  });

  afterAll(async () => {
    setQueueSource(null);
    await app?.close();
    await closeDb();
  });

  beforeEach(() => setQueueSource(null));

  async function pendingJob(tenant: Tenant, type = 'scan'): Promise<string> {
    return withOrg(tenant.orgId, async (db) => {
      const [job] = await db.insert(schema.jobs).values({
        orgId: tenant.orgId,
        bidId: tenant.bidId,
        documentId: tenant.documentId,
        type,
        status: 'pending',
      }).returning();
      return job.id;
    });
  }

  type JobRow = { id: string; status: string; stage: string | null; queuePosition: number | null; queueDepth: number; etaSeconds: number | null };
  async function listJobs(tenant: Tenant): Promise<JobRow[]> {
    const response = await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/jobs`);
    expect(response.statusCode).toBe(200);
    return response.json<JobRow[]>();
  }

  it('reports stage, position and depth from the stage queue, across organizations', async () => {
    const mine = await pendingJob(a);
    const other = await pendingJob(b);
    install({
      waiting: { scan: [`scan:${other}`, `scan:${mine}`, 'scan:someone-else'] },
      active: {},
      durations: {},
    });
    const row = (await listJobs(a)).find((job) => job.id === mine)!;
    expect(row.stage).toBe('scan');
    expect(row.queuePosition).toBe(2);
    expect(row.queueDepth).toBe(3);
    expect(row.etaSeconds).toBeNull();
  });

  it('gives a null ETA with fewer than five samples and a number with enough', async () => {
    const id = await pendingJob(a);
    const stages = ['scan', 'file', 'marking', 'classify', 'ai:overview', 'ai:dates', 'ai:compliance'];
    const few = Object.fromEntries(stages.map((stage) => [stage, [1000, 1000, 1000, 1000]]));
    install({ waiting: { scan: [`scan:${id}`] }, active: {}, durations: few });
    expect((await listJobs(a)).find((job) => job.id === id)!.etaSeconds).toBeNull();

    const enough = Object.fromEntries(stages.map((stage) => [stage, [1000, 2000, 3000, 4000, 5000]]));
    install({ waiting: { scan: [`scan:${id}`] }, active: {}, durations: enough });
    // The document is a solicitation: scan, file, marking, classify and three ai stages, each 3 s;
    // position 1, concurrency 1 (no provider_settings rows or the minimum of them).
    const row = (await listJobs(a)).find((job) => job.id === id)!;
    expect(row.etaSeconds).toBeGreaterThanOrEqual(3 * 7);
  });

  it('leaves a running job without position and leaves finished jobs unchanged', async () => {
    const id = await pendingJob(a);
    install({ waiting: {}, active: { file: [`file:${id}`] }, durations: {} });
    const rows = await listJobs(a);
    const running = rows.find((job) => job.id === id)!;
    expect(running.stage).toBe('file');
    expect(running.queuePosition).toBeNull();
    expect(running.etaSeconds).toBeNull();
    const failed = rows.find((job) => job.id === a.jobId)!;
    expect(failed.status).toBe('failed');
    expect(failed.stage).toBeNull();
    expect(failed.queueDepth).toBe(0);
  });

  it('still lists jobs when the queue cannot be read', async () => {
    const id = await pendingJob(a);
    setQueueSource(() => ({
      waitingIds: () => Promise.reject(new Error('down')),
      jobState: () => Promise.reject(new Error('down')),
      completedDurations: () => Promise.reject(new Error('down')),
    }));
    const row = (await listJobs(a)).find((job) => job.id === id)!;
    expect(row.stage).toBeNull();
    expect(row.queuePosition).toBeNull();
  });

  it('does not list another organization\'s jobs', async () => {
    const theirs = await pendingJob(b);
    install({ waiting: {}, active: {}, durations: {} });
    expect((await listJobs(a)).some((job) => job.id === theirs)).toBe(false);
    const response = await as(app, a.token)('GET', `/api/bids/${b.bidId}/jobs`);
    expect(response.statusCode).toBe(404);
  });

  type LinkRow = {
    id: string;
    amendmentNo: number | null;
    oldRow: { rowId: string; label: string; text: string; sourcePage: number | null } | null;
    newRow: { rowId: string; label: string; text: string; sourcePage: number | null } | null;
  };

  it('joins the amendment number and the compliance rows, with a null old row on add', async () => {
    const addId = await withOrg(a.orgId, async (db) => {
      const [added] = await db.insert(schema.complianceRows).values({
        orgId: a.orgId, bidId: a.bidId, reqId: 'L.9', requirementText: 'New requirement.', sourcePage: 7,
      }).returning();
      const [link] = await db.insert(schema.amendmentLinks).values({
        orgId: a.orgId, amendmentId: a.amendmentId, rowTable: 'compliance_rows', newRowId: added.id, action: 'add', status: 'proposed',
      }).returning();
      return link.id;
    });
    const response = await as(app, a.token)('GET', `/api/bids/${a.bidId}/amendment-links`);
    expect(response.statusCode).toBe(200);
    const links = response.json<LinkRow[]>();
    const withdraw = links.find((link) => link.id === a.amendmentLinkId)!;
    expect(withdraw.amendmentNo).toBe(1);
    expect(withdraw.oldRow).toMatchObject({ rowId: a.rows.compliance_rows, label: 'L.1' });
    expect(withdraw.oldRow!.text).toContain('shall');
    expect(withdraw.newRow).toBeNull();
    const added = links.find((link) => link.id === addId)!;
    expect(added.oldRow).toBeNull();
    expect(added.newRow).toMatchObject({ label: 'L.9', text: 'New requirement.', sourcePage: 7 });
  });

  it('never returns another organization\'s row, even if a link names its id', async () => {
    const foreignId = b.rows.compliance_rows;
    const linkId = await withOrg(a.orgId, async (db) => {
      const [link] = await db.insert(schema.amendmentLinks).values({
        orgId: a.orgId, amendmentId: a.amendmentId, rowTable: 'compliance_rows', oldRowId: foreignId, newRowId: b.compliance2, action: 'supersede', status: 'proposed',
      }).returning();
      return link.id;
    });
    const response = await as(app, a.token)('GET', `/api/bids/${a.bidId}/amendment-links`);
    const link = response.json<LinkRow[]>().find((row) => row.id === linkId)!;
    expect(link.oldRow).toBeNull();
    expect(link.newRow).toBeNull();
    // The raw id fields are the link's own columns; no text of the other organization's rows leaks.
    expect(response.body).not.toContain('shall jb');
    expect(response.body).not.toContain('also jb');
    const cross = await as(app, a.token)('GET', `/api/bids/${b.bidId}/amendment-links`);
    expect(cross.statusCode).toBe(404);
  });
});

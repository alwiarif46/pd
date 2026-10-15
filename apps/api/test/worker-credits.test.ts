/**
 * Credit settlement across the api and the worker, against the real database: the worker's
 * classify and compliance steps are imported from apps/worker with the AI provider mocked.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { as, createTenant, type Tenant } from './helpers.js';
import { fulfilled, raceInOrder } from './races.js';
import { enqueueClassify, enqueueScan } from '../src/queue.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const enqueued = vi.hoisted(() => [] as string[]);
/** Worker queues whose enqueue call fails (Redis down) while listed. */
const queueDown = vi.hoisted(() => new Set<string>());
vi.mock('../../worker/src/enqueue.js', () => ({
  enqueue: vi.fn(async (name: string) => {
    if (queueDown.has(name)) {
      throw new Error('redis down');
    }
    enqueued.push(name);
  }),
}));

const extract = vi.hoisted(() => ({ impl: null as null | (() => Promise<unknown>), calls: 0 }));
/** The facts the mocked model returns to the overview step. */
const overviewFacts = vi.hoisted(() => ({ facts: [] as unknown[] }));
vi.mock('@pd/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pd/ai')>();
  return {
    ...original,
    loadSkill: () => ({ name: 'bid-summary', version: '1' }),
    buildSystemPrompt: () => 'Extract bid facts.',
    getProvider: () => ({
      complete: async () => ({ json: { facts: overviewFacts.facts }, usage: { totalTokens: 5 } }),
    }),
    extractComplianceMatrix: vi.fn(async () => {
      extract.calls += 1;
      return extract.impl!();
    }),
  };
});

const unavailable = inject('dbUnavailable');

function matrix(label: string) {
  return {
    requirements: [{
      id: `L.${label}`,
      sectionRef: 'L',
      requirementText: `The offeror shall ${label}.`,
      sourcePage: 1,
      sourceQuote: `shall ${label}`,
      amendmentNo: 0,
      origin: 'ai',
      confidence: 0.9,
      flags: [],
      reqType: 'shall',
      supersedeStatus: 'active',
    }],
    metadata: { skillName: 'compliance', skillVersion: '1', tokensUsed: 10, costUsd: 0.01 },
  };
}

describe.skipIf(Boolean(unavailable))('credits across api and worker', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let worker: typeof import('../../worker/src/ai-jobs.js');
  let classify: typeof import('../../worker/src/classify-job.js');
  let steps: typeof import('../../worker/src/steps.js');
  let scan: typeof import('../../worker/src/scan.js');
  let marking: typeof import('../../worker/src/marking-job.js');
  let rows: typeof import('../../worker/src/rows.js');

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pd-api-worker-'));
    process.env.DATA_DIR = dataDir;
    getPool({ connectionString: inject('appUrl'), max: 8 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    worker = await import('../../worker/src/ai-jobs.js');
    classify = await import('../../worker/src/classify-job.js');
    steps = await import('../../worker/src/steps.js');
    scan = await import('../../worker/src/scan.js');
    marking = await import('../../worker/src/marking-job.js');
    rows = await import('../../worker/src/rows.js');
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  beforeEach(() => {
    enqueued.length = 0;
    queueDown.clear();
    extract.impl = async () => matrix('x');
    extract.calls = 0;
  });

  /** How many times the matrix AI ran since the test started. */
  const extractCalls = () => extract.calls;

  async function setup(label: string, creditStatus: 'reserved' | 'consumed' | 'released' | null, allowed = 5) {
    const tenant = await createTenant(app, label);
    return withOrg(tenant.orgId, async (db) => {
      await db.update(schema.organizations).set({ plan: 'starter' }).where(eq(schema.organizations.id, tenant.orgId));
      const [credit] = await db.insert(schema.rfpCredits).values({
        orgId: tenant.orgId,
        periodStart: new Date(Date.now() - 60_000),
        periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        allowed,
        reserved: creditStatus === 'reserved' ? 1 : 0,
      }).returning();
      await db.update(schema.bids).set({ creditId: creditStatus ? credit.id : null, creditStatus }).where(eq(schema.bids.id, tenant.bidId));
      const doc = async (kind: 'solicitation' | 'attachment' | 'resume' | 'draft') => {
        const [row] = await db.insert(schema.documents).values({
          orgId: tenant.orgId, bidId: tenant.bidId, fileName: `${kind}.pdf`, mime: 'application/pdf', sizeBytes: 5,
          sha256: randomUUID(), kind, storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
        }).returning();
        await db.insert(schema.pages).values({ orgId: tenant.orgId, documentId: row.id, pageNo: 1, text: 'shall' });
        return row.id;
      };
      return { tenant, creditId: credit.id, solicitationId: await doc('solicitation'), attachmentId: await doc('attachment') };
    });
  }

  const payload = (tenant: Tenant, documentId: string, kind: 'solicitation' | 'attachment' | 'amendment' | 'resume' | 'draft') => ({
    orgId: tenant.orgId, bidId: tenant.bidId, documentId, jobId: randomUUID() as string, storagePath: 'docs/x.pdf', kind,
  });
  const state = (tenant: Tenant, creditId: string) => withOrg(tenant.orgId, async (db) => {
    const [credit] = await db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.id, creditId));
    const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, tenant.bidId));
    return { reserved: credit.reserved, used: credit.used, status: bid.creditStatus };
  });
  /** The document's job rows, oldest first. */
  const jobsOf = (tenant: Tenant, documentId: string) => withOrg(tenant.orgId, async (db) => (await db.select({
    type: schema.jobs.type, status: schema.jobs.status, error: schema.jobs.error,
  }).from(schema.jobs).where(eq(schema.jobs.documentId, documentId)).orderBy(asc(schema.jobs.createdAt), asc(schema.jobs.id))));

  it('an attachment matrix run neither consumes nor releases the solicitation credit', async () => {
    const { tenant, creditId, attachmentId } = await setup('attach-run', 'reserved');
    await worker.processCompliance(payload(tenant, attachmentId, 'attachment'));
    expect(await state(tenant, creditId)).toEqual({ reserved: 1, used: 0, status: 'reserved' });
    extract.impl = async () => {
      throw new Error('model down');
    };
    await expect(worker.processCompliance(payload(tenant, attachmentId, 'attachment'))).rejects.toThrow('model down');
    expect(await state(tenant, creditId)).toEqual({ reserved: 1, used: 0, status: 'reserved' });
  });

  it('the solicitation run consumes in the same transaction as its rows and run record', async () => {
    const { tenant, creditId, solicitationId } = await setup('sol-run', 'reserved');
    await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 1, status: 'consumed' });
    const rows = await withOrg(tenant.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.documentId, solicitationId)));
    expect(rows).toHaveLength(1);
    const runs = await withOrg(tenant.orgId, (db) => db.select().from(schema.aiRuns).where(eq(schema.aiRuns.bidId, tenant.bidId)));
    expect(runs).toHaveLength(1);
  });

  it('a delete that lands while the matrix is being built wins: no rows, credit released', async () => {
    const { tenant, creditId, solicitationId } = await setup('sol-race', 'reserved');
    // createTenant's own solicitation would keep the bid's credit; soft-delete it first.
    await withOrg(tenant.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' }).where(eq(schema.documents.id, tenant.documentId)));
    extract.impl = async () => {
      const response = await as(app, tenant.token)('DELETE', `/api/documents/${solicitationId}`);
      expect(response.json<{ creditReleased: boolean }>().creditReleased).toBe(true);
      return matrix('late');
    };
    await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 0, status: 'released' });
    const rows = await withOrg(tenant.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.documentId, solicitationId)));
    expect(rows).toHaveLength(0);
  });

  /**
   * Holds `sql` (FOR UPDATE) from a separate connection, starts `contenders`, waits until
   * `waiters` backends are blocked on a lock, then lets go. Returns how many waited, and the
   * contenders' settled results.
   */
  async function race<T extends readonly unknown[]>(orgId: string, sql: string, params: unknown[], waiters: number, contenders: () => readonly [...T]) {
    const holder = new pg.Client({ connectionString: inject('appUrl') });
    await holder.connect();
    await holder.query('begin');
    await holder.query("select set_config('app.org_id', $1, true)", [orgId]);
    await holder.query(sql, params);
    const pending = Promise.allSettled(contenders());
    const deadline = Date.now() + 10_000;
    let waiting = 0;
    while (waiting < waiters && Date.now() < deadline) {
      await holder.query('select pg_stat_clear_snapshot()');
      const result = await holder.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'",
      );
      waiting = result.rows[0].n;
    }
    await holder.query('commit');
    await holder.end();
    return { waiting, results: await pending };
  }

  it('a document delete and a matrix run that collide settle the credit exactly once, without deadlock', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { tenant, creditId, solicitationId } = await setup(`sol-conc-${round}`, 'reserved');
      await withOrg(tenant.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' }).where(eq(schema.documents.id, tenant.documentId)));
      const { waiting, results } = await race(tenant.orgId, 'select id from documents where id = $1 for update', [solicitationId], 2, () => [
        as(app, tenant.token)('DELETE', `/api/documents/${solicitationId}`),
        worker.processCompliance(payload(tenant, solicitationId, 'solicitation')),
      ]);
      expect(waiting).toBe(2);
      const [deleted, ran] = results;
      expect(deleted.status).toBe('fulfilled');
      expect((deleted as PromiseFulfilledResult<{ statusCode: number }>).value.statusCode).toBe(200);
      expect(ran.status).toBe('fulfilled');
      const after = await state(tenant, creditId);
      expect(after.reserved).toBe(0);
      // Either the run committed first (consumed) or the delete did (released, no rows).
      if (after.status === 'consumed') {
        expect(after.used).toBe(1);
      } else {
        expect(after).toEqual({ reserved: 0, used: 0, status: 'released' });
      }
    }
  });

  async function solicitationSession(tenant: Tenant) {
    const call = as(app, tenant.token);
    const bidId = (await call('POST', '/api/bids', { name: `B ${randomUUID()}`, bidType: 'sled' })).json<{ id: string }>().id;
    const bytes = randomBytes(20);
    const started = await call('POST', `/api/bids/${bidId}/uploads`, {
      fileName: 's.pdf', kind: 'solicitation', declaredSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), chunkCount: 1,
    });
    expect(started.statusCode).toBe(201);
    const sessionId = started.json<{ id: string }>().id;
    const chunk = await app.inject({
      method: 'PUT',
      url: `/api/uploads/${sessionId}/chunks/0`,
      headers: { authorization: `Bearer ${tenant.token}`, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(chunk.statusCode).toBe(200);
    return { bidId, sessionId };
  }

  it('a bid delete and an upload complete that collide do not deadlock', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tenant = await createTenant(app, `bid-vs-complete-${round}`);
      const { bidId, sessionId } = await solicitationSession(tenant);
      const call = as(app, tenant.token);
      const { waiting, results } = await race(tenant.orgId, 'select id from upload_sessions where id = $1 for update', [sessionId], 2, () => [
        call('POST', `/api/uploads/${sessionId}/complete`),
        call('DELETE', `/api/bids/${bidId}`),
      ]);
      expect(waiting).toBe(2);
      const [completed, deleted] = results.map((result) => (result as PromiseFulfilledResult<{ statusCode: number; body: string }>).value);
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect([201, 404], completed.body).toContain(completed.statusCode);
      const credits = await withOrg(tenant.orgId, (db) => db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.orgId, tenant.orgId)));
      expect(credits.reduce((sum, row) => sum + row.reserved, 0)).toBe(0);
    }
  });

  it('a key override and a bid delete that collide do not deadlock', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { tenant } = await setup(`override-vs-delete-${round}`, 'reserved');
      const documentId = await withOrg(tenant.orgId, async (db) => {
        const [document] = await db.insert(schema.documents).values({
          orgId: tenant.orgId, bidId: tenant.bidId, fileName: 'a.pdf', mime: 'application/pdf', sizeBytes: 5,
          sha256: randomUUID(), kind: 'amendment', liveStatus: 'live', keyStatus: 'not_found',
        }).returning();
        await db.insert(schema.amendments).values({ orgId: tenant.orgId, bidId: tenant.bidId, documentId: document.id, amendmentNo: 4, solicitationKeyFound: false, status: 'held' });
        return document.id;
      });
      const call = as(app, tenant.token);
      // Both lock the amendment's document first (lock order documents -> bids -> amendments).
      const { waiting, results } = await race(tenant.orgId, 'select id from documents where id = $1 for update', [documentId], 2, () => [
        call('POST', `/api/documents/${documentId}/key-override`, { reason: 'race' }),
        call('DELETE', `/api/bids/${tenant.bidId}`),
      ]);
      expect(waiting).toBe(2);
      const [override, deleted] = results.map((result) => (result as PromiseFulfilledResult<{ statusCode: number; body: string }>).value);
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect([200, 404], override.body).toContain(override.statusCode);
    }
  });

  it('attachments and amendments wait for the solicitation: refused at upload, skipped by the worker', async () => {
    const tenant = await createTenant(app, 'attach-first');
    const call = as(app, tenant.token);
    const bidId = (await call('POST', '/api/bids', { name: 'Empty', bidType: 'sled' })).json<{ id: string }>().id;
    for (const kind of ['attachment', 'amendment']) {
      const response = await call('POST', `/api/bids/${bidId}/uploads`, {
        fileName: 'rfp.pdf', kind, declaredSize: 10, sha256: randomBytes(32).toString('hex'), chunkCount: 1,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('solicitation_first');
    }
    expect((await call('POST', `/api/bids/${bidId}/uploads`, {
      fileName: 'cv.pdf', kind: 'resume', declaredSize: 10, sha256: randomBytes(32).toString('hex'), chunkCount: 1,
    })).statusCode).toBe(201);

    // An attachment already on a bid whose credit was released: no AI steps, no rows, and a
    // failed classify row saying it waits for the solicitation (not a silent drop).
    const { tenant: other, attachmentId } = await setup('attach-released', 'released');
    await classify.processClassify(payload(other, attachmentId, 'attachment'));
    expect(enqueued).toEqual([]);
    expect(await jobsOf(other, attachmentId)).toEqual([{ type: 'classify', status: 'failed', error: rows.HELD_FOR_CREDIT }]);
    await worker.processCompliance(payload(other, attachmentId, 'attachment'));
    const matrix = await withOrg(other.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.documentId, attachmentId)));
    expect(matrix).toHaveLength(0);
    expect(extractCalls()).toBe(0);
  });

  it('a later numberless solicitation is refused on a bid whose key is still PENDING', async () => {
    const tenant = await createTenant(app, 'pending-key');
    const call = as(app, tenant.token);
    const bidId = (await call('POST', '/api/bids', { name: 'Pending', bidType: 'sled' })).json<{ id: string }>().id;
    const start = () => call('POST', `/api/bids/${bidId}/uploads`, {
      fileName: 's.pdf', kind: 'solicitation', declaredSize: 10, sha256: randomBytes(32).toString('hex'), chunkCount: 1,
    });
    expect((await start()).statusCode).toBe(201);
    const second = await start();
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('key_required');
  });

  it('a complete whose transaction fails removes the assembled file', async () => {
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await admin.query(`create or replace function pd_test_boom() returns trigger language plpgsql as $$
      begin if new.file_name = 'boom.pdf' then raise exception 'boom'; end if; return new; end $$`);
    await admin.query('create trigger pd_test_boom before insert on documents for each row execute function pd_test_boom()');
    try {
      const { tenant } = await setup('boom', 'reserved');
      const bytes = randomBytes(16);
      const call = as(app, tenant.token);
      const sessionId = (await call('POST', `/api/bids/${tenant.bidId}/uploads`, {
        fileName: 'boom.pdf', kind: 'attachment', declaredSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), chunkCount: 1,
      })).json<{ id: string }>().id;
      await app.inject({
        method: 'PUT',
        url: `/api/uploads/${sessionId}/chunks/0`,
        headers: { authorization: `Bearer ${tenant.token}`, 'content-type': 'application/octet-stream' },
        payload: bytes,
      });
      expect((await call('POST', `/api/uploads/${sessionId}/complete`)).statusCode).toBe(500);
      expect(await readdir(join(dataDir, tenant.orgId, 'docs')).catch(() => [])).not.toContain(`${sessionId}.pdf`);
    } finally {
      await admin.query('drop trigger if exists pd_test_boom on documents');
      await admin.query('drop function if exists pd_test_boom()');
      await admin.end();
    }
  });

  it('classify sends only the solicitation set to the free-tab AI steps', async () => {
    const { tenant, attachmentId, solicitationId } = await setup('classify', 'reserved');
    for (const kind of ['resume', 'draft'] as const) {
      await classify.processClassify(payload(tenant, attachmentId, kind));
    }
    expect(enqueued).toEqual([]);
    await classify.processClassify(payload(tenant, solicitationId, 'solicitation'));
    await classify.processClassify(payload(tenant, attachmentId, 'attachment'));
    expect(enqueued.filter((name) => name === 'ai:compliance')).toHaveLength(2);
  });

  it('retrying a failed solicitation step reserves a credit again, or answers 402', async () => {
    const { tenant, creditId, solicitationId } = await setup('retry', 'released', 1);
    const failedJob = async () => withOrg(tenant.orgId, async (db) => {
      const [job] = await db.insert(schema.jobs).values({ orgId: tenant.orgId, bidId: tenant.bidId, documentId: solicitationId, type: 'classify', status: 'failed' }).returning();
      return job.id;
    });
    const call = as(app, tenant.token);
    expect((await call('POST', `/api/jobs/${await failedJob()}/retry`)).statusCode).toBe(200);
    expect(await state(tenant, creditId)).toEqual({ reserved: 1, used: 0, status: 'reserved' });
    // The retry fails too and releases; the period's only credit then goes to another bid.
    await withOrg(tenant.orgId, async (db) => {
      await db.update(schema.bids).set({ creditStatus: 'released' }).where(eq(schema.bids.id, tenant.bidId));
      await db.update(schema.rfpCredits).set({ reserved: 0, used: 1 }).where(eq(schema.rfpCredits.id, creditId));
    });
    const refused = await call('POST', `/api/jobs/${await failedJob()}/retry`);
    expect(refused.statusCode).toBe(402);
    expect(refused.json<{ code: string }>().code).toBe('out_of_credits');
  });

  it('after a failure release, the key stays locked while the solicitation is on the bid', async () => {
    const { tenant } = await setup('released-key', 'released');
    const call = as(app, tenant.token);
    const response = await call('PATCH', `/api/bids/${tenant.bidId}`, { solicitationNumber: 'ANOTHER-RFP' });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('key_locked');
  });

  it('a later solicitation without a number is refused; with the matching number it is taken', async () => {
    const { tenant } = await setup('key-required', 'reserved');
    const call = as(app, tenant.token);
    const start = (extra: Record<string, unknown>) => call('POST', `/api/bids/${tenant.bidId}/uploads`, {
      fileName: 's2.pdf', kind: 'solicitation', declaredSize: 10, sha256: randomBytes(32).toString('hex'), chunkCount: 1, ...extra,
    });
    const bare = await start({});
    expect(bare.statusCode).toBe(409);
    expect(bare.json<{ code: string }>().code).toBe('key_required');
    expect((await start({ kind: 'attachment' })).statusCode).toBe(201);
    expect((await start({ solicitationNumber: 'SOL-key-required' })).statusCode).toBe(201);
  });

  it('deleting a document expires its archive copies', async () => {
    const { tenant, attachmentId } = await setup('archive-expire', null);
    await withOrg(tenant.orgId, (db) => db.insert(schema.archiveObjects).values({
      orgId: tenant.orgId, documentId: attachmentId, objectType: 'original', archiveKey: 'arch-1', archivedAt: new Date(),
    }));
    expect((await as(app, tenant.token)('DELETE', `/api/documents/${attachmentId}`)).statusCode).toBe(200);
    const [row] = await withOrg(tenant.orgId, (db) => db.select().from(schema.archiveObjects).where(and(
      eq(schema.archiveObjects.orgId, tenant.orgId),
      eq(schema.archiveObjects.archiveKey, 'arch-1'),
    )));
    expect(row.expiresAt).not.toBeNull();
  });

  it('key override refuses a deleted amendment', async () => {
    const { tenant } = await setup('override-deleted', null);
    const documentId = await withOrg(tenant.orgId, async (db) => {
      const [document] = await db.insert(schema.documents).values({
        orgId: tenant.orgId, bidId: tenant.bidId, fileName: 'a.pdf', mime: 'application/pdf', sizeBytes: 5,
        sha256: randomUUID(), kind: 'amendment', liveStatus: 'deleted',
      }).returning();
      await db.insert(schema.amendments).values({ orgId: tenant.orgId, bidId: tenant.bidId, documentId: document.id, amendmentNo: 1, solicitationKeyFound: false, status: 'processing' });
      return document.id;
    });
    const response = await as(app, tenant.token)('POST', `/api/documents/${documentId}/key-override`, { reason: 'x' });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('document_deleted');
  });

  it('a failed complete removes the assembled file; a good one removes the chunks', async () => {
    const { tenant } = await setup('files', null);
    const bytes = randomBytes(24);
    const call = as(app, tenant.token);
    const started = await call('POST', `/api/bids/${tenant.bidId}/uploads`, {
      fileName: 'a.pdf', kind: 'attachment', declaredSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), chunkCount: 1,
    });
    const sessionId = started.json<{ id: string }>().id;
    const put = (body: Buffer) => app.inject({
      method: 'PUT',
      url: `/api/uploads/${sessionId}/chunks/0`,
      headers: { authorization: `Bearer ${tenant.token}`, 'content-type': 'application/octet-stream' },
      payload: body,
    });
    const docsDir = join(dataDir, tenant.orgId, 'docs');
    const chunkDir = join(dataDir, tenant.orgId, 'chunks', sessionId);
    await put(randomBytes(24));
    expect((await call('POST', `/api/uploads/${sessionId}/complete`)).statusCode).toBe(400);
    expect(await readdir(docsDir).catch(() => [])).not.toContain(`${sessionId}.pdf`);
    await put(bytes);
    expect((await call('POST', `/api/uploads/${sessionId}/complete`)).statusCode).toBe(201);
    expect(await readdir(docsDir)).toContain(`${sessionId}.pdf`);
    await expect(stat(chunkDir)).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------------------------
  // Credit gaps: failures release and leave a retry, held files rerun, a released credit never
  // builds a matrix.

  /** Inserts a job row for the document and returns its id. */
  const jobRow = (tenant: Tenant, documentId: string, type: 'scan' | 'classify', status: string) => withOrg(tenant.orgId, async (db) => {
    const [job] = await db.insert(schema.jobs).values({ orgId: tenant.orgId, bidId: tenant.bidId, documentId, type, status }).returning();
    return job.id;
  });

  /** A live document of the bid with one page of `text`. */
  const addDocument = (tenant: Tenant, kind: 'solicitation' | 'attachment' | 'amendment', text = 'shall') => withOrg(tenant.orgId, async (db) => {
    const [row] = await db.insert(schema.documents).values({
      orgId: tenant.orgId, bidId: tenant.bidId, fileName: `${kind}.pdf`, mime: 'application/pdf', sizeBytes: 5,
      sha256: randomUUID(), kind, storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
    }).returning();
    await db.insert(schema.pages).values({ orgId: tenant.orgId, documentId: row.id, pageNo: 1, text });
    return row.id;
  });

  /** createTenant's own (archived) solicitation would count as live; delete it. */
  const dropTenantSolicitation = (tenant: Tenant) => withOrg(tenant.orgId, (db) => db.update(schema.documents)
    .set({ liveStatus: 'deleted' }).where(eq(schema.documents.id, tenant.documentId)));

  const latestJob = (tenant: Tenant, documentId: string) => withOrg(tenant.orgId, async (db) => {
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.documentId, documentId))
      .orderBy(desc(schema.jobs.createdAt), desc(schema.jobs.id)).limit(1);
    return job;
  });

  const matrixRows = (tenant: Tenant, documentId: string) => withOrg(tenant.orgId, (db) => db.select().from(schema.complianceRows)
    .where(eq(schema.complianceRows.documentId, documentId)));

  type Payload = ReturnType<typeof payload>;

  it('a scan, file, marking or classify failure on a solicitation releases its credit and leaves a retryable failed job', async () => {
    const boom = async () => {
      throw new Error('internal detail');
    };
    const cases: {
      label: string;
      queue: 'scan' | 'file' | 'marking' | 'classify' | 'ai:compliance';
      handler: (p: Payload) => Promise<unknown>;
      scanPending?: boolean;
      type: string;
      error: string;
      text?: string;
      modelDown?: boolean;
    }[] = [
      { label: 'scan', queue: 'scan', handler: (p) => scan.processScan({ ...p, storagePath: '../../escape.pdf' }), scanPending: true, type: 'scan', error: 'The stored file path is not valid' },
      { label: 'file', queue: 'file', handler: boom, type: 'scan', error: 'The text could not be read from this file. Retry it.' },
      { label: 'reject', queue: 'marking', handler: (p) => marking.processMarking(p), type: 'scan', error: marking.MARKING_REJECTED, text: 'SECRET\nHandle accordingly.' },
      { label: 'classify', queue: 'classify', handler: boom, type: 'classify', error: 'Processing failed. Retry it.' },
      { label: 'matrix', queue: 'ai:compliance', handler: (p) => worker.processCompliance(p), type: 'classify', error: 'The compliance matrix could not be built. Retry it.', modelDown: true },
    ];
    for (const step of cases) {
      const { tenant, creditId, solicitationId } = await setup(`fail-${step.label}`, 'reserved');
      if (step.text) {
        await withOrg(tenant.orgId, (db) => db.update(schema.pages).set({ text: step.text }).where(eq(schema.pages.documentId, solicitationId)));
      }
      if (step.modelDown) {
        extract.impl = boom;
      }
      // The upload's scan row: pending while the scan runs, completed after it.
      const scanJob = await jobRow(tenant, solicitationId, 'scan', step.scanPending ? 'pending' : 'completed');
      const run = steps.guardStep(step.queue, step.handler);
      await expect(run({ ...payload(tenant, solicitationId, 'solicitation'), jobId: scanJob }), step.label).rejects.toThrow();
      expect(await state(tenant, creditId), step.label).toEqual({ reserved: 0, used: 0, status: 'released' });
      const failed = await latestJob(tenant, solicitationId);
      expect({ type: failed.type, status: failed.status, error: failed.error }, step.label).toEqual({ type: step.type, status: 'failed', error: step.error });
      expect((await jobsOf(tenant, solicitationId)).filter((job) => job.status === 'failed'), step.label).toHaveLength(1);
      expect(await matrixRows(tenant, solicitationId), step.label).toHaveLength(0);
      // The user can retry it, and the retry reserves the credit again.
      const retried = await as(app, tenant.token)('POST', `/api/jobs/${failed.id}/retry`);
      expect(retried.statusCode, step.label).toBe(200);
      expect(await state(tenant, creditId), step.label).toEqual({ reserved: 1, used: 0, status: 'reserved' });
      extract.impl = async () => matrix('x');
    }
  });

  it('a failure of an attachment never touches the solicitation credit', async () => {
    const { tenant, creditId, attachmentId } = await setup('fail-attachment', 'reserved');
    const run = steps.guardStep('classify', async () => {
      throw new Error('boom');
    });
    await expect(run(payload(tenant, attachmentId, 'attachment'))).rejects.toThrow('boom');
    expect(await state(tenant, creditId)).toEqual({ reserved: 1, used: 0, status: 'reserved' });
    expect((await latestJob(tenant, attachmentId)).status).toBe('failed');
  });

  it('a file paused at the marking check keeps its credit until the user confirms or deletes it', async () => {
    const { tenant, creditId, solicitationId } = await setup('marking-block', 'reserved');
    await dropTenantSolicitation(tenant);
    await withOrg(tenant.orgId, (db) => db.update(schema.pages).set({ text: 'CUI\nThe offeror shall submit a plan.' }).where(eq(schema.pages.documentId, solicitationId)));
    const run = steps.guardStep('marking', (p) => marking.processMarking(p));
    await run(payload(tenant, solicitationId, 'solicitation'));
    expect(enqueued).toEqual([]);
    expect(await state(tenant, creditId)).toEqual({ reserved: 1, used: 0, status: 'reserved' });
    expect(await jobsOf(tenant, solicitationId)).toEqual([]);
    // Removing the paused file releases the reservation it held.
    const deleted = await as(app, tenant.token)('DELETE', `/api/documents/${solicitationId}`);
    expect(deleted.json<{ creditReleased: boolean }>().creditReleased).toBe(true);
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 0, status: 'released' });
  });

  it('a confirmed marking keeps the same reservation through to the matrix', async () => {
    const { tenant, creditId, solicitationId } = await setup('marking-confirm', 'reserved');
    await withOrg(tenant.orgId, (db) => db.update(schema.pages).set({ text: 'CUI\nThe offeror shall submit a plan.' }).where(eq(schema.pages.documentId, solicitationId)));
    await steps.guardStep('marking', (p) => marking.processMarking(p))(payload(tenant, solicitationId, 'solicitation'));
    const confirmed = await as(app, tenant.token)('POST', `/api/documents/${solicitationId}/confirm-marking`);
    expect(confirmed.statusCode).toBe(200);
    const job = await latestJob(tenant, solicitationId);
    await classify.processClassify({ ...payload(tenant, solicitationId, 'solicitation'), jobId: job.id });
    expect((await latestJob(tenant, solicitationId)).status).toBe('completed');
    await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 1, status: 'consumed' });
  });

  it('a failed retry releases the credit it reserved', async () => {
    const { tenant, creditId, solicitationId } = await setup('retry-fails', 'released');
    const call = as(app, tenant.token);
    const first = await jobRow(tenant, solicitationId, 'classify', 'failed');
    const retryId = (await call('POST', `/api/jobs/${first}/retry`)).json<{ id: string }>().id;
    expect(await state(tenant, creditId)).toEqual({ reserved: 1, used: 0, status: 'reserved' });
    // The retry's classify throws before the matrix step.
    const run = steps.guardStep('classify', async () => {
      throw new Error('boom');
    });
    await expect(run({ ...payload(tenant, solicitationId, 'solicitation'), jobId: retryId })).rejects.toThrow('boom');
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 0, status: 'released' });
    const [retryRow] = await withOrg(tenant.orgId, (db) => db.select().from(schema.jobs).where(eq(schema.jobs.id, retryId)));
    expect(retryRow.status).toBe('failed');
    expect((await call('POST', `/api/jobs/${retryId}/retry`)).statusCode).toBe(200);
    expect(await state(tenant, creditId)).toEqual({ reserved: 1, used: 0, status: 'reserved' });
  });

  it('a sibling solicitation that fails and releases the credit stops the matrix from being built for free', async () => {
    const { tenant, creditId, solicitationId } = await setup('sibling', 'reserved');
    const sibling = await addDocument(tenant, 'solicitation');
    extract.impl = async () => {
      // While this run waits on the model, the second solicitation file fails and releases.
      await steps.recordStepFailure('file', payload(tenant, sibling, 'solicitation'), new Error('sandbox down'));
      return matrix('free');
    };
    await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 0, status: 'released' });
    expect(await matrixRows(tenant, solicitationId)).toHaveLength(0);
    const held = await latestJob(tenant, solicitationId);
    expect({ type: held.type, status: held.status, error: held.error }).toEqual({ type: 'classify', status: 'failed', error: rows.SOLICITATION_CREDIT_RELEASED });
    // A run that starts after the release spends no AI at all.
    extract.impl = async () => matrix('x');
    await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
    expect(extractCalls()).toBe(1);
    // The retry reserves again, and the matrix is built and paid for.
    // The retry is of the newest failed step (the second run recorded its own).
    const retryId = (await as(app, tenant.token)('POST', `/api/jobs/${(await latestJob(tenant, solicitationId)).id}/retry`)).json<{ id: string }>().id;
    await worker.processCompliance({ ...payload(tenant, solicitationId, 'solicitation'), jobId: retryId });
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 1, status: 'consumed' });
    expect(await matrixRows(tenant, solicitationId)).toHaveLength(1);
  });

  it('an attachment or amendment held while the credit is released runs after a retry consumes it', async () => {
    const { tenant, creditId, solicitationId, attachmentId } = await setup('held-runs', 'released');
    const amendmentId = await addDocument(tenant, 'amendment', 'Amendment 0001 to solicitation SOL-held-runs');
    await classify.processClassify(payload(tenant, attachmentId, 'attachment'));
    await classify.processClassify(payload(tenant, amendmentId, 'amendment'));
    expect(enqueued).toEqual([]);
    for (const id of [attachmentId, amendmentId]) {
      expect((await latestJob(tenant, id)).error).toBe(rows.HELD_FOR_CREDIT);
    }

    const failed = await jobRow(tenant, solicitationId, 'classify', 'failed');
    expect((await as(app, tenant.token)('POST', `/api/jobs/${failed}/retry`)).statusCode).toBe(200);
    await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 1, status: 'consumed' });
    // The consume kicked classify for both held files, each with a pending classify row.
    expect(enqueued.filter((name) => name === 'classify')).toHaveLength(2);
    const kicked = await latestJob(tenant, attachmentId);
    expect({ type: kicked.type, status: kicked.status }).toEqual({ type: 'classify', status: 'pending' });
    expect((await latestJob(tenant, amendmentId)).status).toBe('pending');

    enqueued.length = 0;
    await classify.processClassify({ ...payload(tenant, attachmentId, 'attachment'), jobId: kicked.id });
    expect(enqueued).toEqual(['ai:overview', 'ai:dates', 'ai:compliance']);
    expect((await latestJob(tenant, attachmentId)).status).toBe('completed');
    await worker.processCompliance(payload(tenant, attachmentId, 'attachment'));
    expect(await matrixRows(tenant, attachmentId)).toHaveLength(1);
    // Nothing is held any more (the attachment went through; the amendment's kicked row is
    // pending): another kick reruns nothing.
    enqueued.length = 0;
    const { kickHeldDocuments } = await import('../../worker/src/kick.js');
    await kickHeldDocuments(tenant.orgId, tenant.bidId);
    expect(enqueued).toEqual([]);
  });

  it('a held attachment and the retry that reserves the credit race without stranding the attachment', async () => {
    for (const order of ['classify first', 'retry first', 'classify first', 'retry first']) {
      const { tenant, creditId, solicitationId, attachmentId } = await setup(`held-race-${randomUUID().slice(0, 8)}`, 'released');
      const failed = await jobRow(tenant, solicitationId, 'classify', 'failed');
      enqueued.length = 0;
      const runClassify = () => classify.processClassify(payload(tenant, attachmentId, 'attachment'));
      const retry = () => as(app, tenant.token)('POST', `/api/jobs/${failed}/retry`);
      // The bid row is held, so both queue on it (or on the organization behind it) in this order.
      const contenders = order === 'classify first' ? [runClassify, retry] : [retry, runClassify];
      const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId], contenders);
      expect(waiting, order).toBe(2);
      results.forEach((result) => fulfilled(result));
      const proceeded = enqueued.includes('ai:compliance');
      // The retry reserved; the solicitation's matrix then consumes and kicks what is held.
      await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
      expect(await state(tenant, creditId), order).toEqual({ reserved: 0, used: 1, status: 'consumed' });
      const kicked = enqueued.includes('classify');
      // Exactly one of the two: classify saw the credit and went on, or it was held and kicked.
      expect(proceeded !== kicked, `${order}: proceeded ${proceeded}, kicked ${kicked}`).toBe(true);
      expect(order === 'classify first' ? kicked : proceeded, order).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Review fixes.

  it('a deleted solicitation that fails later neither records a step nor releases its live sibling\'s reservation', async () => {
    const { tenant, creditId, solicitationId } = await setup('deleted-fails', 'reserved');
    const deleted = await addDocument(tenant, 'solicitation');
    // The user deletes the second file; the first keeps the bid's reservation (documents.ts).
    const response = await as(app, tenant.token)('DELETE', `/api/documents/${deleted}`);
    expect(response.json<{ creditReleased: boolean }>().creditReleased).toBe(false);
    await steps.recordStepFailure('file', payload(tenant, deleted, 'solicitation'), new Error('file is gone'));
    expect(await state(tenant, creditId)).toEqual({ reserved: 1, used: 0, status: 'reserved' });
    expect(await jobsOf(tenant, deleted)).toEqual([]);
    // The live solicitation's matrix is built and paid for.
    await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 1, status: 'consumed' });
  });

  it('a rerun of the overview and dates steps adds no duplicates and never deletes or changes a row', async () => {
    const { tenant, solicitationId } = await setup('rerun-facts', 'consumed');
    await withOrg(tenant.orgId, (db) => db.update(schema.pages).set({ text: 'Proposals are due December 15, 2026.\nQuestions by 12/01/2026.' })
      .where(eq(schema.pages.documentId, solicitationId)));
    overviewFacts.facts = [
      { field: 'agency', value: 'GSA', sourceQuote: 'GSA', sourcePage: 1 },
      { field: 'naics', value: '541511', sourceQuote: '541511', sourcePage: 1 },
      { field: 'setAside', value: 'SB', sourceQuote: 'small business', sourcePage: 1 },
    ];
    const p = payload(tenant, solicitationId, 'solicitation');
    const facts = () => withOrg(tenant.orgId, (db) => db.select().from(schema.bidFacts).where(eq(schema.bidFacts.documentId, solicitationId)));
    const dates = () => withOrg(tenant.orgId, (db) => db.select().from(schema.scheduleActivities).where(eq(schema.scheduleActivities.documentId, solicitationId)));
    await worker.processOverview(p);
    await worker.processDates(p);
    expect(await facts()).toHaveLength(3);
    const firstDates = await dates();
    expect(firstDates.length).toBeGreaterThan(0);
    // A user edits an AI date in the Schedule tab; that patch records no row history.
    await withOrg(tenant.orgId, (db) => db.update(schema.scheduleActivities).set({ owner: 'Ray', status: 'done' })
      .where(eq(schema.scheduleActivities.id, firstDates[0].id)));

    // A user confirms one fact and edits another (row history), and adds a fact of their own.
    const [agency, naics] = (await facts()).sort((a, b) => a.field.localeCompare(b.field));
    await withOrg(tenant.orgId, async (db) => {
      await db.update(schema.bidFacts).set({ confirmed: true }).where(eq(schema.bidFacts.id, agency.id));
      await db.update(schema.bidFacts).set({ value: '541512' }).where(eq(schema.bidFacts.id, naics.id));
      await db.insert(schema.rowHistory).values({ orgId: tenant.orgId, rowTable: 'bid_facts', rowId: naics.id, field: 'value', oldValue: '541511', newValue: '541512', changedAt: new Date() });
      await db.insert(schema.bidFacts).values({ orgId: tenant.orgId, bidId: tenant.bidId, field: 'note', value: 'mine', documentId: solicitationId, origin: 'user' });
    });

    await worker.processOverview(p);
    await worker.processDates(p);
    await worker.processOverview(p);
    await worker.processDates(p);
    const after = await facts();
    // agency (confirmed), naics (edited), setAside (kept), note (user): no duplicates.
    expect(after.map((fact) => fact.field).sort()).toEqual(['agency', 'naics', 'note', 'setAside']);
    expect(after.find((fact) => fact.id === naics.id)?.value).toBe('541512');
    const afterDates = await dates();
    expect(afterDates).toHaveLength(firstDates.length);
    expect(afterDates.find((row) => row.id === firstDates[0].id)).toMatchObject({ owner: 'Ray', status: 'done' });
    overviewFacts.facts = [];
  });

  it('a double-clicked retry runs once: the second answers 409', async () => {
    const { tenant, solicitationId } = await setup('double-retry', 'released');
    const failed = await jobRow(tenant, solicitationId, 'classify', 'failed');
    const call = as(app, tenant.token);
    const [first, second] = await Promise.all([call('POST', `/api/jobs/${failed}/retry`), call('POST', `/api/jobs/${failed}/retry`)]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json<{ code: string }>().code).toBe('retry_superseded');
    expect((await jobsOf(tenant, solicitationId)).filter((job) => job.status === 'pending')).toHaveLength(1);
  });

  it('a retry of a held attachment after the kick reran it answers 409, and a rerun of its matrix adds no rows', async () => {
    const { tenant, solicitationId, attachmentId } = await setup('kick-vs-retry', 'released');
    await classify.processClassify(payload(tenant, attachmentId, 'attachment'));
    const held = await latestJob(tenant, attachmentId);
    expect(held.error).toBe(rows.HELD_FOR_CREDIT);
    const failed = await jobRow(tenant, solicitationId, 'classify', 'failed');
    expect((await as(app, tenant.token)('POST', `/api/jobs/${failed}/retry`)).statusCode).toBe(200);
    await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
    expect((await latestJob(tenant, attachmentId)).status).toBe('pending');
    const late = await as(app, tenant.token)('POST', `/api/jobs/${held.id}/retry`);
    expect(late.statusCode).toBe(409);
    // Even a duplicate matrix job for the attachment writes its rows once.
    await worker.processCompliance(payload(tenant, attachmentId, 'attachment'));
    await worker.processCompliance(payload(tenant, attachmentId, 'attachment'));
    expect(await matrixRows(tenant, attachmentId)).toHaveLength(1);
  });

  it('a classify that cannot close its row after queueing the matrix keeps the credit', async () => {
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    const { tenant, creditId, solicitationId } = await setup('close-fails', 'reserved');
    const classifyJob = await jobRow(tenant, solicitationId, 'classify', 'pending');
    await admin.query(`create or replace function pd_test_no_close() returns trigger language plpgsql as $$
      begin if new.id = '${classifyJob}' and new.status = 'completed' then raise exception 'no close'; end if; return new; end $$`);
    await admin.query('create trigger pd_test_no_close before update on jobs for each row execute function pd_test_no_close()');
    try {
      await steps.guardStep('classify', classify.processClassify)({ ...payload(tenant, solicitationId, 'solicitation'), jobId: classifyJob });
      expect(enqueued).toContain('ai:compliance');
      expect(await state(tenant, creditId)).toEqual({ reserved: 1, used: 0, status: 'reserved' });
    } finally {
      await admin.query('drop trigger if exists pd_test_no_close on jobs');
      await admin.query('drop function if exists pd_test_no_close()');
      await admin.end();
    }
  });

  it('a retry or an upload complete whose queue call fails releases the credit it reserved', async () => {
    const { tenant, creditId, solicitationId } = await setup('queue-fails', 'released');
    // The tenant's own (archived) solicitation would count as a sibling that shares the credit.
    await dropTenantSolicitation(tenant);
    const failed = await jobRow(tenant, solicitationId, 'classify', 'failed');
    vi.mocked(enqueueClassify).mockRejectedValueOnce(new Error('redis down'));
    const retried = await as(app, tenant.token)('POST', `/api/jobs/${failed}/retry`);
    expect(retried.statusCode).toBe(500);
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 0, status: 'released' });
    expect((await latestJob(tenant, solicitationId)).status).toBe('failed');

    const other = await createTenant(app, 'queue-fails-upload');
    const { bidId, sessionId } = await solicitationSession(other);
    vi.mocked(enqueueScan).mockRejectedValueOnce(new Error('redis down'));
    expect((await as(app, other.token)('POST', `/api/uploads/${sessionId}/complete`)).statusCode).toBe(500);
    const [bid] = await withOrg(other.orgId, (db) => db.select().from(schema.bids).where(eq(schema.bids.id, bidId)));
    expect(bid.creditStatus).toBe('released');
    const credits = await withOrg(other.orgId, (db) => db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.orgId, other.orgId)));
    expect(credits.reduce((sum, row) => sum + row.reserved, 0)).toBe(0);
  });

  it('a solicitation stopped by a sibling\'s release reruns when the sibling consumes', async () => {
    const { tenant, creditId, solicitationId } = await setup('held-sibling', 'reserved');
    const stopped = await addDocument(tenant, 'solicitation');
    await withOrg(tenant.orgId, (db) => db.insert(schema.jobs).values({
      orgId: tenant.orgId, bidId: tenant.bidId, documentId: stopped, type: 'classify', status: 'failed', error: rows.SOLICITATION_CREDIT_RELEASED,
    }));
    await worker.processCompliance(payload(tenant, solicitationId, 'solicitation'));
    expect(await state(tenant, creditId)).toEqual({ reserved: 0, used: 1, status: 'consumed' });
    expect(enqueued).toContain('classify');
    const kicked = await latestJob(tenant, stopped);
    expect({ type: kicked.type, status: kicked.status }).toEqual({ type: 'classify', status: 'pending' });
  });

  it('a retry and the kick of one held file, queued on its job lock, add one job between them', async () => {
    for (const kickFirst of [true, false, true, false]) {
      const { tenant, attachmentId } = await setup(`kick-lock-${randomUUID().slice(0, 8)}`, 'released');
      await classify.processClassify(payload(tenant, attachmentId, 'attachment'));
      const held = await latestJob(tenant, attachmentId);
      expect(held.error).toBe(rows.HELD_FOR_CREDIT);
      await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'consumed' }).where(eq(schema.bids.id, tenant.bidId)));
      const { kickHeldDocuments } = await import('../../worker/src/kick.js');
      const kick = () => kickHeldDocuments(tenant.orgId, tenant.bidId).then(() => ({ statusCode: 0 }));
      const retry = () => as(app, tenant.token)('POST', `/api/jobs/${held.id}/retry`);
      const { waiting, results } = await raceInOrder(tenant.orgId, 'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`document-jobs:${attachmentId}`], kickFirst ? [kick, retry] : [retry, kick]);
      expect(waiting).toBe(2);
      const retried = fulfilled(results[kickFirst ? 1 : 0]) as { statusCode: number };
      expect(retried.statusCode).toBe(kickFirst ? 409 : 200);
      const pending = (await jobsOf(tenant, attachmentId)).filter((job) => job.status === 'pending');
      expect(pending).toHaveLength(1);
    }
  });

  it('a retry is refused only for a newer unfinished or failed step, not a newer completed one', async () => {
    const { tenant, solicitationId } = await setup('newer-completed', 'reserved');
    const failed = await jobRow(tenant, solicitationId, 'scan', 'failed');
    await jobRow(tenant, solicitationId, 'classify', 'completed');
    expect((await as(app, tenant.token)('POST', `/api/jobs/${failed}/retry`)).statusCode).toBe(200);
  });

  it('an upload complete whose queue call fails keeps a reservation another solicitation now relies on', async () => {
    const other = await createTenant(app, 'queue-fails-shared');
    const { bidId, sessionId } = await solicitationSession(other);
    // Meanwhile the session's reservation was released and another solicitation of the bid took
    // the bid's credit again (same period, so the same credit id).
    await withOrg(other.orgId, (db) => db.insert(schema.documents).values({
      orgId: other.orgId, bidId, fileName: 's1.pdf', mime: 'application/pdf', sizeBytes: 5,
      sha256: randomUUID(), kind: 'solicitation', storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
    }));
    vi.mocked(enqueueScan).mockRejectedValueOnce(new Error('redis down'));
    expect((await as(app, other.token)('POST', `/api/uploads/${sessionId}/complete`)).statusCode).toBe(500);
    const [bid] = await withOrg(other.orgId, (db) => db.select().from(schema.bids).where(eq(schema.bids.id, bidId)));
    expect(bid.creditStatus).toBe('reserved');
  });
});

/**
 * Credit settlement across the api and the worker, against the real database: the worker's
 * classify and compliance steps are imported from apps/worker with the AI provider mocked.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { as, createTenant, type Tenant } from './helpers.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const enqueued = vi.hoisted(() => [] as string[]);
vi.mock('../../worker/src/enqueue.js', () => ({
  enqueue: vi.fn(async (name: string) => {
    enqueued.push(name);
  }),
}));

const extract = vi.hoisted(() => ({ impl: null as null | (() => Promise<unknown>) }));
vi.mock('@pd/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pd/ai')>();
  return {
    ...original,
    getProvider: () => ({}),
    extractComplianceMatrix: vi.fn(async () => extract.impl!()),
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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pd-api-worker-'));
    process.env.DATA_DIR = dataDir;
    getPool({ connectionString: inject('appUrl'), max: 8 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    worker = await import('../../worker/src/ai-jobs.js');
    classify = await import('../../worker/src/classify-job.js');
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  beforeEach(() => {
    enqueued.length = 0;
    extract.impl = async () => matrix('x');
  });

  async function setup(label: string, creditStatus: 'reserved' | 'released' | null, allowed = 5) {
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

  const payload = (tenant: Tenant, documentId: string, kind: 'solicitation' | 'attachment' | 'resume' | 'draft') => ({
    orgId: tenant.orgId, bidId: tenant.bidId, documentId, jobId: randomUUID(), storagePath: 'docs/x.pdf', kind,
  });
  const state = (tenant: Tenant, creditId: string) => withOrg(tenant.orgId, async (db) => {
    const [credit] = await db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.id, creditId));
    const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, tenant.bidId));
    return { reserved: credit.reserved, used: credit.used, status: bid.creditStatus };
  });

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

    // An attachment already on a bid whose credit was released: no AI steps, no rows.
    const { tenant: other, attachmentId } = await setup('attach-released', 'released');
    await classify.processClassify(payload(other, attachmentId, 'attachment'));
    expect(enqueued).toEqual([]);
    await worker.processCompliance(payload(other, attachmentId, 'attachment'));
    const rows = await withOrg(other.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.documentId, attachmentId)));
    expect(rows).toHaveLength(0);
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
});


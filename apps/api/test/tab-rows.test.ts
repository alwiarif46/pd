/**
 * Tab-row contracts (09 s5.4 to 5.9, 5.17): typed statuses, check-these hits from the worker
 * and their routes, outline moves, derived candidate fields, review authors, production and
 * orals fields, and history names. Runs as pd_app against the real database; the worker's
 * compliance step runs with the AI pipeline mocked.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getDb, getPool, schema, withOrg } from '@pd/core';
import { as, createTenant, type Tenant } from './helpers.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

vi.mock('../../worker/src/enqueue.js', () => ({
  enqueue: vi.fn(async () => undefined),
}));

const extract = vi.hoisted(() => ({ hits: [] as { text: string; pageNo: number; kind: 'requirement' | 'informational' }[] }));
vi.mock('@pd/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pd/ai')>();
  return {
    ...original,
    getProvider: () => ({}),
    extractComplianceMatrix: vi.fn(async () => ({
      requirements: [],
      checkThese: extract.hits,
      metadata: { skillName: 'compliance', skillVersion: '1', tokensUsed: 1, costUsd: 0 },
    })),
  };
});

const unavailable = inject('dbUnavailable');

type Call = ReturnType<typeof as>;

describe.skipIf(Boolean(unavailable))('tab rows', () => {
  let app: FastifyInstance;
  let worker: typeof import('../../worker/src/ai-jobs.js');
  let a: Tenant;
  let b: Tenant;
  let asA: Call;
  let asB: Call;

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-tabrows-'));
    delete process.env.PD_ALLOW_BYPASS_RLS;
    getPool({ connectionString: inject('appUrl'), max: 8 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    worker = await import('../../worker/src/ai-jobs.js');
    a = await createTenant(app, 'ta');
    b = await createTenant(app, 'tb');
    // The worker builds a matrix only while the bid's solicitation holds a credit (06 s4).
    for (const tenant of [a, b]) {
      await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'consumed' }).where(eq(schema.bids.id, tenant.bidId)));
    }
    asA = as(app, a.token);
    asB = as(app, b.token);
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  beforeEach(() => {
    extract.hits = [];
  });

  const rowUrl = (tenant: Tenant, table: string, rowId: string) => `/api/bids/${tenant.bidId}/rows/${table}/${rowId}`;

  async function liveDocument(tenant: Tenant, kind: 'solicitation' | 'resume' | 'draft' = 'solicitation', fileName = `${kind}.pdf`) {
    return withOrg(tenant.orgId, async (db) => {
      const [row] = await db.insert(schema.documents).values({
        orgId: tenant.orgId, bidId: tenant.bidId, fileName, mime: 'application/pdf', sizeBytes: 5,
        sha256: randomUUID(), kind, storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
      }).returning();
      return row;
    });
  }

  /** The page text a promoted sentence must still appear on. */
  async function addPage(tenant: Tenant, documentId: string, pageNo: number, text: string) {
    await withOrg(tenant.orgId, (db) => db.insert(schema.pages).values({ orgId: tenant.orgId, documentId, pageNo, text }));
  }

  /** Polls until `count` backends of this database wait on a lock (advisory or row). */
  async function waitForWaiters(holder: pg.Client, count: number) {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      // pg_stat_activity is snapshotted once per transaction; the holder polls inside one.
      await holder.query('select pg_stat_clear_snapshot()');
      const { rows } = await holder.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (rows[0].n >= count) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Fewer than ${count} backends waited on the lock`);
  }

  /**
   * Holds `lockSql` in a transaction on its own superuser connection, starts `fire`, waits until
   * `waiters` backends queue behind the lock, then releases it: the requests really contend.
   */
  async function contend<T>(lockSql: string, params: unknown[], waiters: number, fire: () => Promise<T>[]): Promise<T[]> {
    const holder = new pg.Client({ connectionString: inject('adminUrl') });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(lockSql, params);
      const pending = fire();
      await waitForWaiters(holder, waiters);
      await holder.query('commit');
      return await Promise.all(pending);
    } finally {
      await holder.end();
    }
  }

  const holdOutline = (bidId: string) => ['select pg_advisory_xact_lock(hashtextextended($1, 0))', [`outline:${bidId}`]] as const;

  const compliancePayload = (tenant: Tenant, documentId: string) => ({
    orgId: tenant.orgId, bidId: tenant.bidId, documentId, jobId: randomUUID(), storagePath: 'docs/x.pdf', kind: 'solicitation' as const,
  });

  describe('compliance status', () => {
    it('defaults to open and accepts only open, assigned, drafted, done', async () => {
      const created = await asA('POST', `/api/bids/${a.bidId}/tabs/compliance/rows`, { requirementText: 'Provide a plan.' });
      expect(created.statusCode).toBe(201);
      const row = created.json<{ id: string; status: string }>();
      expect(row.status).toBe('open');
      expect((await asA('POST', `/api/bids/${a.bidId}/tabs/compliance/rows`, { requirementText: 'x', status: 'started' })).statusCode).toBe(400);
      const bad = await asA('PATCH', rowUrl(a, 'compliance_rows', row.id), { fields: { status: 'started' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ error: string }>().error).toMatch(/open, assigned, drafted, done/);
      expect((await asA('PATCH', rowUrl(a, 'compliance_rows', row.id), { fields: { status: null } })).statusCode).toBe(400);
      expect((await asA('PATCH', rowUrl(a, 'compliance_rows', row.id), { fields: { status: 'drafted' } })).statusCode).toBe(200);
      const detail = await asA('GET', rowUrl(a, 'compliance_rows', row.id));
      expect(detail.json<{ row: { status: string } }>().row.status).toBe('drafted');
    });

    it('takes loosely written values and ignores an empty status from the legacy slider', async () => {
      const created = await asA('POST', `/api/bids/${a.bidId}/tabs/compliance/rows`, { requirementText: 'Loose.', status: ' Done ' });
      expect(created.statusCode).toBe(201);
      const row = created.json<{ id: string; status: string }>();
      expect(row.status).toBe('done');
      expect((await asA('PATCH', rowUrl(a, 'compliance_rows', row.id), { fields: { status: '', owner: 'Ray' } })).statusCode).toBe(200);
      expect((await asA('GET', rowUrl(a, 'compliance_rows', row.id))).json<{ row: { status: string; owner: string } }>().row)
        .toMatchObject({ status: 'done', owner: 'Ray' });
      expect((await asA('PATCH', rowUrl(a, 'compliance_rows', row.id), { fields: { status: 'Assigned' } })).statusCode).toBe(200);
      expect((await asA('GET', rowUrl(a, 'compliance_rows', row.id))).json<{ row: { status: string } }>().row.status).toBe('assigned');
    });

    it('records only the fields a patch sends', async () => {
      const created = await asA('POST', `/api/bids/${a.bidId}/tabs/compliance/rows`, { requirementText: 'Owned row.', owner: 'Pat' });
      const id = created.json<{ id: string }>().id;
      await asA('PATCH', rowUrl(a, 'compliance_rows', id), { fields: { status: 'assigned' } });
      const detail = await asA('GET', rowUrl(a, 'compliance_rows', id));
      const history = detail.json<{ history: { field: string }[] }>().history;
      expect(history.map((entry) => entry.field)).toEqual(['status']);
    });
  });

  describe('check these', () => {
    it('the worker writes requirement hits with the rows; a retry does not duplicate them', async () => {
      const document = await liveDocument(a);
      extract.hits = [
        { text: 'The offeror shall submit a staffing plan.', pageNo: 3, kind: 'requirement' },
        { text: 'The Government will evaluate price.', pageNo: 4, kind: 'informational' },
        { text: 'The offeror shall submit a staffing plan.', pageNo: 3, kind: 'requirement' },
      ];
      await worker.processCompliance(compliancePayload(a, document.id));
      await worker.processCompliance(compliancePayload(a, document.id));
      const list = await asA('GET', `/api/bids/${a.bidId}/check-these`);
      expect(list.statusCode).toBe(200);
      const hits = list.json<{ id: string; documentId: string; sentence: string; page: number }[]>()
        .filter((hit) => hit.documentId === document.id);
      expect(hits).toEqual([{ id: expect.any(String), documentId: document.id, sentence: 'The offeror shall submit a staffing plan.', page: 3 }]);
    });

    it('promotes a hit to a sourced user row, once; a rerun does not offer it again', async () => {
      const document = await liveDocument(a);
      extract.hits = [{ text: 'The offeror must provide resumes.', pageNo: 7, kind: 'requirement' }];
      await addPage(a, document.id, 7, 'C.4 Staffing.\nThe offeror must provide resumes. Resumes are two pages.');
      await worker.processCompliance(compliancePayload(a, document.id));
      const [hit] = (await asA('GET', `/api/bids/${a.bidId}/check-these`)).json<{ id: string; documentId: string }[]>()
        .filter((row) => row.documentId === document.id);
      const promoted = await asA('POST', `/api/check-these/${hit.id}/promote`);
      expect(promoted.statusCode).toBe(201);
      expect(promoted.json()).toMatchObject({
        requirementText: 'The offeror must provide resumes.',
        sourceQuote: 'The offeror must provide resumes.',
        sourcePage: 7,
        documentId: document.id,
        origin: 'user',
        status: 'open',
        reqType: 'must',
      });
      expect((await asA('POST', `/api/check-these/${hit.id}/promote`)).statusCode).toBe(409);
      expect((await asA('POST', `/api/check-these/${hit.id}/dismiss`)).statusCode).toBe(409);
      await worker.processCompliance(compliancePayload(a, document.id));
      const after = (await asA('GET', `/api/bids/${a.bidId}/check-these`)).json<{ documentId: string }[]>();
      expect(after.filter((row) => row.documentId === document.id)).toEqual([]);
      const [stored] = await withOrg(a.orgId, (db) => db.select().from(schema.checkThese).where(eq(schema.checkThese.id, hit.id)));
      expect(stored).toMatchObject({ status: 'promoted', promotedRowId: promoted.json<{ id: string }>().id, decidedBy: a.userId });
    });

    it('two concurrent promotes of one hit create one row', async () => {
      const document = await liveDocument(a);
      extract.hits = [{ text: 'The offeror shall attend orals.', pageNo: 2, kind: 'requirement' }];
      await addPage(a, document.id, 2, 'The offeror shall attend orals.');
      await worker.processCompliance(compliancePayload(a, document.id));
      const [hit] = (await asA('GET', `/api/bids/${a.bidId}/check-these`)).json<{ id: string; documentId: string }[]>()
        .filter((row) => row.documentId === document.id);
      const results = await Promise.all([
        asA('POST', `/api/check-these/${hit.id}/promote`),
        asA('POST', `/api/check-these/${hit.id}/promote`),
        asA('POST', `/api/check-these/${hit.id}/promote`),
      ]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409, 409]);
      const rows = await withOrg(a.orgId, (db) => db.select().from(schema.complianceRows).where(and(
        eq(schema.complianceRows.documentId, document.id),
        eq(schema.complianceRows.requirementText, 'The offeror shall attend orals.'),
      )));
      expect(rows).toHaveLength(1);
    });

    it('writes a run with more hits than one insert statement takes', async () => {
      const document = await liveDocument(a);
      extract.hits = Array.from({ length: 1201 }, (_, index) => ({ text: `The offeror shall do task ${index}.`, pageNo: 1 + (index % 40), kind: 'requirement' as const }));
      await worker.processCompliance(compliancePayload(a, document.id));
      const count = await withOrg(a.orgId, (db) => db.select({ id: schema.checkThese.id }).from(schema.checkThese)
        .where(eq(schema.checkThese.documentId, document.id)));
      expect(count).toHaveLength(1201);
    });

    it('refuses to promote a sentence that is not on its page', async () => {
      const document = await liveDocument(a);
      extract.hits = [{ text: 'The offeror shall wear hats.', pageNo: 9, kind: 'requirement' }];
      await addPage(a, document.id, 9, 'Nothing about hats here.');
      await worker.processCompliance(compliancePayload(a, document.id));
      const [hit] = (await asA('GET', `/api/bids/${a.bidId}/check-these`)).json<{ id: string; documentId: string }[]>()
        .filter((row) => row.documentId === document.id);
      const refused = await asA('POST', `/api/check-these/${hit.id}/promote`);
      expect(refused.statusCode).toBe(409);
      const [stored] = await withOrg(a.orgId, (db) => db.select().from(schema.checkThese).where(eq(schema.checkThese.id, hit.id)));
      expect(stored.status).toBe('open');
    });

    it('a promote that waits behind a matrix rerun gets 409, and the rerun offers the sentence again', async () => {
      const document = await liveDocument(a);
      const sentence = 'The offeror shall staff a help desk.';
      extract.hits = [{ text: sentence, pageNo: 4, kind: 'requirement' }];
      await addPage(a, document.id, 4, sentence);
      await worker.processCompliance(compliancePayload(a, document.id));
      const [hit] = (await asA('GET', `/api/bids/${a.bidId}/check-these`)).json<{ id: string; documentId: string }[]>()
        .filter((row) => row.documentId === document.id);
      // Hold the document row; the rerun queues on it first, then the promote behind the rerun.
      const holder = new pg.Client({ connectionString: inject('adminUrl') });
      await holder.connect();
      let promote: Awaited<ReturnType<Call>> | undefined;
      try {
        await holder.query('begin');
        await holder.query('select 1 from documents where id = $1 for update', [document.id]);
        const rerun = worker.processCompliance(compliancePayload(a, document.id));
        await waitForWaiters(holder, 1);
        const promoting = asA('POST', `/api/check-these/${hit.id}/promote`);
        await waitForWaiters(holder, 2);
        await holder.query('commit');
        await rerun;
        promote = await promoting;
      } finally {
        await holder.end();
      }
      expect(promote?.statusCode).toBe(409);
      const after = (await asA('GET', `/api/bids/${a.bidId}/check-these`)).json<{ id: string; documentId: string; sentence: string }[]>()
        .filter((row) => row.documentId === document.id);
      expect(after).toEqual([expect.objectContaining({ sentence })]);
      expect(after[0].id).not.toBe(hit.id);
      const rows = await withOrg(a.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.requirementText, sentence)));
      expect(rows).toHaveLength(0);
    });

    it('dismisses a hit, and hides the hits of a deleted document', async () => {
      const document = await liveDocument(a);
      extract.hits = [
        { text: 'The offeror shall keep records.', pageNo: 1, kind: 'requirement' },
        { text: 'The offeror shall report monthly.', pageNo: 1, kind: 'requirement' },
      ];
      await worker.processCompliance(compliancePayload(a, document.id));
      const mine = async () => (await asA('GET', `/api/bids/${a.bidId}/check-these`)).json<{ id: string; documentId: string }[]>()
        .filter((row) => row.documentId === document.id);
      const [first] = await mine();
      expect((await asA('POST', `/api/check-these/${first.id}/dismiss`)).statusCode).toBe(200);
      expect(await mine()).toHaveLength(1);
      await withOrg(a.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' }).where(eq(schema.documents.id, document.id)));
      expect(await mine()).toEqual([]);
    });

    it('answers 404 across organizations and leaves the other hit open', async () => {
      const document = await liveDocument(b);
      extract.hits = [{ text: 'The offeror shall be insured.', pageNo: 5, kind: 'requirement' }];
      await worker.processCompliance(compliancePayload(b, document.id));
      const [hit] = (await asB('GET', `/api/bids/${b.bidId}/check-these`)).json<{ id: string }[]>();
      expect((await asA('GET', `/api/bids/${b.bidId}/check-these`)).statusCode).toBe(404);
      expect((await asA('POST', `/api/check-these/${hit.id}/promote`)).statusCode).toBe(404);
      expect((await asA('POST', `/api/check-these/${hit.id}/dismiss`)).statusCode).toBe(404);
      expect((await asA('POST', '/api/check-these/not-a-uuid/promote')).statusCode).toBe(404);
      const listA = (await asA('GET', `/api/bids/${a.bidId}/check-these`)).json<{ id: string }[]>();
      expect(listA.map((row) => row.id)).not.toContain(hit.id);
      const [stored] = await withOrg(b.orgId, (db) => db.select().from(schema.checkThese).where(eq(schema.checkThese.id, hit.id)));
      expect(stored.status).toBe('open');
    });
  });

  describe('outline', () => {
    async function outlineBid(tenant: Tenant, call: Call) {
      const bid = (await call('POST', '/api/bids', { name: `Outline ${randomUUID()}`, bidType: 'federal' })).json<{ id: string }>().id;
      const add = async (title: string, parentId?: string) => {
        const response = await call('POST', `/api/bids/${bid}/tabs/outline/rows`, { title, ...(parentId ? { parentId } : {}) });
        expect(response.statusCode, response.body).toBe(201);
        return response.json<{ id: string; position: number; status: string }>();
      };
      return { bid, add };
    }

    type Item = { id: string; parentId: string | null; position: number; title: string };
    const children = (items: Item[], parentId: string | null) => items
      .filter((item) => item.parentId === parentId)
      .sort((x, y) => x.position - y.position)
      .map((item) => item.title);

    it('adds items at the end with status not_started and validates status', async () => {
      const { bid, add } = await outlineBid(a, asA);
      const v1 = await add('Volume 1');
      const s1 = await add('1.1', v1.id);
      const s2 = await add('1.2', v1.id);
      expect([v1.position, s1.position, s2.position]).toEqual([0, 0, 1]);
      expect(s1.status).toBe('not_started');
      expect((await asA('POST', `/api/bids/${bid}/tabs/outline/rows`, { title: 'x', status: 'started' })).statusCode).toBe(400);
      expect((await asA('PATCH', `/api/bids/${bid}/rows/outline_items/${s1.id}`, { fields: { status: 'started' } })).statusCode).toBe(400);
      expect((await asA('PATCH', `/api/bids/${bid}/rows/outline_items/${s1.id}`, { fields: { status: 'in_progress' } })).statusCode).toBe(200);
      const tab = (await asA('GET', `/api/bids/${bid}/tabs/outline`)).json<{ items: (Item & { status: string })[] }>();
      expect(tab.items.find((item) => item.id === s1.id)?.status).toBe('in_progress');
    });

    it('takes the legacy spellings of outline statuses', async () => {
      const { bid } = await outlineBid(a, asA);
      const created = await asA('POST', `/api/bids/${bid}/tabs/outline/rows`, { title: 'Legacy', status: 'not started' });
      expect(created.statusCode).toBe(201);
      expect(created.json<{ status: string }>().status).toBe('not_started');
      const id = created.json<{ id: string }>().id;
      expect((await asA('PATCH', `/api/bids/${bid}/rows/outline_items/${id}`, { fields: { status: 'In progress' } })).statusCode).toBe(200);
      expect((await asA('GET', `/api/bids/${bid}/rows/outline_items/${id}`)).json<{ row: { status: string } }>().row.status).toBe('in_progress');
    });

    it('reorders, moves to another volume, and records history', async () => {
      const { bid, add } = await outlineBid(a, asA);
      const v1 = await add('V1');
      const v2 = await add('V2');
      const a1 = await add('A1', v1.id);
      await add('A2', v1.id);
      await add('A3', v1.id);
      await add('B1', v2.id);
      let moved = await asA('POST', `/api/bids/${bid}/outline/move`, { id: a1.id, parentId: v1.id, index: 2 });
      expect(moved.statusCode).toBe(200);
      expect(children(moved.json<Item[]>(), v1.id)).toEqual(['A2', 'A3', 'A1']);
      moved = await asA('POST', `/api/bids/${bid}/outline/move`, { id: a1.id, parentId: v2.id, index: 0 });
      expect(children(moved.json<Item[]>(), v1.id)).toEqual(['A2', 'A3']);
      expect(children(moved.json<Item[]>(), v2.id)).toEqual(['A1', 'B1']);
      moved = await asA('POST', `/api/bids/${bid}/outline/move`, { id: v2.id, parentId: null, index: -5 });
      expect(children(moved.json<Item[]>(), null)).toEqual(['V2', 'V1']);
      moved = await asA('POST', `/api/bids/${bid}/outline/move`, { id: v2.id, parentId: null, index: 99 });
      expect(children(moved.json<Item[]>(), null)).toEqual(['V1', 'V2']);
      const detail = (await asA('GET', `/api/bids/${bid}/rows/outline_items/${a1.id}`)).json<{ history: { field: string; oldValue: string | null; newValue: string | null }[] }>();
      expect(detail.history).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'parentId', oldValue: v1.id, newValue: v2.id }),
        expect.objectContaining({ field: 'position', oldValue: '0', newValue: '2' }),
      ]));
    });

    it('refuses a move onto itself or under its own section', async () => {
      const { bid, add } = await outlineBid(a, asA);
      const v1 = await add('V1');
      const s1 = await add('S1', v1.id);
      const s11 = await add('S1.1', s1.id);
      expect((await asA('POST', `/api/bids/${bid}/outline/move`, { id: v1.id, parentId: v1.id, index: 0 })).statusCode).toBe(409);
      expect((await asA('POST', `/api/bids/${bid}/outline/move`, { id: v1.id, parentId: s11.id, index: 0 })).statusCode).toBe(409);
      expect((await asA('POST', `/api/bids/${bid}/outline/move`, { id: v1.id, parentId: null, index: 'x' })).statusCode).toBe(400);
      expect((await asA('POST', `/api/bids/${bid}/outline/move`, { id: randomUUID(), parentId: null, index: 0 })).statusCode).toBe(404);
    });

    /** Every sibling group's positions are 0..n-1. */
    async function expectContiguous(bid: string) {
      const all = (await asA('GET', `/api/bids/${bid}/tabs/outline`)).json<{ items: Item[] }>().items;
      for (const parentId of new Set(all.map((item) => item.parentId))) {
        const positions = all.filter((item) => item.parentId === parentId).map((item) => item.position).sort((x, y) => x - y);
        expect(positions, String(parentId)).toEqual(positions.map((_, index) => index));
      }
      return all;
    }

    it('keeps positions contiguous when moves contend for the outline lock', async () => {
      const { bid, add } = await outlineBid(a, asA);
      const v1 = await add('V1');
      const v2 = await add('V2');
      const items: { id: string }[] = [];
      for (let index = 0; index < 5; index += 1) {
        items.push(await add(`S${index}`, index % 2 ? v2.id : v1.id));
      }
      const [lockSql, params] = holdOutline(bid);
      const results = await contend(lockSql, [...params], items.length, () => items.map((item, index) => asA('POST', `/api/bids/${bid}/outline/move`, {
        id: item.id, parentId: index % 3 ? v1.id : v2.id, index: (index * 7) % 4,
      })));
      expect(results.map((result) => result.statusCode)).toEqual(items.map(() => 200));
      const all = await expectContiguous(bid);
      expect(all).toHaveLength(7);
    });

    it('an insert and a move that contend both land, contiguously', async () => {
      const { bid, add } = await outlineBid(a, asA);
      const v1 = await add('V1');
      await add('S0', v1.id);
      const s1 = await add('S1', v1.id);
      const [lockSql, params] = holdOutline(bid);
      const results = await contend(lockSql, [...params], 2, () => [
        asA('POST', `/api/bids/${bid}/tabs/outline/rows`, { title: 'S2', parentId: v1.id }),
        asA('POST', `/api/bids/${bid}/outline/move`, { id: s1.id, parentId: v1.id, index: 0 }),
      ]);
      expect(results.map((result) => result.statusCode)).toEqual([201, 200]);
      const all = await expectContiguous(bid);
      expect(children(all, v1.id)).toHaveLength(3);
    });

    it('a delete and a move that contend both land, contiguously', async () => {
      const { bid, add } = await outlineBid(a, asA);
      const v1 = await add('V1');
      const v2 = await add('V2');
      const s0 = await add('S0', v1.id);
      await add('S1', v1.id);
      await add('T0', v2.id);
      const [lockSql, params] = holdOutline(bid);
      const results = await contend(lockSql, [...params], 2, () => [
        asA('DELETE', `/api/bids/${bid}/rows/outline_items/${v1.id}`),
        asA('POST', `/api/bids/${bid}/outline/move`, { id: s0.id, parentId: v2.id, index: 0 }),
      ]);
      expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
      const all = await expectContiguous(bid);
      expect(all.find((item) => item.id === v1.id)).toBeUndefined();
      expect(children(all, v2.id)[0]).toBe('S0');
    });

    it('an insert under a parent deleted meanwhile is refused, not a server error', async () => {
      const { bid, add } = await outlineBid(a, asA);
      const v1 = await add('V1');
      const [lockSql, params] = holdOutline(bid);
      // The delete queues first, so the insert's parent check runs after it committed.
      const holder = new pg.Client({ connectionString: inject('adminUrl') });
      await holder.connect();
      try {
        await holder.query('begin');
        await holder.query(lockSql, [...params]);
        const deleting = asA('DELETE', `/api/bids/${bid}/rows/outline_items/${v1.id}`);
        await waitForWaiters(holder, 1);
        const inserting = asA('POST', `/api/bids/${bid}/tabs/outline/rows`, { title: 'Orphan', parentId: v1.id });
        await waitForWaiters(holder, 2);
        await holder.query('commit');
        expect((await deleting).statusCode).toBe(200);
        expect((await inserting).statusCode).toBe(400);
      } finally {
        await holder.end();
      }
    });

    it('closes the gap after a delete and puts promoted sections after the volumes', async () => {
      const { bid, add } = await outlineBid(a, asA);
      const v1 = await add('V1');
      await add('V2');
      await add('S0', v1.id);
      await add('S1', v1.id);
      expect((await asA('DELETE', `/api/bids/${bid}/rows/outline_items/${v1.id}`)).statusCode).toBe(200);
      const all = await expectContiguous(bid);
      expect(children(all, null)).toEqual(['V2', 'S0', 'S1']);
    });

    it('answers 404 for a move on another organization bid or item', async () => {
      const { bid, add } = await outlineBid(a, asA);
      const v1 = await add('V1');
      expect((await asB('POST', `/api/bids/${bid}/outline/move`, { id: v1.id, parentId: null, index: 0 })).statusCode).toBe(404);
      // The bid is checked before the body: a bad index on another organization's bid is 404.
      expect((await asB('POST', `/api/bids/${bid}/outline/move`, { id: v1.id, parentId: null, index: 'x' })).statusCode).toBe(404);
      expect((await asB('POST', `/api/bids/${b.bidId}/outline/move`, { id: v1.id, parentId: null, index: 0 })).statusCode).toBe(404);
      expect((await asA('POST', `/api/bids/${bid}/outline/move`, { id: v1.id, parentId: b.rows.outline_items, index: 0 })).statusCode).toBe(404);
    });
  });

  describe('resumes', () => {
    it('derives candidate status, upload date, and resume deletion', async () => {
      const failed = await liveDocument(a, 'resume', 'failed.pdf');
      const pending = await liveDocument(a, 'resume', 'pending.pdf');
      const done = await liveDocument(a, 'resume', 'done.pdf');
      const ids = await withOrg(a.orgId, async (db) => {
        const base = { orgId: a.orgId, bidId: a.bidId };
        await db.insert(schema.jobs).values([
          { ...base, documentId: failed.id, type: 'scan', status: 'completed', createdAt: new Date(Date.now() - 2000) },
          { ...base, documentId: failed.id, type: 'compliance', status: 'failed', createdAt: new Date(Date.now() - 1000) },
          { ...base, documentId: pending.id, type: 'scan', status: 'pending' },
          { ...base, documentId: done.id, type: 'scan', status: 'completed' },
        ]);
        await db.update(schema.documents).set({ liveStatus: 'deleted' }).where(eq(schema.documents.id, done.id));
        const rows = await db.insert(schema.candidates).values([
          { ...base, name: 'Failed', role: 'PM', documentId: failed.id },
          { ...base, name: 'Pending', role: 'PM', documentId: pending.id },
          { ...base, name: 'Done', role: 'PM', documentId: done.id },
          { ...base, name: 'None', role: 'PM' },
        ]).returning();
        return rows.map((row) => row.id);
      });
      const tab = (await asA('GET', `/api/bids/${a.bidId}/tabs/resumes`)).json<{
        candidates: { id: string; status: string; uploadedAt: string | null; resumeDeleted: boolean }[];
      }>();
      const byId = new Map(tab.candidates.map((candidate) => [candidate.id, candidate]));
      expect(ids.map((id) => byId.get(id)?.status)).toEqual(['failed', 'processing', 'ready', 'ready']);
      expect(byId.get(ids[0])?.uploadedAt).toBe(failed.createdAt.toISOString());
      expect(byId.get(ids[3])?.uploadedAt).toBeNull();
      expect(ids.map((id) => byId.get(id)?.resumeDeleted)).toEqual([false, false, true, false]);
      const detail = (await asA('GET', rowUrl(a, 'candidates', ids[1]))).json<{ row: { status: string } }>();
      expect(detail.row.status).toBe('processing');
    });

    it('overrides a match result, then restores the AI result, with history', async () => {
      const matchId = await withOrg(a.orgId, async (db) => {
        const [requirement] = await db.insert(schema.personnelRequirements).values({ orgId: a.orgId, bidId: a.bidId, role: 'PM', requirement: 'PMP' }).returning();
        const [candidate] = await db.insert(schema.candidates).values({ orgId: a.orgId, bidId: a.bidId, name: 'Lee', role: 'PM' }).returning();
        const [match] = await db.insert(schema.resumeMatches).values({
          orgId: a.orgId, candidateId: candidate.id, requirementId: requirement.id, result: 'partial', aiResult: 'partial',
        }).returning();
        return match.id;
      });
      const url = rowUrl(a, 'resume_matches', matchId);
      expect((await asA('PATCH', url, { fields: { result: 'excellent' } })).statusCode).toBe(400);
      expect((await asA('PATCH', url, { fields: { result: 'meets' } })).statusCode).toBe(200);
      let row = (await asA('GET', url)).json<{ row: { result: string; reviewerOverride: boolean; aiResult: string } }>().row;
      expect(row).toMatchObject({ result: 'meets', reviewerOverride: true, aiResult: 'partial' });
      expect((await asA('PATCH', url, { fields: { reviewerOverride: false } })).statusCode).toBe(200);
      const detail = (await asA('GET', url)).json<{
        row: { result: string; reviewerOverride: boolean };
        history: { field: string; oldValue: string | null; newValue: string | null; userName: string | null }[];
      }>();
      row = detail.row as typeof row;
      expect(row).toMatchObject({ result: 'partial', reviewerOverride: false });
      // Entries of one patch share a timestamp, so compare each patch's entries as a set.
      const entries = detail.history.map((entry) => [entry.field, entry.oldValue, entry.newValue]);
      expect(entries).toHaveLength(4);
      expect(entries.slice(0, 2)).toEqual(expect.arrayContaining([
        ['result', 'partial', 'meets'],
        ['reviewerOverride', 'false', 'true'],
      ]));
      expect(entries.slice(2)).toEqual(expect.arrayContaining([
        ['result', 'meets', 'partial'],
        ['reviewerOverride', 'true', 'false'],
      ]));
    });

    it('restores unknown when there is no AI result', async () => {
      const response = await asA('POST', `/api/bids/${a.bidId}/tabs/resumes/rows`, {
        kind: 'match', candidateId: a.rows.candidates, requirementId: (await withOrg(a.orgId, async (db) => {
          const [requirement] = await db.insert(schema.personnelRequirements).values({ orgId: a.orgId, bidId: a.bidId, role: 'PM', requirement: 'MBA' }).returning();
          return requirement.id;
        })),
      });
      expect(response.statusCode).toBe(201);
      const url = rowUrl(a, 'resume_matches', response.json<{ id: string }>().id);
      await asA('PATCH', url, { fields: { result: 'gap' } });
      await asA('PATCH', url, { fields: { reviewerOverride: false } });
      expect((await asA('GET', url)).json<{ row: { result: string } }>().row.result).toBe('unknown');
    });
  });

  describe('document links', () => {
    const rowsUrl = (tab: string) => `/api/bids/${a.bidId}/tabs/${tab}/rows`;

    /** Documents that are not a valid link for `kind`: wrong kind, deleted, of another bid, of another org, not a UUID, not a string. */
    async function badLinks(kind: 'resume' | 'draft') {
      const other = kind === 'resume' ? 'draft' : 'resume';
      const deleted = await liveDocument(a, kind, 'gone.pdf');
      await withOrg(a.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' }).where(eq(schema.documents.id, deleted.id)));
      const otherBid = await withOrg(a.orgId, async (db) => {
        const [bid] = await db.insert(schema.bids).values({ orgId: a.orgId, name: 'Other bid', bidType: 'federal', solicitationNumber: 'OTHER-1', solicitationKey: 'other-1' }).returning();
        const [row] = await db.insert(schema.documents).values({
          orgId: a.orgId, bidId: bid.id, fileName: 'x.pdf', mime: 'application/pdf', sizeBytes: 5,
          sha256: randomUUID(), kind, storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
        }).returning();
        return row;
      });
      return [
        (await liveDocument(a, other)).id,
        deleted.id,
        otherBid.id,
        (await liveDocument(b, kind)).id,
        'not-a-uuid',
        42,
      ];
    }

    it('links a resume to a candidate on create and patch, and records history', async () => {
      const resume = await liveDocument(a, 'resume', 'lee.pdf');
      const created = await asA('POST', rowsUrl('resumes'), { kind: 'candidate', name: 'Lee', role: 'PM', documentId: resume.id });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ documentId: resume.id });
      const bare = await asA('POST', rowsUrl('resumes'), { kind: 'candidate', name: 'Kim', role: 'PM' });
      expect(bare.json()).toMatchObject({ documentId: null });
      const url = rowUrl(a, 'candidates', bare.json<{ id: string }>().id);
      expect((await asA('PATCH', url, { fields: { documentId: resume.id } })).statusCode).toBe(200);
      expect((await asA('PATCH', url, { fields: { name: 'Kim R.' } })).statusCode).toBe(200);
      expect((await asA('GET', url)).json<{ row: { documentId: string | null } }>().row.documentId).toBe(resume.id);
      expect((await asA('PATCH', url, { fields: { documentId: null } })).statusCode).toBe(200);
      const detail = (await asA('GET', url)).json<{
        row: { documentId: string | null };
        history: { field: string; oldValue: string | null; newValue: string | null }[];
      }>();
      expect(detail.row.documentId).toBeNull();
      expect(detail.history.map((entry) => [entry.field, entry.oldValue, entry.newValue])).toEqual(expect.arrayContaining([
        ['documentId', null, resume.id],
        ['documentId', resume.id, null],
      ]));
    });

    it('refuses a candidate link that is not a live resume of this bid', async () => {
      const candidate = await asA('POST', rowsUrl('resumes'), { kind: 'candidate', name: 'Ray', role: 'PM' });
      const url = rowUrl(a, 'candidates', candidate.json<{ id: string }>().id);
      for (const documentId of await badLinks('resume')) {
        const create = await asA('POST', rowsUrl('resumes'), { kind: 'candidate', name: 'Ray', role: 'PM', documentId });
        expect(create.statusCode, `create ${documentId}`).toBe(400);
        expect(create.json<{ error: string }>().error).toBe('Choose a resume uploaded to this bid');
        expect((await asA('PATCH', url, { fields: { documentId } })).statusCode, `patch ${documentId}`).toBe(400);
      }
      expect((await asA('GET', url)).json<{ row: { documentId: string | null } }>().row.documentId).toBeNull();
    });

    it('links a draft to a review on create and patch, and records history', async () => {
      const draft = await liveDocument(a, 'draft', 'v2.docx');
      const created = await asA('POST', rowsUrl('reviews'), { type: 'red', draftDocumentId: draft.id });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ draftDocumentId: draft.id, draftFileName: 'v2.docx' });
      const bare = await asA('POST', rowsUrl('reviews'), { type: 'gold' });
      const url = rowUrl(a, 'reviews', bare.json<{ id: string }>().id);
      expect((await asA('PATCH', url, { fields: { draftDocumentId: draft.id } })).statusCode).toBe(200);
      expect((await asA('PATCH', url, { fields: { status: 'in_progress' } })).statusCode).toBe(200);
      expect((await asA('GET', url)).json<{ row: { draftFileName: string | null } }>().row.draftFileName).toBe('v2.docx');
      expect((await asA('PATCH', url, { fields: { draftDocumentId: null } })).statusCode).toBe(200);
      const detail = (await asA('GET', url)).json<{
        row: { draftDocumentId: string | null; status: string };
        history: { field: string; oldValue: string | null; newValue: string | null }[];
      }>();
      expect(detail.row).toMatchObject({ draftDocumentId: null, status: 'in_progress' });
      expect(detail.history.map((entry) => [entry.field, entry.oldValue, entry.newValue])).toEqual(expect.arrayContaining([
        ['draftDocumentId', null, draft.id],
        ['draftDocumentId', draft.id, null],
      ]));
    });

    it('refuses a review link that is not a live draft of this bid', async () => {
      const review = await asA('POST', rowsUrl('reviews'), { type: 'pink' });
      const url = rowUrl(a, 'reviews', review.json<{ id: string }>().id);
      for (const draftDocumentId of await badLinks('draft')) {
        const create = await asA('POST', rowsUrl('reviews'), { type: 'pink', draftDocumentId });
        expect(create.statusCode, `create ${draftDocumentId}`).toBe(400);
        expect(create.json<{ error: string }>().error).toBe('Choose a draft uploaded to this bid');
        expect((await asA('PATCH', url, { fields: { draftDocumentId } })).statusCode, `patch ${draftDocumentId}`).toBe(400);
      }
      expect((await asA('GET', url)).json<{ row: { draftDocumentId: string | null } }>().row.draftDocumentId).toBeNull();
    });
  });

  describe('reviews', () => {
    it('plans new reviews, names the draft, and validates status', async () => {
      const draft = await liveDocument(a, 'draft', 'red-team-draft.docx');
      const created = await asA('POST', `/api/bids/${a.bidId}/tabs/reviews/rows`, { type: 'pink' });
      expect(created.json<{ status: string; draftFileName: string | null }>()).toMatchObject({ status: 'planned', draftFileName: null });
      const id = created.json<{ id: string }>().id;
      await withOrg(a.orgId, (db) => db.update(schema.reviews).set({ draftDocumentId: draft.id }).where(eq(schema.reviews.id, id)));
      expect((await asA('PATCH', rowUrl(a, 'reviews', id), { fields: { status: 'closed' } })).statusCode).toBe(400);
      expect((await asA('PATCH', rowUrl(a, 'reviews', id), { fields: { status: 'done' } })).statusCode).toBe(200);
      // The legacy 'open' is 'planned'.
      expect((await asA('PATCH', rowUrl(a, 'reviews', id), { fields: { status: 'open' } })).statusCode).toBe(200);
      expect((await asA('GET', rowUrl(a, 'reviews', id))).json<{ row: { status: string } }>().row.status).toBe('planned');
      expect((await asA('PATCH', rowUrl(a, 'reviews', id), { fields: { status: 'in_progress' } })).statusCode).toBe(200);
      const tab = (await asA('GET', `/api/bids/${a.bidId}/tabs/reviews`)).json<{ reviews: { id: string; status: string; draftFileName: string | null }[] }>();
      expect(tab.reviews.find((review) => review.id === id)).toMatchObject({ status: 'in_progress', draftFileName: 'red-team-draft.docx' });
    });

    it('records and shows the author of a hand-added finding, and validates disposition', async () => {
      await getDb().update(schema.users).set({ name: 'Avery Writer' }).where(eq(schema.users.id, a.userId));
      const created = await asA('POST', `/api/bids/${a.bidId}/tabs/reviews/rows`, {
        kind: 'finding', reviewId: a.rows.reviews, text: 'Staffing is thin', findingKind: 'weakness',
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ author: 'Avery Writer', authorUserId: a.userId, disposition: 'open', origin: 'user' });
      const id = created.json<{ id: string }>().id;
      await withOrg(a.orgId, (db) => db.insert(schema.reviewFindings).values({
        orgId: a.orgId, reviewId: a.rows.reviews, kind: 'risk', text: 'AI risk', origin: 'ai',
      }));
      expect((await asA('PATCH', rowUrl(a, 'review_findings', id), { fields: { disposition: 'maybe' } })).statusCode).toBe(400);
      expect((await asA('PATCH', rowUrl(a, 'review_findings', id), { fields: { disposition: null } })).statusCode).toBe(400);
      // The legacy workspace sends 'reject' and 'accept'.
      expect((await asA('PATCH', rowUrl(a, 'review_findings', id), { fields: { disposition: 'reject' } })).statusCode).toBe(200);
      expect((await asA('GET', rowUrl(a, 'review_findings', id))).json<{ row: { disposition: string } }>().row.disposition).toBe('rejected');
      expect((await asA('PATCH', rowUrl(a, 'review_findings', id), { fields: { disposition: 'accept' } })).statusCode).toBe(200);
      const tab = (await asA('GET', `/api/bids/${a.bidId}/tabs/reviews`)).json<{ findings: { id: string; text: string; author: string | null; disposition: string }[] }>();
      expect(tab.findings.find((finding) => finding.id === id)).toMatchObject({ author: 'Avery Writer', disposition: 'accepted' });
      expect(tab.findings.find((finding) => finding.text === 'AI risk')).toMatchObject({ author: null, disposition: 'open' });
      // The seeded finding has no author.
      expect(tab.findings.find((finding) => finding.id === a.rows.review_findings)?.author).toBeNull();
    });
  });

  describe('production and orals', () => {
    it('seeds standard rows in contract categories', async () => {
      const bid = (await asA('POST', '/api/bids', { name: 'Seeded', bidType: 'sled' })).json<{ id: string }>().id;
      await asA('POST', `/api/bids/${bid}/tabs/production/seed`, {});
      await asA('POST', `/api/bids/${bid}/tabs/orals/seed`, {});
      const production = (await asA('GET', `/api/bids/${bid}/tabs/production`)).json<{ items: { category: string; origin: string }[] }>().items;
      expect(production.map((item) => item.category).sort()).toEqual(['copies', 'files', 'format', 'format', 'format', 'submission']);
      expect(production.every((item) => item.origin === 'standard')).toBe(true);
      const orals = (await asA('GET', `/api/bids/${bid}/tabs/orals`)).json<{ items: { category: string; origin: string }[] }>().items;
      expect(orals.map((item) => item.category).sort()).toEqual(['prep', 'rules', 'session']);
      expect(orals.every((item) => item.origin === 'standard')).toBe(true);
    });

    it('maps legacy category labels on insert and refuses unknown ones', async () => {
      const legacy = async (tab: 'production' | 'orals', category: string) => {
        const body = tab === 'production' ? { category, rule: `Rule ${category}` } : { category, item: `Item ${category}` };
        const response = await asA('POST', `/api/bids/${a.bidId}/tabs/${tab}/rows`, body);
        return response.statusCode === 201 ? response.json<{ category: string }>().category : response.statusCode;
      };
      expect(await legacy('production', 'Fonts')).toBe('format');
      expect(await legacy('production', 'Page limits')).toBe('format');
      expect(await legacy('production', 'File naming')).toBe('files');
      expect(await legacy('production', 'Portal')).toBe('submission');
      expect(await legacy('production', 'Copies')).toBe('copies');
      expect(await legacy('production', 'Binding')).toBe(400);
      // The legacy workspace's "Session topic" form sends 'Session'.
      expect(await legacy('orals', 'Session')).toBe('session');
      expect(await legacy('orals', 'Rules')).toBe('rules');
      expect(await legacy('orals', 'Checklist')).toBe('prep');
      expect(await legacy('orals', 'other')).toBe(400);
      const added = await asA('POST', `/api/bids/${a.bidId}/tabs/orals/rows`, { category: 'session', item: 'Demo', owner: 'Kim', minutes: 15 });
      expect(added.statusCode).toBe(201);
      expect(added.json()).toMatchObject({ category: 'session', owner: 'Kim', minutes: 15, origin: 'user' });
    });

    it('patches owner and minutes, refuses negative minutes, and records history', async () => {
      const production = rowUrl(a, 'production_items', a.rows.production_items);
      expect((await asA('PATCH', production, { fields: { owner: 'Dana' } })).statusCode).toBe(200);
      expect((await asA('GET', production)).json<{ row: { owner: string } }>().row.owner).toBe('Dana');
      const orals = rowUrl(a, 'orals_items', a.rows.orals_items);
      expect((await asA('PATCH', orals, { fields: { minutes: -1 } })).statusCode).toBe(400);
      expect((await asA('PATCH', orals, { fields: { minutes: 2.5 } })).statusCode).toBe(400);
      expect((await asA('PATCH', orals, { fields: { owner: 'Kim', minutes: 20 } })).statusCode).toBe(200);
      const detail = (await asA('GET', orals)).json<{ row: { owner: string; minutes: number }; history: { field: string }[] }>();
      expect(detail.row).toMatchObject({ owner: 'Kim', minutes: 20 });
      expect(detail.history.map((entry) => entry.field).sort()).toEqual(['minutes', 'owner']);
      expect((await asA('PATCH', orals, { fields: { minutes: null } })).statusCode).toBe(200);
      expect((await asA('GET', orals)).json<{ row: { minutes: number | null } }>().row.minutes).toBeNull();
    });
  });

  describe('row history names', () => {
    it('names the user who made each change, null for none, and stays in its organization', async () => {
      await getDb().update(schema.users).set({ name: null }).where(eq(schema.users.id, b.userId));
      await getDb().update(schema.users).set({ name: 'Morgan Lead' }).where(eq(schema.users.id, a.userId));
      const url = rowUrl(a, 'compliance_rows', a.compliance2);
      await asA('PATCH', url, { fields: { owner: 'Quinn' } });
      const history = (await asA('GET', url)).json<{ history: { userId: string | null; userName: string | null; orgId: string }[] }>().history;
      expect(history).toEqual([expect.objectContaining({ userId: a.userId, userName: 'Morgan Lead', orgId: a.orgId })]);
      // createTenant's history entry has no user: null name.
      const seeded = (await asA('GET', rowUrl(a, 'compliance_rows', a.rows.compliance_rows))).json<{ history: { userName: string | null }[] }>().history;
      expect(seeded.map((entry) => entry.userName)).toEqual([null]);
      // A user without a name shows their email.
      const urlB = rowUrl(b, 'compliance_rows', b.compliance2);
      await asB('PATCH', urlB, { fields: { owner: 'Sky' } });
      const historyB = (await asB('GET', urlB)).json<{ history: { userName: string | null; orgId: string }[] }>().history;
      expect(historyB).toEqual([expect.objectContaining({ userName: expect.stringMatching(/^tb-owner-.*@example\.com$/), orgId: b.orgId })]);
      expect((await asA('GET', urlB)).statusCode).toBe(404);
      expect(JSON.stringify(history)).not.toContain(b.orgId);
    });
  });
});

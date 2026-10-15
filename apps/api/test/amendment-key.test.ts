/**
 * The amendment solicitation-number check (04 s3.1 step 1, 06 s4) across the worker and the api,
 * against the real database: the worker's classify and amendment steps are imported from
 * apps/worker, @pd/ai's processAmendment is mocked, and both queues are spied.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { enqueueClassify } from '../src/queue.js';
import { as, createTenant, createUser, type Tenant } from './helpers.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
}));

const enqueued = vi.hoisted(() => [] as { name: string; documentId: string; jobId: string }[]);
vi.mock('../../worker/src/enqueue.js', () => ({
  enqueue: vi.fn(async (name: string, payload: { documentId: string; jobId: string }) => {
    enqueued.push({ name, documentId: payload.documentId, jobId: payload.jobId });
  }),
}));

const diff = vi.hoisted(() => ({ impl: null as null | (() => Promise<unknown>), calls: 0 }));
vi.mock('@pd/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pd/ai')>();
  return {
    ...original,
    getProvider: () => ({}),
    processAmendment: vi.fn(async () => {
      diff.calls += 1;
      return diff.impl!();
    }),
  };
});

const unavailable = inject('dbUnavailable');
const BID_NUMBER = 'W912-24-R-0001';
const BID_KEY = 'W91224R0001';

type Kind = 'amendment';
type Payload = { orgId: string; bidId: string; documentId: string; jobId: string; storagePath: string; kind: Kind };

describe.skipIf(Boolean(unavailable))('amendment solicitation key check', () => {
  let app: FastifyInstance;
  let worker: typeof import('../../worker/src/ai-jobs.js');
  let classify: typeof import('../../worker/src/classify-job.js');

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-amendkey-'));
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

  let current: Tenant | null = null;
  beforeEach(() => {
    enqueued.length = 0;
    diff.calls = 0;
    vi.mocked(enqueueClassify).mockClear();
    // One withdraw link against the tenant's first compliance row.
    diff.impl = async () => ({
      requirements: [],
      links: [{ oldRowId: current!.rows.compliance_rows, newRowId: null, action: 'withdraw', confidence: 0.95, status: 'auto' }],
      dateChanges: [],
    });
  });

  /** A tenant whose bid holds a credit and has the key W91224R0001 (or PENDING). */
  async function setup(label: string, options: { key?: string; credit?: 'reserved' | 'consumed' | 'released' } = {}) {
    const tenant = await createTenant(app, label);
    current = tenant;
    await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({
      creditStatus: options.credit ?? 'consumed',
      solicitationNumber: options.key === 'PENDING' ? 'PENDING' : BID_NUMBER,
      solicitationKey: options.key ?? BID_KEY,
    }).where(eq(schema.bids.id, tenant.bidId)));
    return tenant;
  }

  async function amendmentDoc(tenant: Tenant, text: string, ocrUsed = false): Promise<string> {
    return withOrg(tenant.orgId, async (db) => {
      const [document] = await db.insert(schema.documents).values({
        orgId: tenant.orgId, bidId: tenant.bidId, fileName: 'amendment.pdf', mime: 'application/pdf', sizeBytes: 5,
        sha256: randomUUID(), kind: 'amendment', storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
      }).returning();
      await db.insert(schema.pages).values({ orgId: tenant.orgId, documentId: document.id, pageNo: 1, text, ocrUsed });
      return document.id;
    });
  }

  const payload = (tenant: Tenant, documentId: string, jobId: string = randomUUID()): Payload => ({
    orgId: tenant.orgId, bidId: tenant.bidId, documentId, jobId, storagePath: '', kind: 'amendment',
  });

  const amendmentRows = (tenant: Tenant, documentId: string) => withOrg(tenant.orgId, (db) => db.select().from(schema.amendments)
    .where(eq(schema.amendments.documentId, documentId)));
  const documentRow = async (tenant: Tenant, documentId: string) => {
    const [row] = await withOrg(tenant.orgId, (db) => db.select().from(schema.documents).where(eq(schema.documents.id, documentId)));
    return row;
  };
  const bidRow = async (tenant: Tenant) => {
    const [row] = await withOrg(tenant.orgId, (db) => db.select().from(schema.bids).where(eq(schema.bids.id, tenant.bidId)));
    return row;
  };
  const linksOf = async (tenant: Tenant, documentId: string) => {
    const ids = (await amendmentRows(tenant, documentId)).map((row) => row.id);
    return ids.length === 0 ? [] : withOrg(tenant.orgId, (db) => db.select().from(schema.amendmentLinks)
      .where(inArray(schema.amendmentLinks.amendmentId, ids)));
  };
  async function dto(tenant: Tenant, documentId: string) {
    const response = await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/documents`);
    expect(response.statusCode).toBe(200);
    const doc = response.json<{ id: string; keyCheck: string; keyReason: string | null; keyFound: string | null }[]>()
      .find((row) => row.id === documentId)!;
    return { keyCheck: doc.keyCheck, keyReason: doc.keyReason, keyFound: doc.keyFound };
  }
  const queuedFor = (documentId: string) => enqueued.filter((item) => item.name === 'ai:amendment' && item.documentId === documentId);

  /** A held amendment (key check run, nothing found). */
  async function heldAmendment(tenant: Tenant): Promise<string> {
    const documentId = await amendmentDoc(tenant, 'ADDENDUM\nThe site visit moves to Friday.');
    await classify.processClassify(payload(tenant, documentId));
    expect((await amendmentRows(tenant, documentId))[0].status).toBe('held');
    return documentId;
  }

  async function memberCall(tenant: Tenant) {
    const member = await createUser('amend-member');
    await withOrg(tenant.orgId, (db) => db.insert(schema.memberships).values({ orgId: tenant.orgId, userId: member.userId, role: 'member' }));
    return as(app, member.token);
  }

  it('a match proceeds: found, processing, ai:amendment queued, DTO ok; the diff applies once', async () => {
    const tenant = await setup('ak-match');
    const documentId = await amendmentDoc(tenant, 'AMENDMENT 1\nThis amends W912 24R 0001 as follows.');
    await classify.processClassify(payload(tenant, documentId));
    const [row] = await amendmentRows(tenant, documentId);
    expect(row).toMatchObject({ solicitationKeyFound: true, status: 'processing', matchedKey: BID_KEY, keyOverride: false });
    expect(queuedFor(documentId)).toHaveLength(1);
    expect(await documentRow(tenant, documentId)).toMatchObject({ keyStatus: 'match', keyFound: 'W912 24R 0001', liveStatus: 'live' });
    expect(await dto(tenant, documentId)).toEqual({ keyCheck: 'ok', keyReason: null, keyFound: 'W912 24R 0001' });

    await worker.processAmendmentJob(payload(tenant, documentId));
    expect((await amendmentRows(tenant, documentId))[0].status).toBe('applied');
    expect(await linksOf(tenant, documentId)).toHaveLength(1);
    // A second run (a retried job) finds the row past processing: no AI call, no second link set.
    await worker.processAmendmentJob(payload(tenant, documentId));
    expect(diff.calls).toBe(1);
    expect(await linksOf(tenant, documentId)).toHaveLength(1);
    // Classify run again: still one row, never re-diffed, nothing queued.
    enqueued.length = 0;
    await classify.processClassify(payload(tenant, documentId));
    const rows = await amendmentRows(tenant, documentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('applied');
    expect(queuedFor(documentId)).toHaveLength(0);
  });

  it('classify twice before the diff gives one amendments row and one link set', async () => {
    const tenant = await setup('ak-twice');
    const documentId = await amendmentDoc(tenant, `Solicitation No. ${BID_NUMBER}`);
    await classify.processClassify(payload(tenant, documentId));
    await classify.processClassify(payload(tenant, documentId));
    expect(await amendmentRows(tenant, documentId)).toHaveLength(1);
    await worker.processAmendmentJob(payload(tenant, documentId));
    await worker.processAmendmentJob(payload(tenant, documentId));
    expect(await linksOf(tenant, documentId)).toHaveLength(1);
  });

  for (const [name, text, keyReason, keyFound] of [
    ['mismatch', 'Amendment of Solicitation No. W912-24-R-0002\nRFP 55-66', 'mismatch', 'W912-24-R-0002'],
    ['not found', 'ADDENDUM 3\nQuestions and answers attached.', 'not_found', null],
  ] as const) {
    it(`a ${name} is held: nothing queued, DTO mismatch with the reason, and the diff step writes nothing`, async () => {
      const tenant = await setup(`ak-${keyReason}`);
      const documentId = await amendmentDoc(tenant, text);
      await classify.processClassify(payload(tenant, documentId));
      const [row] = await amendmentRows(tenant, documentId);
      expect(row).toMatchObject({ solicitationKeyFound: false, status: 'held', matchedKey: BID_KEY });
      expect(queuedFor(documentId)).toHaveLength(0);
      expect(await documentRow(tenant, documentId)).toMatchObject({ keyStatus: keyReason, keyFound, liveStatus: 'live' });
      expect(await dto(tenant, documentId)).toEqual({ keyCheck: 'mismatch', keyReason, keyFound });
      await worker.processAmendmentJob(payload(tenant, documentId));
      expect(diff.calls).toBe(0);
      expect(await linksOf(tenant, documentId)).toHaveLength(0);
      expect((await amendmentRows(tenant, documentId))[0].status).toBe('held');
    });
  }

  it('OCR confusions match only on OCR pages', async () => {
    const tenant = await setup('ak-ocr');
    const scanned = await amendmentDoc(tenant, 'Solicitation No. W9I2-24-R-OOO1', true);
    const typed = await amendmentDoc(tenant, 'Solicitation No. W9I2-24-R-OOO1', false);
    await classify.processClassify(payload(tenant, scanned));
    await classify.processClassify(payload(tenant, typed));
    expect((await documentRow(tenant, scanned)).keyStatus).toBe('match');
    expect((await documentRow(tenant, typed)).keyStatus).toBe('mismatch');
  });

  it('a PENDING bid key holds the amendment; setting the key rechecks it, and it matches', async () => {
    const tenant = await setup('ak-pending', { key: 'PENDING' });
    const documentId = await amendmentDoc(tenant, `Amendment of Solicitation No. ${BID_NUMBER}`);
    await classify.processClassify(payload(tenant, documentId));
    expect((await amendmentRows(tenant, documentId))[0]).toMatchObject({ status: 'held', solicitationKeyFound: false });
    expect(await dto(tenant, documentId)).toEqual({ keyCheck: 'mismatch', keyReason: 'bid_key_pending', keyFound: BID_NUMBER });
    expect(queuedFor(documentId)).toHaveLength(0);

    const patched = await as(app, tenant.token)('PATCH', `/api/bids/${tenant.bidId}`, { solicitationNumber: BID_NUMBER });
    expect(patched.statusCode, patched.body).toBe(200);
    const calls = vi.mocked(enqueueClassify).mock.calls.map(([job]) => job);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ documentId, kind: 'amendment' });
    const [job] = await withOrg(tenant.orgId, (db) => db.select().from(schema.jobs).where(eq(schema.jobs.id, calls[0].jobId)));
    expect(job).toMatchObject({ type: 'classify', status: 'pending', documentId });
    const audits = await withOrg(tenant.orgId, (db) => db.select().from(schema.auditLog).where(and(
      eq(schema.auditLog.action, 'set_solicitation_key'),
      eq(schema.auditLog.targetId, tenant.bidId),
    )));
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toMatchObject({ previousKey: 'PENDING', solicitationKey: BID_KEY, rechecked: 1 });

    await classify.processClassify(payload(tenant, documentId, calls[0].jobId));
    expect((await amendmentRows(tenant, documentId))[0]).toMatchObject({ status: 'processing', solicitationKeyFound: true, matchedKey: BID_KEY });
    expect(queuedFor(documentId)).toHaveLength(1);
    expect(await dto(tenant, documentId)).toEqual({ keyCheck: 'ok', keyReason: null, keyFound: BID_NUMBER });
    const [closed] = await withOrg(tenant.orgId, (db) => db.select().from(schema.jobs).where(eq(schema.jobs.id, calls[0].jobId)));
    expect(closed.status).toBe('completed');
    // A later key change that is not off PENDING queues nothing.
    vi.mocked(enqueueClassify).mockClear();
    expect((await as(app, tenant.token)('PATCH', `/api/bids/${tenant.bidId}`, { name: 'Renamed' })).statusCode).toBe(200);
    expect(enqueueClassify).not.toHaveBeenCalled();
  });

  it('an override spends one, audits it, queues classify, and the rerun applies the amendment', async () => {
    const tenant = await setup('ak-override');
    const documentId = await heldAmendment(tenant);
    const response = await as(app, tenant.token)('POST', `/api/documents/${documentId}/key-override`, { reason: '  SLED addendum omits the number  ' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ remaining: number }>().remaining).toBe(1);
    expect((await bidRow(tenant)).keyOverridesUsed).toBe(1);
    const [row] = await amendmentRows(tenant, documentId);
    expect(row).toMatchObject({ keyOverride: true, overrideReason: 'SLED addendum omits the number', status: 'processing' });
    expect(await dto(tenant, documentId)).toEqual({ keyCheck: 'overridden', keyReason: null, keyFound: null });
    const [audit] = await withOrg(tenant.orgId, (db) => db.select().from(schema.auditLog).where(and(
      eq(schema.auditLog.action, 'key_override'),
      eq(schema.auditLog.targetId, documentId),
    )));
    expect(audit.detail).toEqual({
      reason: 'SLED addendum omits the number', amendmentId: row.id, keyStatusBefore: 'not_found', foundNumber: null, bidKey: BID_KEY,
    });
    const calls = vi.mocked(enqueueClassify).mock.calls.map(([job]) => job);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ documentId, kind: 'amendment' });
    const [job] = await withOrg(tenant.orgId, (db) => db.select().from(schema.jobs).where(eq(schema.jobs.id, calls[0].jobId)));
    expect(job).toMatchObject({ type: 'classify', status: 'pending' });

    // The classify rerun sees the override; running it twice never clears it.
    await classify.processClassify(payload(tenant, documentId, calls[0].jobId));
    await classify.processClassify(payload(tenant, documentId));
    expect((await amendmentRows(tenant, documentId))[0]).toMatchObject({ keyOverride: true, status: 'processing' });
    expect(queuedFor(documentId).length).toBeGreaterThanOrEqual(1);
    expect((await withOrg(tenant.orgId, (db) => db.select().from(schema.jobs).where(eq(schema.jobs.id, calls[0].jobId))))[0].status).toBe('completed');
    await worker.processAmendmentJob(payload(tenant, documentId, calls[0].jobId));
    expect((await amendmentRows(tenant, documentId))[0].status).toBe('applied');
    expect(await linksOf(tenant, documentId)).toHaveLength(1);
    // Applied: a second override is not needed, and nothing more is spent.
    const again = await as(app, tenant.token)('POST', `/api/documents/${documentId}/key-override`, { reason: 'again' });
    expect(again.json<{ code: string }>().code).toBe('override_not_needed');
    expect((await bidRow(tenant)).keyOverridesUsed).toBe(1);
  });

  it('refuses an override at the limit, from a member, on a deleted file, on a released credit, and without a reason; none is spent', async () => {
    const tenant = await setup('ak-refuse');
    const call = as(app, tenant.token);
    const documentId = await heldAmendment(tenant);

    expect((await call('POST', `/api/documents/${documentId}/key-override`, { reason: '   ' })).statusCode).toBe(400);
    expect((await call('POST', `/api/documents/${documentId}/key-override`, { reason: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await (await memberCall(tenant))('POST', `/api/documents/${documentId}/key-override`, { reason: 'x' })).statusCode).toBe(403);

    await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ keyOverridesUsed: 2 }).where(eq(schema.bids.id, tenant.bidId)));
    const limited = await call('POST', `/api/documents/${documentId}/key-override`, { reason: 'x' });
    expect(limited.statusCode).toBe(409);
    expect(limited.json<{ code: string }>().code).toBe('override_limit');
    expect((await bidRow(tenant)).keyOverridesUsed).toBe(2);
    await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ keyOverridesUsed: 0 }).where(eq(schema.bids.id, tenant.bidId)));

    await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'released' }).where(eq(schema.bids.id, tenant.bidId)));
    const released = await call('POST', `/api/documents/${documentId}/key-override`, { reason: 'x' });
    expect(released.statusCode).toBe(409);
    expect(released.json<{ code: string }>().code).toBe('solicitation_first');
    await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'consumed' }).where(eq(schema.bids.id, tenant.bidId)));

    expect((await call('DELETE', `/api/documents/${documentId}`)).statusCode).toBe(200);
    const deleted = await call('POST', `/api/documents/${documentId}/key-override`, { reason: 'x' });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json<{ code: string }>().code).toBe('document_deleted');

    expect((await bidRow(tenant)).keyOverridesUsed).toBe(0);
    expect((await amendmentRows(tenant, documentId))[0]).toMatchObject({ keyOverride: false, status: 'held' });
    expect(enqueueClassify).not.toHaveBeenCalled();
  });

  it('a deleted amendment or a bid without a credit is not checked', async () => {
    const tenant = await setup('ak-skip', { credit: 'released' });
    const documentId = await amendmentDoc(tenant, `Solicitation No. ${BID_NUMBER}`);
    await classify.processClassify(payload(tenant, documentId));
    expect(await amendmentRows(tenant, documentId)).toHaveLength(0);
    await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'consumed' }).where(eq(schema.bids.id, tenant.bidId)));
    await withOrg(tenant.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' }).where(eq(schema.documents.id, documentId)));
    await classify.processClassify(payload(tenant, documentId));
    expect(await amendmentRows(tenant, documentId)).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('never shows another organization the number found', async () => {
    const a = await setup('ak-xt-a');
    const b = await setup('ak-xt-b');
    const documentId = await amendmentDoc(a, 'Solicitation No. ZZ-99-SECRET-1234');
    await classify.processClassify(payload(a, documentId));
    expect((await dto(a, documentId)).keyFound).toBe('ZZ-99-SECRET-1234');
    const asB = as(app, b.token);
    expect((await asB('GET', `/api/bids/${a.bidId}/documents`)).statusCode).toBe(404);
    const own = await asB('GET', `/api/bids/${b.bidId}/documents`);
    expect(own.body).not.toContain('ZZ-99-SECRET-1234');
    expect((await asB('POST', `/api/documents/${documentId}/key-override`, { reason: 'x' })).statusCode).toBe(404);
    // A worker job carrying B's organization cannot see A's document.
    await classify.processClassify({ ...payload(b, documentId) });
    expect((await documentRow(a, documentId)).keyFound).toBe('ZZ-99-SECRET-1234');
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

  type Reply = { statusCode: number; body: string; json: <T>() => T };
  const fulfilled = <T>(result: PromiseSettledResult<T>): T => {
    if (result.status === 'rejected') {
      throw result.reason;
    }
    return result.value;
  };

  it('an override and a document delete that collide: refused with nothing spent, or accepted and then deleted', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tenant = await setup(`ak-race-del-${round}`);
      const documentId = await heldAmendment(tenant);
      const call = as(app, tenant.token);
      const { waiting, results } = await race(tenant.orgId, 'select id from documents where id = $1 for update', [documentId], 2, () => [
        call('POST', `/api/documents/${documentId}/key-override`, { reason: 'race' }),
        call('DELETE', `/api/documents/${documentId}`),
      ]);
      expect(waiting).toBe(2);
      const override = fulfilled(results[0]) as Reply;
      expect(fulfilled(results[1]).statusCode).toBe(200);
      const used = (await bidRow(tenant)).keyOverridesUsed;
      if (override.statusCode === 409) {
        expect(override.json<{ code: string }>().code).toBe('document_deleted');
        expect(used).toBe(0);
      } else {
        expect(override.statusCode, override.body).toBe(200);
        expect(used).toBe(1);
      }
      await worker.processAmendmentJob(payload(tenant, documentId));
      expect(await linksOf(tenant, documentId)).toHaveLength(0);
      expect(diff.calls).toBe(0);
    }
  });

  it('the key check and a document delete that collide: nothing is queued when the delete wins', async () => {
    for (let round = 0; round < 3; round += 1) {
      enqueued.length = 0;
      const tenant = await setup(`ak-race-check-${round}`);
      const documentId = await amendmentDoc(tenant, `Solicitation No. ${BID_NUMBER}`);
      const { waiting, results } = await race(tenant.orgId, 'select id from documents where id = $1 for update', [documentId], 2, () => [
        classify.processClassify(payload(tenant, documentId)),
        as(app, tenant.token)('DELETE', `/api/documents/${documentId}`),
      ]);
      expect(waiting).toBe(2);
      fulfilled(results[0]);
      expect(fulfilled(results[1]).statusCode).toBe(200);
      const rows = await amendmentRows(tenant, documentId);
      // Either the check committed first (a processing row, one job queued) or the delete did
      // (no row, nothing queued).
      expect(queuedFor(documentId)).toHaveLength(rows.length);
      await worker.processAmendmentJob(payload(tenant, documentId));
      expect(await linksOf(tenant, documentId)).toHaveLength(0);
    }
  });

  it('a delete that lands while the diff runs wins: no links, no row changes', async () => {
    const tenant = await setup('ak-diff-delete');
    const documentId = await amendmentDoc(tenant, `Solicitation No. ${BID_NUMBER}`);
    await classify.processClassify(payload(tenant, documentId));
    const inner = diff.impl!;
    diff.impl = async () => {
      expect((await as(app, tenant.token)('DELETE', `/api/documents/${documentId}`)).statusCode).toBe(200);
      return inner();
    };
    await worker.processAmendmentJob(payload(tenant, documentId));
    expect(await linksOf(tenant, documentId)).toHaveLength(0);
    expect((await amendmentRows(tenant, documentId))[0].status).toBe('processing');
    const [compliance] = await withOrg(tenant.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.id, tenant.rows.compliance_rows)));
    expect(compliance.supersedeStatus).not.toBe('withdrawn');
  });

  it('the diff write and a document delete that collide never deadlock and stay consistent', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tenant = await setup(`ak-race-diff-${round}`);
      const documentId = await amendmentDoc(tenant, `Solicitation No. ${BID_NUMBER}`);
      await classify.processClassify(payload(tenant, documentId));
      const { waiting, results } = await race(tenant.orgId, 'select id from documents where id = $1 for update', [documentId], 2, () => [
        worker.processAmendmentJob(payload(tenant, documentId)),
        as(app, tenant.token)('DELETE', `/api/documents/${documentId}`),
      ]);
      expect(waiting).toBe(2);
      fulfilled(results[0]);
      expect(fulfilled(results[1]).statusCode).toBe(200);
      const [row] = await amendmentRows(tenant, documentId);
      const links = await linksOf(tenant, documentId);
      // The diff committed first (applied, one link) or the delete did (processing, none).
      expect(row.status === 'applied' ? 1 : 0).toBe(links.length);
      expect(['applied', 'processing']).toContain(row.status);
    }
  });

  it('an override and a key-check rerun that collide keep the override and end processing', async () => {
    for (let round = 0; round < 3; round += 1) {
      enqueued.length = 0;
      const tenant = await setup(`ak-race-rerun-${round}`);
      const documentId = await heldAmendment(tenant);
      const [held] = await amendmentRows(tenant, documentId);
      const { waiting, results } = await race(tenant.orgId, 'select id from amendments where id = $1 for update', [held.id], 2, () => [
        as(app, tenant.token)('POST', `/api/documents/${documentId}/key-override`, { reason: 'race' }),
        classify.processClassify(payload(tenant, documentId)),
      ]);
      expect(waiting).toBe(2);
      expect(fulfilled(results[0]).statusCode).toBe(200);
      fulfilled(results[1]);
      const [row] = await amendmentRows(tenant, documentId);
      expect(row).toMatchObject({ keyOverride: true, status: 'processing' });
      expect((await bidRow(tenant)).keyOverridesUsed).toBe(1);
    }
  });

  it('an override and a diff write on the same bid that collide do not deadlock', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tenant = await setup(`ak-race-bid-${round}`);
      const matched = await amendmentDoc(tenant, `Solicitation No. ${BID_NUMBER}`);
      await classify.processClassify(payload(tenant, matched));
      const held = await heldAmendment(tenant);
      const { waiting, results } = await race(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId], 2, () => [
        as(app, tenant.token)('POST', `/api/documents/${held}/key-override`, { reason: 'race' }),
        worker.processAmendmentJob(payload(tenant, matched)),
      ]);
      expect(waiting).toBe(2);
      expect(fulfilled(results[0]).statusCode).toBe(200);
      fulfilled(results[1]);
      expect((await amendmentRows(tenant, matched))[0].status).toBe('applied');
      expect((await amendmentRows(tenant, held))[0]).toMatchObject({ keyOverride: true, status: 'processing' });
    }
  });

  it('an override or a key check and an upload start on the same bid that collide do not deadlock', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tenant = await setup(`ak-race-upload-${round}`);
      const held = await heldAmendment(tenant);
      const fresh = await amendmentDoc(tenant, `Solicitation No. ${BID_NUMBER}`);
      const call = as(app, tenant.token);
      const start = () => call('POST', `/api/bids/${tenant.bidId}/uploads`, {
        fileName: 'amd.pdf', kind: 'amendment', declaredSize: 10, sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'), chunkCount: 1,
      });
      // The upload start holds the organization row, then waits on the bid; the override and the
      // key check share the organization row before they wait on the bid.
      for (const contender of [
        () => call('POST', `/api/documents/${held}/key-override`, { reason: 'race' }),
        () => classify.processClassify(payload(tenant, fresh)).then(() => ({ statusCode: 200, body: '' })),
      ]) {
        const { waiting, results } = await race(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId], 2, () => [
          contender(),
          start(),
        ]);
        expect(waiting).toBe(2);
        const [first, uploaded] = results.map((result) => fulfilled(result) as Reply);
        expect(first.statusCode, first.body).toBe(200);
        expect(uploaded.statusCode, uploaded.body).toBe(201);
      }
      expect((await amendmentRows(tenant, held))[0]).toMatchObject({ keyOverride: true, status: 'processing' });
      expect((await amendmentRows(tenant, fresh))[0]).toMatchObject({ solicitationKeyFound: true, status: 'processing' });
    }
  });

  it('two overrides of different amendments at one below the limit: exactly one passes', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tenant = await setup(`ak-race-limit-${round}`);
      const first = await heldAmendment(tenant);
      const second = await heldAmendment(tenant);
      await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ keyOverridesUsed: 1 }).where(eq(schema.bids.id, tenant.bidId)));
      const call = as(app, tenant.token);
      const { waiting, results } = await race(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId], 2, () => [
        call('POST', `/api/documents/${first}/key-override`, { reason: 'race' }),
        call('POST', `/api/documents/${second}/key-override`, { reason: 'race' }),
      ]);
      expect(waiting).toBe(2);
      const codes = results.map((result) => fulfilled(result).statusCode).sort();
      expect(codes).toEqual([200, 409]);
      expect((await bidRow(tenant)).keyOverridesUsed).toBe(2);
      const accepted = [...await amendmentRows(tenant, first), ...await amendmentRows(tenant, second)].filter((row) => row.keyOverride);
      expect(accepted).toHaveLength(1);
    }
  });
});

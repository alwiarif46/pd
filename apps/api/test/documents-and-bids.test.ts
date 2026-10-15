/**
 * Documents and bids after migration 0005 (09 s5.2, s5.11, s5.19): document status and
 * restore, the restore gate, key check, marking page, the override limit setting, bid status,
 * and the bid's live-until dates. Cross-tenant cases at the end.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getDb, getPool, schema, withOrg } from '@pd/core';
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

const unavailable = inject('dbUnavailable');

const DAY = 24 * 60 * 60 * 1000;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const plusDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY).toISOString();

type Kind = 'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft';
type LiveStatus = 'live' | 'archived' | 'restore_requested' | 'restoring' | 'restored' | 'deleted';

interface DocumentJson {
  id: string;
  liveStatus: LiveStatus | null;
  liveUntil: string | null;
  restoredUntil: string | null;
  markingPage: number | null;
  markingStatus: string | null;
  keyCheck: 'not_applicable' | 'ok' | 'mismatch' | 'overridden';
  keyReason: 'mismatch' | 'not_found' | 'bid_key_pending' | null;
  keyFound: string | null;
}

interface BidJson {
  id: string;
  status: string;
  defaultLiveUntil: string | null;
  filesLiveUntil: string | null;
  keyOverridesLeft: number;
  keyOverridesUsed: number;
}

describe.skipIf(Boolean(unavailable))('documents and bids (0005)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-docbids-'));
    getPool({ connectionString: inject('appUrl'), max: 6 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const SETTING_KEYS = ['restore_free_allowed', 'restore_window_days', 'key_overrides_per_bid'];

  /** app_settings is global; every test that sets one is undone here. */
  afterEach(async () => {
    await getDb().delete(schema.appSettings).where(inArray(schema.appSettings.key, SETTING_KEYS));
  });

  async function setSetting(key: string, value: string) {
    await getDb().insert(schema.appSettings).values({ key, value })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } });
  }

  async function setPlan(orgId: string, plan: 'free' | 'starter' | 'growth') {
    await withOrg(orgId, (db) => db.update(schema.organizations).set({ plan }).where(eq(schema.organizations.id, orgId)));
  }

  async function addDocument(tenant: Tenant, values: {
    kind?: Kind;
    liveStatus?: LiveStatus;
    createdAt?: Date;
    name?: string;
  } = {}): Promise<string> {
    return withOrg(tenant.orgId, async (db) => {
      const [row] = await db.insert(schema.documents).values({
        orgId: tenant.orgId,
        bidId: tenant.bidId,
        fileName: values.name ?? `${values.kind ?? 'attachment'}.pdf`,
        mime: 'application/pdf',
        sizeBytes: 10,
        sha256: `sha-${Math.random()}`,
        kind: values.kind ?? 'attachment',
        storagePath: values.liveStatus === 'live' || values.liveStatus === undefined ? 'docs/x.pdf' : null,
        liveStatus: values.liveStatus ?? 'live',
        ...(values.createdAt ? { createdAt: values.createdAt } : {}),
      }).returning({ id: schema.documents.id });
      return row.id;
    });
  }

  async function addArchive(tenant: Tenant, documentId: string, values: {
    restoreStatus?: 'none' | 'requested' | 'restoring' | 'restored';
    restoredUntil?: Date | null;
    purgedAt?: Date | null;
    objectType?: 'original' | 'viewer';
  } = {}): Promise<string> {
    return withOrg(tenant.orgId, async (db) => {
      const [row] = await db.insert(schema.archiveObjects).values({
        orgId: tenant.orgId,
        documentId,
        objectType: values.objectType ?? 'original',
        archiveKey: `archive/${documentId}/${Math.random()}`,
        archivedAt: new Date(),
        restoreStatus: values.restoreStatus ?? 'none',
        restoredUntil: values.restoredUntil ?? null,
        purgedAt: values.purgedAt ?? null,
      }).returning({ id: schema.archiveObjects.id });
      return row.id;
    });
  }

  async function addAmendment(tenant: Tenant, documentId: string, found: boolean, override = false) {
    await withOrg(tenant.orgId, (db) => db.insert(schema.amendments).values({
      orgId: tenant.orgId,
      bidId: tenant.bidId,
      documentId,
      amendmentNo: 1,
      solicitationKeyFound: found,
      keyOverride: override,
      overrideReason: override ? 'seeded' : null,
      // Rows seeded without documents.key_status, as before migration 0008: the key check held
      // a row whose number was not found; the others went on.
      status: found ? 'needs_confirmation' : override ? 'processing' : 'held',
    }));
  }

  /** Amendments run only while the bid's solicitation holds a credit (06 s4). */
  async function consumeCredit(tenant: Tenant) {
    await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'consumed' }).where(eq(schema.bids.id, tenant.bidId)));
  }

  async function listDocuments(tenant: Tenant): Promise<DocumentJson[]> {
    const response = await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/documents`);
    expect(response.statusCode).toBe(200);
    return response.json<DocumentJson[]>();
  }

  const byId = (docs: DocumentJson[], id: string) => docs.find((doc) => doc.id === id)!;

  async function getBid(tenant: Tenant): Promise<BidJson> {
    const response = await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}`);
    expect(response.statusCode).toBe(200);
    return response.json<BidJson>();
  }

  async function auditRows(tenant: Tenant, documentId: string) {
    return withOrg(tenant.orgId, (db) => db.select().from(schema.auditLog).where(and(
      eq(schema.auditLog.targetId, documentId),
      eq(schema.auditLog.action, 'restore_request'),
    )));
  }

  describe('document status', () => {
    it('passes restore_requested through and gives restoredUntil from restored, unpurged copies', async () => {
      const tenant = await createTenant(app, 'doc-status');
      const requested = await addDocument(tenant, { liveStatus: 'restore_requested' });
      await addArchive(tenant, requested, { restoreStatus: 'requested' });
      const restored = await addDocument(tenant, { liveStatus: 'restored' });
      await addArchive(tenant, restored, { restoreStatus: 'restored', restoredUntil: day('2026-11-01') });
      await addArchive(tenant, restored, { restoreStatus: 'restored', restoredUntil: day('2026-11-03'), objectType: 'viewer' });
      // A purged copy with a later date does not count.
      await addArchive(tenant, restored, { restoreStatus: 'restored', restoredUntil: day('2026-12-01'), purgedAt: new Date() });
      const restoring = await addDocument(tenant, { liveStatus: 'restoring' });
      await addArchive(tenant, restoring, { restoreStatus: 'restoring' });

      const docs = await listDocuments(tenant);
      expect(byId(docs, requested)).toMatchObject({ liveStatus: 'restore_requested', restoredUntil: null });
      expect(byId(docs, restored)).toMatchObject({ liveStatus: 'restored', restoredUntil: '2026-11-03T00:00:00.000Z' });
      expect(byId(docs, restoring)).toMatchObject({ liveStatus: 'restoring', restoredUntil: null });
      expect(byId(docs, tenant.documentId)).toMatchObject({ liveStatus: 'archived', restoredUntil: null });
    });

    it('computes liveUntil by the 03 s39 rule, and null for a deleted file', async () => {
      const tenant = await createTenant(app, 'doc-live');
      const uploaded = day('2026-01-01');
      const solicitation = await addDocument(tenant, { kind: 'solicitation', createdAt: uploaded });
      const resume = await addDocument(tenant, { kind: 'resume', createdAt: uploaded });
      const deleted = await addDocument(tenant, { kind: 'attachment', liveStatus: 'deleted', createdAt: uploaded });
      const call = as(app, tenant.token);
      expect((await call('PATCH', `/api/bids/${tenant.bidId}`, { dueDate: '2026-06-01T00:00:00.000Z' })).statusCode).toBe(200);

      let docs = await listDocuments(tenant);
      // Free: upload + 90, the due date does not count.
      expect(byId(docs, solicitation).liveUntil).toBe(plusDays(uploaded, 90));
      expect(byId(docs, deleted).liveUntil).toBeNull();

      await setPlan(tenant.orgId, 'starter');
      docs = await listDocuments(tenant);
      expect(byId(docs, solicitation).liveUntil).toBe(plusDays(day('2026-06-01'), 90));
      expect(byId(docs, resume).liveUntil).toBe(plusDays(uploaded, 90));

      const extension = new Date(Date.now() + 400 * DAY);
      expect((await call('PATCH', `/api/bids/${tenant.bidId}`, { retentionExtendedUntil: extension.toISOString() })).statusCode).toBe(200);
      docs = await listDocuments(tenant);
      expect(byId(docs, solicitation).liveUntil).toBe(extension.toISOString());
      expect(byId(docs, resume).liveUntil).toBe(plusDays(uploaded, 90));
    });
  });

  describe('POST /api/documents/:id/restore', () => {
    it('moves archived to restore_requested, marks the archive copies, and audits once', async () => {
      const tenant = await createTenant(app, 'restore');
      const documentId = await addDocument(tenant, { liveStatus: 'archived' });
      const original = await addArchive(tenant, documentId);
      const viewer = await addArchive(tenant, documentId, { objectType: 'viewer' });
      const purged = await addArchive(tenant, documentId, { purgedAt: new Date() });
      const call = as(app, tenant.token);

      const response = await call('POST', `/api/documents/${documentId}/restore`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'restore_requested' });

      const docs = await listDocuments(tenant);
      expect(byId(docs, documentId).liveStatus).toBe('restore_requested');
      const archives = await withOrg(tenant.orgId, (db) => db.select().from(schema.archiveObjects)
        .where(eq(schema.archiveObjects.documentId, documentId)));
      for (const id of [original, viewer]) {
        const row = archives.find((archive) => archive.id === id)!;
        expect(row.restoreStatus).toBe('requested');
        expect(row.restoreRequestedAt).not.toBeNull();
      }
      expect(archives.find((archive) => archive.id === purged)!.restoreStatus).toBe('none');
      const audit = await auditRows(tenant, documentId);
      expect(audit).toHaveLength(1);
      expect(audit[0].userId).toBe(tenant.userId);
    });

    it('a second request while pending returns the current state and changes nothing', async () => {
      const tenant = await createTenant(app, 'restore-twice');
      const documentId = await addDocument(tenant, { liveStatus: 'archived' });
      await addArchive(tenant, documentId);
      const call = as(app, tenant.token);
      expect((await call('POST', `/api/documents/${documentId}/restore`)).json()).toEqual({ status: 'restore_requested' });
      const again = await call('POST', `/api/documents/${documentId}/restore`);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ status: 'restore_requested' });
      expect(await auditRows(tenant, documentId)).toHaveLength(1);

      // Once the worker has it, the answer follows the document.
      await withOrg(tenant.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'restoring' })
        .where(eq(schema.documents.id, documentId)));
      expect((await call('POST', `/api/documents/${documentId}/restore`)).json()).toEqual({ status: 'restoring' });
      expect(await auditRows(tenant, documentId)).toHaveLength(1);
    });

    /**
     * Holds the document row FOR UPDATE from a separate (superuser) connection, so requests that
     * reach the conditional UPDATE queue behind it. `waitForLockWaiters` polls pg_stat_activity.
     */
    async function holdDocument(documentId: string) {
      const holder = new pg.Client({ connectionString: inject('adminUrl') });
      await holder.connect();
      await holder.query('begin');
      await holder.query('select id from documents where id = $1 for update', [documentId]);
      // pg_stat_activity is snapshotted once per transaction; clear it so each poll is fresh.
      const waiters = async () => (await holder.query('select pg_stat_clear_snapshot()'), Number((await holder.query<{ count: string }>(
        `select count(*) from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
      )).rows[0].count));
      return {
        holder,
        async waitForLockWaiters(count: number) {
          const deadline = Date.now() + 15_000;
          let seen = await waiters();
          while (seen < count) {
            if (Date.now() > deadline) {
              throw new Error(`expected ${count} lock waiters, saw ${seen}`);
            }
            await new Promise((done) => setTimeout(done, 25));
            seen = await waiters();
          }
          return seen;
        },
        async finish(statement?: { text: string; values: unknown[] }) {
          try {
            if (statement) {
              await holder.query(statement.text, statement.values);
            }
            await holder.query('commit');
          } finally {
            await holder.end();
          }
        },
      };
    }

    it('concurrent requests that all reach the UPDATE record one restore', async () => {
      const tenant = await createTenant(app, 'restore-race');
      const documentId = await addDocument(tenant, { liveStatus: 'archived' });
      await addArchive(tenant, documentId);
      const call = as(app, tenant.token);
      const lock = await holdDocument(documentId);
      let pending: Promise<Awaited<ReturnType<typeof call>>[]>;
      try {
        pending = Promise.all([1, 2, 3, 4].map(() => call('POST', `/api/documents/${documentId}/restore`)));
        // All four read the file as archived and now wait on the row: one will move it, and
        // the other three must take the lost-race branch (re-read, answer the current state).
        expect(await lock.waitForLockWaiters(4)).toBe(4);
      } finally {
        await lock.finish();
      }
      const responses = await pending!;
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ status: 'restore_requested' });
      }
      expect(await auditRows(tenant, documentId)).toHaveLength(1);
      expect(byId(await listDocuments(tenant), documentId).liveStatus).toBe('restore_requested');
    });

    it('a request that loses to a concurrent delete answers 404', async () => {
      const tenant = await createTenant(app, 'restore-vs-delete');
      const documentId = await addDocument(tenant, { liveStatus: 'archived' });
      await addArchive(tenant, documentId);
      const lock = await holdDocument(documentId);
      let pending: ReturnType<ReturnType<typeof as>>;
      try {
        pending = as(app, tenant.token)('POST', `/api/documents/${documentId}/restore`);
        await lock.waitForLockWaiters(1);
      } finally {
        // The holder deletes the row (as a bid delete's cascade does) and commits.
        await lock.finish({ text: 'delete from documents where id = $1', values: [documentId] });
      }
      const response = await pending!;
      expect(response.statusCode, response.body).toBe(404);
      expect(await auditRows(tenant, documentId)).toHaveLength(0);
    });

    it('refuses an archived file with no usable archive copy, and leaves it archived', async () => {
      const tenant = await createTenant(app, 'restore-no-copy');
      const call = as(app, tenant.token);
      const none = await addDocument(tenant, { liveStatus: 'archived' });
      const purgedOnly = await addDocument(tenant, { liveStatus: 'archived' });
      await addArchive(tenant, purgedOnly, { purgedAt: new Date() });
      const expiredOnly = await addDocument(tenant, { liveStatus: 'archived' });
      const expired = await addArchive(tenant, expiredOnly);
      await withOrg(tenant.orgId, (db) => db.update(schema.archiveObjects).set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.archiveObjects.id, expired)));
      for (const documentId of [none, purgedOnly, expiredOnly]) {
        const response = await call('POST', `/api/documents/${documentId}/restore`);
        expect(response.statusCode).toBe(409);
        expect(response.json<{ code: string; error: string }>()).toMatchObject({ code: 'no_archive_copy' });
        expect(byId(await listDocuments(tenant), documentId).liveStatus).toBe('archived');
        expect(await auditRows(tenant, documentId)).toHaveLength(0);
      }
      const copies = await withOrg(tenant.orgId, (db) => db.select().from(schema.archiveObjects)
        .where(inArray(schema.archiveObjects.documentId, [purgedOnly, expiredOnly])));
      expect(copies.every((row) => row.restoreStatus === 'none')).toBe(true);
    });

    it('refuses a file that is not archived', async () => {
      const tenant = await createTenant(app, 'restore-live');
      const live = await addDocument(tenant, { liveStatus: 'live' });
      const deleted = await addDocument(tenant, { liveStatus: 'deleted' });
      const call = as(app, tenant.token);
      expect((await call('POST', `/api/documents/${live}/restore`)).statusCode).toBe(409);
      expect((await call('POST', `/api/documents/${deleted}/restore`)).statusCode).toBe(409);
      expect((await call('POST', '/api/documents/not-a-uuid/restore')).statusCode).toBe(404);
    });

    it('free organizations restore only while restore_free_allowed is on', async () => {
      const tenant = await createTenant(app, 'restore-gate');
      const documentId = await addDocument(tenant, { liveStatus: 'archived' });
      await addArchive(tenant, documentId);
      const call = as(app, tenant.token);

      await setSetting('restore_free_allowed', 'false');
      const refused = await call('POST', `/api/documents/${documentId}/restore`);
      expect(refused.statusCode).toBe(402);
      expect(refused.json<{ code: string }>().code).toBe('plan_required');
      expect(byId(await listDocuments(tenant), documentId).liveStatus).toBe('archived');
      expect(await auditRows(tenant, documentId)).toHaveLength(0);

      await setPlan(tenant.orgId, 'starter');
      expect((await call('POST', `/api/documents/${documentId}/restore`)).json()).toEqual({ status: 'restore_requested' });
    });

    it('free organizations restore by default (no setting)', async () => {
      const tenant = await createTenant(app, 'restore-default');
      const documentId = await addDocument(tenant, { liveStatus: 'archived' });
      await addArchive(tenant, documentId);
      const response = await as(app, tenant.token)('POST', `/api/documents/${documentId}/restore`);
      expect(response.statusCode).toBe(200);
    });

    it('a file being restored does not open', async () => {
      const tenant = await createTenant(app, 'restore-open');
      const documentId = await addDocument(tenant, { liveStatus: 'restore_requested' });
      expect((await as(app, tenant.token)('GET', `/api/documents/${documentId}/file`)).statusCode).toBe(409);
    });
  });

  describe('keyCheck', () => {
    it('maps seeded amendment rows to the four states', async () => {
      const tenant = await createTenant(app, 'key-check');
      const mismatch = await addDocument(tenant, { kind: 'amendment' });
      await addAmendment(tenant, mismatch, false);
      const overridden = await addDocument(tenant, { kind: 'amendment' });
      await addAmendment(tenant, overridden, false, true);
      const matched = await addDocument(tenant, { kind: 'amendment' });
      await addAmendment(tenant, matched, true);
      const unprocessed = await addDocument(tenant, { kind: 'amendment' });
      const attachment = await addDocument(tenant, { kind: 'attachment' });

      const docs = await listDocuments(tenant);
      expect(byId(docs, mismatch).keyCheck).toBe('mismatch');
      expect(byId(docs, mismatch).keyReason).toBe('not_found');
      expect(byId(docs, mismatch).keyFound).toBeNull();
      expect(byId(docs, overridden).keyCheck).toBe('overridden');
      expect(byId(docs, matched).keyCheck).toBe('ok');
      expect(byId(docs, unprocessed).keyCheck).toBe('ok');
      expect(byId(docs, attachment).keyCheck).toBe('not_applicable');
      // The helper's solicitation carries an amendments row; it is still not an amendment.
      expect(byId(docs, tenant.documentId).keyCheck).toBe('not_applicable');

      await consumeCredit(tenant);
      const response = await as(app, tenant.token)('POST', `/api/documents/${mismatch}/key-override`, { reason: 'SLED addendum' });
      expect(response.statusCode).toBe(200);
      expect(byId(await listDocuments(tenant), mismatch).keyCheck).toBe('overridden');
    });
  });

  describe('override limit from app_settings', () => {
    it('reads key_overrides_per_bid instead of the constant', async () => {
      const tenant = await createTenant(app, 'override-setting');
      const first = await addDocument(tenant, { kind: 'amendment' });
      await addAmendment(tenant, first, false);
      const second = await addDocument(tenant, { kind: 'amendment' });
      await addAmendment(tenant, second, false);
      await consumeCredit(tenant);
      const call = as(app, tenant.token);

      expect((await getBid(tenant)).keyOverridesLeft).toBe(2);
      await setSetting('key_overrides_per_bid', '1');
      expect((await getBid(tenant)).keyOverridesLeft).toBe(1);

      const ok = await call('POST', `/api/documents/${first}/key-override`, { reason: 'one' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ remaining: number }>().remaining).toBe(0);
      const refused = await call('POST', `/api/documents/${second}/key-override`, { reason: 'two' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('override_limit');
      expect((await getBid(tenant)).keyOverridesLeft).toBe(0);

      await setSetting('key_overrides_per_bid', '3');
      const raised = await call('POST', `/api/documents/${second}/key-override`, { reason: 'two' });
      expect(raised.statusCode).toBe(200);
      expect(raised.json<{ remaining: number }>().remaining).toBe(1);
      expect((await getBid(tenant)).keyOverridesLeft).toBe(1);
    });
  });

  describe('marking page', () => {
    it('the marking step stores the lowest page with a marking, and the list returns it', async () => {
      const tenant = await createTenant(app, 'marking-page');
      const documentId = await addDocument(tenant, { kind: 'attachment' });
      await withOrg(tenant.orgId, (db) => db.insert(schema.pages).values([
        { orgId: tenant.orgId, documentId, pageNo: 5, text: 'FOUO\nBody text.' },
        { orgId: tenant.orgId, documentId, pageNo: 1, text: 'Cover page.' },
        { orgId: tenant.orgId, documentId, pageNo: 2, text: 'Header\nThis page is CUI.\nFooter' },
      ]));
      const { processMarking } = await import('../../worker/src/marking-job.js');
      const payload = {
        orgId: tenant.orgId, bidId: tenant.bidId, documentId, jobId: tenant.jobId, storagePath: 'docs/x.pdf', kind: 'attachment' as const,
      };
      await processMarking(payload);
      let doc = byId(await listDocuments(tenant), documentId);
      expect(doc).toMatchObject({ markingStatus: 'blocked', markingPage: 2 });

      // Cleared on a later run that finds nothing.
      await withOrg(tenant.orgId, (db) => db.delete(schema.pages).where(eq(schema.pages.documentId, documentId)));
      await processMarking(payload);
      doc = byId(await listDocuments(tenant), documentId);
      expect(doc).toMatchObject({ markingStatus: 'none', markingPage: null });
      expect(enqueued).toContain('classify');
    });
  });

  describe('bid status', () => {
    it('a new bid starts in planning', async () => {
      const tenant = await createTenant(app, 'status-new');
      expect((await getBid(tenant)).status).toBe('planning');
      const list = await as(app, tenant.token)('GET', '/api/bids');
      expect(list.json<BidJson[]>().map((bid) => bid.status)).toEqual(['planning']);
    });

    it('PATCH takes the four values and refuses anything else with 400', async () => {
      const tenant = await createTenant(app, 'status-patch');
      const call = as(app, tenant.token);
      for (const status of ['writing', 'submitted', 'closed', 'planning']) {
        const response = await call('PATCH', `/api/bids/${tenant.bidId}`, { status });
        expect(response.statusCode).toBe(200);
        expect(response.json<BidJson>().status).toBe(status);
      }
      for (const status of ['draft', 'Writing', '', 3, null]) {
        const response = await call('PATCH', `/api/bids/${tenant.bidId}`, { status, name: 'Changed' });
        expect(response.statusCode, String(status)).toBe(400);
      }
      const bid = await getBid(tenant);
      expect(bid.status).toBe('planning');
      expect((await withOrg(tenant.orgId, (db) => db.select().from(schema.bids).where(eq(schema.bids.id, tenant.bidId))))[0].name).toBe('Bid status-patch');
    });

    it('the database refuses a status outside the four values', async () => {
      const tenant = await createTenant(app, 'status-check');
      await expect(withOrg(tenant.orgId, (db) => db.execute(sql`update bids set status = 'draft' where id = ${tenant.bidId}`)))
        .rejects.toThrow(/bids_status_check/);
    });
  });

  describe('bid live-until dates', () => {
    async function seedUploads(tenant: Tenant) {
      // The helper's solicitation: move its upload date into the past so these dates decide.
      await withOrg(tenant.orgId, (db) => db.update(schema.documents).set({ createdAt: day('2026-01-01') })
        .where(eq(schema.documents.id, tenant.documentId)));
      await addDocument(tenant, { kind: 'attachment', createdAt: day('2026-02-01') });
      await addDocument(tenant, { kind: 'resume', createdAt: day('2026-03-01') });
      await addDocument(tenant, { kind: 'draft', liveStatus: 'deleted', createdAt: day('2026-04-01') });
    }

    it('free: latest upload plus 90 days; the due date and extension do not count', async () => {
      const tenant = await createTenant(app, 'live-free');
      await seedUploads(tenant);
      await as(app, tenant.token)('PATCH', `/api/bids/${tenant.bidId}`, { dueDate: '2026-09-01T00:00:00.000Z' });
      const bid = await getBid(tenant);
      // The resume (latest, not deleted) counts on Free; the deleted draft does not.
      expect(bid.defaultLiveUntil).toBe(plusDays(day('2026-03-01'), 90));
      expect(bid.filesLiveUntil).toBe(bid.defaultLiveUntil);
    });

    it('free with no files: null', async () => {
      const tenant = await createTenant(app, 'live-free-empty');
      await withOrg(tenant.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' })
        .where(eq(schema.documents.bidId, tenant.bidId)));
      const bid = await getBid(tenant);
      expect(bid.defaultLiveUntil).toBeNull();
      expect(bid.filesLiveUntil).toBeNull();
    });

    it('paid: the later of latest non-resume upload + 90 and due + 90, then the extension', async () => {
      const tenant = await createTenant(app, 'live-paid');
      await seedUploads(tenant);
      await setPlan(tenant.orgId, 'starter');
      const call = as(app, tenant.token);

      // No due date: the attachment (latest non-resume, not deleted) + 90.
      let bid = await getBid(tenant);
      expect(bid.defaultLiveUntil).toBe(plusDays(day('2026-02-01'), 90));
      expect(bid.filesLiveUntil).toBe(bid.defaultLiveUntil);

      // A due date after it wins.
      let response = await call('PATCH', `/api/bids/${tenant.bidId}`, { dueDate: '2026-09-01T00:00:00.000Z' });
      expect(response.json<BidJson>().defaultLiveUntil).toBe(plusDays(day('2026-09-01'), 90));
      // A due date before it does not.
      response = await call('PATCH', `/api/bids/${tenant.bidId}`, { dueDate: '2026-01-15T00:00:00.000Z' });
      expect(response.json<BidJson>().defaultLiveUntil).toBe(plusDays(day('2026-02-01'), 90));

      // An extension later than the default is the files' date; the default stays.
      const extension = new Date(Date.now() + 500 * DAY).toISOString();
      response = await call('PATCH', `/api/bids/${tenant.bidId}`, { retentionExtendedUntil: extension });
      bid = response.json<BidJson>();
      expect(bid.defaultLiveUntil).toBe(plusDays(day('2026-02-01'), 90));
      expect(bid.filesLiveUntil).toBe(extension);
    });

    it('paid with only a due date: due + 90', async () => {
      const tenant = await createTenant(app, 'live-paid-due');
      await setPlan(tenant.orgId, 'growth');
      await withOrg(tenant.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' })
        .where(eq(schema.documents.bidId, tenant.bidId)));
      expect((await getBid(tenant)).defaultLiveUntil).toBeNull();
      const response = await as(app, tenant.token)('PATCH', `/api/bids/${tenant.bidId}`, { dueDate: '2026-12-01T00:00:00.000Z' });
      expect(response.json<BidJson>().defaultLiveUntil).toBe(plusDays(day('2026-12-01'), 90));
    });
  });

  describe('cross-tenant', () => {
    it('another organization cannot list, restore, or change status, and sees none of it', async () => {
      const a = await createTenant(app, 'xt-a');
      const b = await createTenant(app, 'xt-b');
      const bArchived = await addDocument(b, { liveStatus: 'archived' });
      await addArchive(b, bArchived);
      const asA = as(app, a.token);

      expect((await asA('GET', `/api/bids/${b.bidId}/documents`)).statusCode).toBe(404);
      expect((await asA('POST', `/api/documents/${bArchived}/restore`)).statusCode).toBe(404);
      expect((await asA('PATCH', `/api/bids/${b.bidId}`, { status: 'closed' })).statusCode).toBe(404);
      expect((await asA('GET', `/api/bids/${b.bidId}`)).statusCode).toBe(404);
      const list = (await asA('GET', '/api/bids')).json<BidJson[]>();
      expect(list.map((bid) => bid.id)).toEqual([a.bidId]);

      expect(byId(await listDocuments(b), bArchived).liveStatus).toBe('archived');
      expect((await getBid(b)).status).toBe('planning');
      const archives = await withOrg(b.orgId, (db) => db.select().from(schema.archiveObjects)
        .where(eq(schema.archiveObjects.documentId, bArchived)));
      expect(archives.every((row) => row.restoreStatus === 'none')).toBe(true);
      expect(await auditRows(b, bArchived)).toHaveLength(0);
    });

    it('a document list never carries another organization\'s archive or amendment rows', async () => {
      const a = await createTenant(app, 'xt-rows-a');
      const b = await createTenant(app, 'xt-rows-b');
      const aDoc = await addDocument(a, { kind: 'amendment', liveStatus: 'restored' });
      await addArchive(a, aDoc, { restoreStatus: 'restored', restoredUntil: day('2026-11-01') });
      // B cannot plant rows that point at A's document: row-level security refuses the insert.
      await expect(withOrg(b.orgId, (db) => db.insert(schema.archiveObjects).values({
        orgId: a.orgId, documentId: aDoc, objectType: 'original', archiveKey: 'x', archivedAt: new Date(),
        restoreStatus: 'restored', restoredUntil: day('2027-01-01'),
      }))).rejects.toThrow(/row-level security/);
      const doc = byId(await listDocuments(a), aDoc);
      expect(doc.restoredUntil).toBe('2026-11-01T00:00:00.000Z');
      expect(doc.keyCheck).toBe('ok');
      expect((await listDocuments(b)).some((row) => row.id === aDoc)).toBe(false);
    });
  });
});

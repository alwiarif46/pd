/**
 * Amendment numbers (04 s3.1): the worker's key check settles the number by the decision table,
 * upload start and complete take a typed number, and PATCH /api/documents/:id/amendment-no sets
 * one. Real database; the worker's classify step is imported, its queue and the api queue are
 * mocked.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { enqueueClassify } from '../src/queue.js';
import { as, createTenant, createUser, type Tenant } from './helpers.js';
import { fulfilled, raceInOrder, type Reply } from './races.js';

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

const unavailable = inject('dbUnavailable');
const BID_NUMBER = 'W912-24-R-0001';
const BID_KEY = 'W91224R0001';
const KEY_LINE = `Solicitation No. ${BID_NUMBER}`;

type Payload = { orgId: string; bidId: string; documentId: string; jobId: string; storagePath: string; kind: 'amendment' };

describe.skipIf(Boolean(unavailable))('amendment numbers', () => {
  let app: FastifyInstance;
  let classify: typeof import('../../worker/src/classify-job.js');

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-amendno-'));
    getPool({ connectionString: inject('appUrl'), max: 8 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    classify = await import('../../worker/src/classify-job.js');
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  beforeEach(() => {
    enqueued.length = 0;
    vi.mocked(enqueueClassify).mockClear();
  });

  async function setup(label: string): Promise<Tenant> {
    const tenant = await createTenant(app, label);
    await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({
      creditStatus: 'consumed', solicitationNumber: BID_NUMBER, solicitationKey: BID_KEY,
    }).where(eq(schema.bids.id, tenant.bidId)));
    return tenant;
  }

  interface DocOptions { amendmentNo?: number; source?: 'user' | 'document' | 'sequence'; status?: 'held' | 'processing' | 'applied'; deleted?: boolean }

  /** An amendment document with one page; with `status`, also its amendments row. */
  async function amendmentDoc(tenant: Tenant, text: string, options: DocOptions = {}): Promise<string> {
    return withOrg(tenant.orgId, async (db) => {
      const [document] = await db.insert(schema.documents).values({
        orgId: tenant.orgId, bidId: tenant.bidId, fileName: 'amendment.pdf', mime: 'application/pdf', sizeBytes: 5,
        sha256: randomUUID(), kind: 'amendment', storagePath: `docs/${randomUUID()}.pdf`,
        liveStatus: options.deleted ? 'deleted' : 'live',
        amendmentNo: options.amendmentNo ?? null,
        amendmentNoSource: options.amendmentNo ? options.source ?? 'user' : null,
      }).returning();
      await db.insert(schema.pages).values({ orgId: tenant.orgId, documentId: document.id, pageNo: 1, text });
      if (options.status) {
        await db.insert(schema.amendments).values({
          orgId: tenant.orgId, bidId: tenant.bidId, documentId: document.id, amendmentNo: options.amendmentNo ?? null,
          solicitationKeyFound: true, status: options.status, matchedKey: BID_KEY,
        });
      }
      return document.id;
    });
  }

  const payload = (tenant: Tenant, documentId: string, jobId: string = randomUUID()): Payload => ({
    orgId: tenant.orgId, bidId: tenant.bidId, documentId, jobId, storagePath: '', kind: 'amendment',
  });
  const check = (tenant: Tenant, documentId: string, jobId?: string) => classify.processClassify(payload(tenant, documentId, jobId));
  const documentRow = async (tenant: Tenant, documentId: string) => {
    const [row] = await withOrg(tenant.orgId, (db) => db.select().from(schema.documents).where(eq(schema.documents.id, documentId)));
    return row;
  };
  const amendmentRow = async (tenant: Tenant, documentId: string) => {
    const [row] = await withOrg(tenant.orgId, (db) => db.select().from(schema.amendments).where(eq(schema.amendments.documentId, documentId)));
    return row;
  };
  const queuedFor = (documentId: string) => enqueued.filter((item) => item.name === 'ai:amendment' && item.documentId === documentId);
  async function numbers(tenant: Tenant, documentId: string) {
    const document = await documentRow(tenant, documentId);
    const amendment = await amendmentRow(tenant, documentId);
    return {
      number: document.amendmentNo,
      source: document.amendmentNoSource,
      found: document.amendmentNoFound,
      mirror: amendment?.amendmentNo ?? null,
      status: amendment?.status ?? null,
    };
  }
  async function dto(tenant: Tenant, documentId: string) {
    const response = await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/documents`);
    expect(response.statusCode).toBe(200);
    return response.json<{ id: string; amendmentNo: number | null; amendmentNoSource: string | null; amendmentNoFound: number | null; amendmentStatus: string | null }[]>()
      .find((row) => row.id === documentId)!;
  }

  describe('the key check settles the number', () => {
    it('a typed number wins over the file, and the number in the file is recorded', async () => {
      const tenant = await setup('an-typed');
      const same = await amendmentDoc(tenant, `${KEY_LINE}\nAmendment No. 0004`, { amendmentNo: 4 });
      const differs = await amendmentDoc(tenant, `${KEY_LINE}\nAmendment No. 2`, { amendmentNo: 5 });
      await check(tenant, same);
      await check(tenant, differs);
      expect(await numbers(tenant, same)).toEqual({ number: 4, source: 'user', found: 4, mirror: 4, status: 'processing' });
      expect(await numbers(tenant, differs)).toEqual({ number: 5, source: 'user', found: 2, mirror: 5, status: 'processing' });
      expect(queuedFor(differs)).toHaveLength(1);
      expect(await dto(tenant, differs)).toMatchObject({ amendmentNo: 5, amendmentNoSource: 'user', amendmentNoFound: 2, amendmentStatus: 'processing' });
    });

    it('a free number in the file is used', async () => {
      const tenant = await setup('an-file');
      const documentId = await amendmentDoc(tenant, `2. AMENDMENT/MODIFICATION NO.     3. EFFECTIVE DATE\n0003                              10/14/2026\n9A. AMENDMENT OF SOLICITATION NO.\n${BID_NUMBER}`);
      await check(tenant, documentId);
      expect(await numbers(tenant, documentId)).toEqual({ number: 3, source: 'document', found: 3, mirror: 3, status: 'processing' });
      expect(queuedFor(documentId)).toHaveLength(1);
    });

    it('a number in the file that is taken waits for the user (needs_number), with nothing queued', async () => {
      const tenant = await setup('an-taken');
      await amendmentDoc(tenant, 'held one', { amendmentNo: 3, status: 'held' });
      // A deleted amendment that wrote rows keeps its number; one that did not frees it.
      await amendmentDoc(tenant, 'applied then deleted', { amendmentNo: 6, status: 'applied', deleted: true });
      await amendmentDoc(tenant, 'deleted before it ran', { amendmentNo: 7, status: 'processing', deleted: true });
      const takenLive = await amendmentDoc(tenant, `${KEY_LINE}\nAddendum No. 3`);
      const takenDeleted = await amendmentDoc(tenant, `${KEY_LINE}\nAddendum No. 6`);
      const freed = await amendmentDoc(tenant, `${KEY_LINE}\nAddendum No. 7`);
      for (const documentId of [takenLive, takenDeleted, freed]) {
        await check(tenant, documentId);
      }
      expect(await numbers(tenant, takenLive)).toEqual({ number: null, source: null, found: 3, mirror: null, status: 'needs_number' });
      expect(await numbers(tenant, takenDeleted)).toEqual({ number: null, source: null, found: 6, mirror: null, status: 'needs_number' });
      expect(await numbers(tenant, freed)).toMatchObject({ number: 7, source: 'document', status: 'processing' });
      expect(queuedFor(takenLive)).toHaveLength(0);
      expect(queuedFor(takenDeleted)).toHaveLength(0);
      expect(queuedFor(freed)).toHaveLength(1);
      expect(await dto(tenant, takenLive)).toMatchObject({ amendmentNo: null, amendmentNoFound: 3, amendmentStatus: 'needs_number' });
      // A rerun still finds it taken; still nothing queued.
      await check(tenant, takenLive);
      expect((await amendmentRow(tenant, takenLive)).status).toBe('needs_number');
      expect(queuedFor(takenLive)).toHaveLength(0);
    });

    it('two different numbers on page 1 wait for the user', async () => {
      const tenant = await setup('an-ambiguous');
      const documentId = await amendmentDoc(tenant, `${KEY_LINE}\nAddendum No. 2\nThis replaces Addendum No. 1 in full.`);
      await check(tenant, documentId);
      expect(await numbers(tenant, documentId)).toEqual({ number: null, source: null, found: null, mirror: null, status: 'needs_number' });
      expect(queuedFor(documentId)).toHaveLength(0);
    });

    it('no number in the file takes the next in sequence, marked as such', async () => {
      const tenant = await setup('an-sequence');
      await amendmentDoc(tenant, 'one', { amendmentNo: 1, status: 'applied' });
      await amendmentDoc(tenant, 'four', { amendmentNo: 4, status: 'held' });
      await amendmentDoc(tenant, 'nine, deleted before it ran', { amendmentNo: 9, status: 'processing', deleted: true });
      const documentId = await amendmentDoc(tenant, `${KEY_LINE}\nThe site visit moves to Friday.`);
      await check(tenant, documentId);
      expect(await numbers(tenant, documentId)).toEqual({ number: 5, source: 'sequence', found: null, mirror: 5, status: 'processing' });
      expect(await dto(tenant, documentId)).toMatchObject({ amendmentNo: 5, amendmentNoSource: 'sequence', amendmentStatus: 'processing' });
    });

    it('a held amendment settles no number; the override settles it', async () => {
      const tenant = await setup('an-held');
      const documentId = await amendmentDoc(tenant, 'Amendment of Solicitation No. W912-24-R-0002\nAddendum No. 2');
      await check(tenant, documentId);
      expect(await numbers(tenant, documentId)).toEqual({ number: null, source: null, found: null, mirror: null, status: 'held' });
      const override = await as(app, tenant.token)('POST', `/api/documents/${documentId}/key-override`, { reason: 'SLED addendum' });
      expect(override.statusCode, override.body).toBe(200);
      const [job] = vi.mocked(enqueueClassify).mock.calls.map(([call]) => call);
      await check(tenant, documentId, job.jobId);
      expect(await numbers(tenant, documentId)).toEqual({ number: 2, source: 'document', found: 2, mirror: 2, status: 'processing' });
      expect(queuedFor(documentId)).toHaveLength(1);
    });

    it('a rerun keeps the number already settled and never recomputes it', async () => {
      const tenant = await setup('an-rerun');
      const documentId = await amendmentDoc(tenant, `${KEY_LINE}\nNo number here.`);
      await check(tenant, documentId);
      expect(await numbers(tenant, documentId)).toMatchObject({ number: 1, source: 'sequence', status: 'processing' });
      await withOrg(tenant.orgId, (db) => db.update(schema.pages).set({ text: `${KEY_LINE}\nAddendum No. 8` })
        .where(eq(schema.pages.documentId, documentId)));
      await check(tenant, documentId);
      expect(await numbers(tenant, documentId)).toEqual({ number: 1, source: 'sequence', found: 8, mirror: 1, status: 'processing' });
    });
  });

  describe('upload with a number', () => {
    async function start(tenant: Tenant, body: Record<string, unknown>) {
      return as(app, tenant.token)('POST', `/api/bids/${tenant.bidId}/uploads`, body);
    }
    function file() {
      const bytes = randomBytes(32);
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    async function upload(tenant: Tenant, amendmentNo?: number) {
      const { bytes, sha256 } = file();
      const started = await start(tenant, {
        fileName: 'amd.pdf', kind: 'amendment', declaredSize: bytes.length, sha256, chunkCount: 1,
        ...(amendmentNo === undefined ? {} : { amendmentNo }),
      });
      if (started.statusCode !== 201) {
        return { started, completed: null };
      }
      const sessionId = started.json<{ id: string }>().id;
      await sendChunk(tenant, sessionId, bytes);
      return { started, completed: await complete(tenant, sessionId), sessionId };
    }
    async function sendChunk(tenant: Tenant, sessionId: string, bytes: Buffer) {
      const response = await app.inject({
        method: 'PUT', url: `/api/uploads/${sessionId}/chunks/0`,
        headers: { authorization: `Bearer ${tenant.token}`, 'content-type': 'application/octet-stream' }, payload: bytes,
      });
      expect(response.statusCode).toBe(200);
    }
    const complete = (tenant: Tenant, sessionId: string) => as(app, tenant.token)('POST', `/api/uploads/${sessionId}/complete`);

    it('stores a typed number with source user; refuses a taken one at start, on another kind, or out of range', async () => {
      const tenant = await setup('an-upload');
      const first = await upload(tenant, 2);
      expect(first.completed!.statusCode, first.completed!.body).toBe(201);
      const documentId = first.completed!.json<{ documentId: string }>().documentId;
      expect(await numbers(tenant, documentId)).toMatchObject({ number: 2, source: 'user' });

      const taken = await upload(tenant, 2);
      expect(taken.started.statusCode).toBe(409);
      expect(taken.started.json<{ code: string }>().code).toBe('amendment_no_taken');

      const { bytes, sha256 } = file();
      const base = { fileName: 'a.pdf', declaredSize: bytes.length, sha256, chunkCount: 1 };
      for (const body of [
        { ...base, kind: 'attachment', amendmentNo: 3 },
        { ...base, kind: 'amendment', amendmentNo: 0 },
        { ...base, kind: 'amendment', amendmentNo: 1000 },
        { ...base, kind: 'amendment', amendmentNo: 2.5 },
        { ...base, kind: 'amendment', amendmentNo: '3' },
      ]) {
        const response = await start(tenant, body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
        expect(response.json<{ code: string }>().code).toBe('invalid_upload');
      }
      // An open session holds its number against another start.
      const open = await start(tenant, { ...base, kind: 'amendment', amendmentNo: 3 });
      expect(open.statusCode).toBe(201);
      const second = await start(tenant, { ...base, sha256: file().sha256, kind: 'amendment', amendmentNo: 3 });
      expect(second.statusCode).toBe(409);
      expect(second.json<{ code: string }>().code).toBe('amendment_no_taken');
      // No number: still accepted, and settled later by the worker.
      const none = await upload(tenant);
      expect(none.completed!.statusCode).toBe(201);
      expect(await numbers(tenant, none.completed!.json<{ documentId: string }>().documentId)).toMatchObject({ number: null, source: null });
    });

    it('deleting an amendment that wrote no rows frees its number; one that did keeps it', async () => {
      const tenant = await setup('an-delete');
      const unapplied = await amendmentDoc(tenant, 'x', { amendmentNo: 2, status: 'processing' });
      const applied = await amendmentDoc(tenant, 'y', { amendmentNo: 3, status: 'applied' });
      const call = as(app, tenant.token);
      expect((await call('DELETE', `/api/documents/${unapplied}`)).statusCode).toBe(200);
      expect((await call('DELETE', `/api/documents/${applied}`)).statusCode).toBe(200);
      expect((await upload(tenant, 2)).completed!.statusCode).toBe(201);
      const kept = await upload(tenant, 3);
      expect(kept.started.statusCode).toBe(409);
      expect(kept.started.json<{ code: string }>().code).toBe('amendment_no_taken');
    });

    it('two sessions completing with the same number: one document, the other refused and reopened', async () => {
      for (let round = 0; round < 3; round += 1) {
        const tenant = await setup(`an-complete-${round}`);
        const sessions: { id: string; bytes: Buffer }[] = [];
        for (let index = 0; index < 2; index += 1) {
          const { bytes, sha256 } = file();
          const started = await start(tenant, { fileName: `amd-${index}.pdf`, kind: 'amendment', declaredSize: bytes.length, sha256, chunkCount: 1 });
          expect(started.statusCode).toBe(201);
          const id = started.json<{ id: string }>().id;
          await sendChunk(tenant, id, bytes);
          sessions.push({ id, bytes });
        }
        // Both typed 4 (the second as if it started before the first: start refuses a duplicate).
        await withOrg(tenant.orgId, (db) => db.update(schema.uploadSessions).set({ amendmentNo: 4 })
          .where(eq(schema.uploadSessions.bidId, tenant.bidId)));
        const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId],
          sessions.map((session) => () => complete(tenant, session.id)));
        expect(waiting).toBe(2);
        const replies = results.map((result) => fulfilled(result) as Reply);
        expect(replies.map((reply) => reply.statusCode)).toEqual([201, 409]);
        expect(replies[1].json<{ code: string }>().code).toBe('amendment_no_taken');
        const documents = await withOrg(tenant.orgId, (db) => db.select().from(schema.documents).where(and(
          eq(schema.documents.bidId, tenant.bidId), eq(schema.documents.kind, 'amendment'),
        )));
        expect(documents.map((document) => document.amendmentNo)).toEqual([4]);
        const [reopened] = await withOrg(tenant.orgId, (db) => db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, sessions[1].id)));
        expect(reopened.status).toBe('open');
      }
    });

    it('an upload start and a PATCH of a number on one bid never deadlock, in either order', async () => {
      for (let round = 0; round < 3; round += 1) {
        for (const patchFirst of [true, false]) {
          const tenant = await setup(`an-race-start-${round}`);
          const documentId = await amendmentDoc(tenant, 'x', { amendmentNo: 1, status: 'processing' });
          const { bytes, sha256 } = file();
          const begin = () => start(tenant, { fileName: 'amd.pdf', kind: 'amendment', declaredSize: bytes.length, sha256, chunkCount: 1, amendmentNo: 5 });
          const patch = () => as(app, tenant.token)('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 5 });
          const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId],
            patchFirst ? [patch, begin] : [begin, patch]);
          expect(waiting).toBe(2);
          const [patched, started] = (patchFirst ? results : [results[1], results[0]]).map((result) => fulfilled(result) as Reply);
          expect(patched.statusCode, patched.body).toBe(200);
          if (patchFirst) {
            // The document holds 5 first: the start is refused.
            expect(started.statusCode).toBe(409);
            expect(started.json<{ code: string }>().code).toBe('amendment_no_taken');
          } else {
            // The session started with 5 first. PATCH counts documents only, so it takes 5, and
            // the session is refused when it completes.
            expect(started.statusCode, started.body).toBe(201);
            const sessionId = started.json<{ id: string }>().id;
            await sendChunk(tenant, sessionId, bytes);
            const completed = await complete(tenant, sessionId);
            expect(completed.statusCode).toBe(409);
            expect(completed.json<{ code: string }>().code).toBe('amendment_no_taken');
          }
          expect((await numbers(tenant, documentId)).number).toBe(5);
        }
      }
    });
  });

  describe('PATCH /api/documents/:id/amendment-no', () => {
    async function memberCall(tenant: Tenant) {
      const member = await createUser('an-member');
      await withOrg(tenant.orgId, (db) => db.insert(schema.memberships).values({ orgId: tenant.orgId, userId: member.userId, role: 'member' }));
      return { call: as(app, member.token), userId: member.userId };
    }

    it('updates the document, the amendment, the rows it added and the rows it closed, with history', async () => {
      const tenant = await setup('an-patch');
      const documentId = await amendmentDoc(tenant, 'x', { amendmentNo: 1, source: 'sequence', status: 'applied' });
      const amendment = await amendmentRow(tenant, documentId);
      const ids = await withOrg(tenant.orgId, async (db) => {
        const [added] = await db.insert(schema.complianceRows).values({
          orgId: tenant.orgId, bidId: tenant.bidId, reqId: 'C.1-01', requirementText: 'Added', documentId, amendmentNo: 1, origin: 'ai',
        }).returning();
        const [closed] = await db.insert(schema.complianceRows).values({
          orgId: tenant.orgId, bidId: tenant.bidId, reqId: 'C.1-02', requirementText: 'Old', amendmentNo: 0,
          supersedeStatus: 'superseded', supersededByRowId: added.id, changedByAmendment: 1,
        }).returning();
        const [untouched] = await db.insert(schema.complianceRows).values({
          orgId: tenant.orgId, bidId: tenant.bidId, reqId: 'C.1-03', requirementText: 'Proposed only', amendmentNo: 0, supersedeStatus: 'active',
        }).returning();
        await db.insert(schema.amendmentLinks).values([
          { orgId: tenant.orgId, amendmentId: amendment.id, rowTable: 'compliance_rows', oldRowId: closed.id, newRowId: added.id, action: 'supersede', status: 'auto' },
          { orgId: tenant.orgId, amendmentId: amendment.id, rowTable: 'compliance_rows', oldRowId: untouched.id, action: 'withdraw', status: 'proposed' },
        ]);
        return { added: added.id, closed: closed.id, untouched: untouched.id };
      });
      const { call, userId } = await memberCall(tenant);
      const response = await call('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 6 });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ ok: true, amendmentNo: 6 });
      expect(await numbers(tenant, documentId)).toMatchObject({ number: 6, source: 'user', mirror: 6, status: 'applied' });
      const rows = await withOrg(tenant.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.bidId, tenant.bidId)));
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(ids.added)).toMatchObject({ amendmentNo: 6 });
      expect(byId.get(ids.closed)).toMatchObject({ changedByAmendment: 6, amendmentNo: 0 });
      expect(byId.get(ids.untouched)).toMatchObject({ changedByAmendment: null, supersedeStatus: 'active' });
      const history = await withOrg(tenant.orgId, (db) => db.select().from(schema.rowHistory).where(eq(schema.rowHistory.userId, userId)));
      expect(history.map((entry) => [entry.rowId, entry.field, entry.oldValue, entry.newValue]).sort()).toEqual([
        [ids.added, 'amendment_no', '1', '6'],
        [ids.closed, 'changed_by_amendment', '1', '6'],
      ].sort());
      expect(enqueueClassify).not.toHaveBeenCalled();
      // The same number again changes nothing more.
      expect((await call('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 6 })).statusCode).toBe(200);
      expect(await withOrg(tenant.orgId, (db) => db.select().from(schema.rowHistory).where(eq(schema.rowHistory.userId, userId)))).toHaveLength(2);
    });

    it('moves needs_number to processing and queues classify; the key check then proceeds with that number', async () => {
      const tenant = await setup('an-patch-needs');
      await amendmentDoc(tenant, 'held', { amendmentNo: 3, status: 'held' });
      const documentId = await amendmentDoc(tenant, `${KEY_LINE}\nAddendum No. 3`);
      await check(tenant, documentId);
      expect((await amendmentRow(tenant, documentId)).status).toBe('needs_number');
      const response = await as(app, tenant.token)('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 4 });
      expect(response.statusCode, response.body).toBe(200);
      expect(await numbers(tenant, documentId)).toEqual({ number: 4, source: 'user', found: 3, mirror: 4, status: 'processing' });
      const calls = vi.mocked(enqueueClassify).mock.calls.map(([call]) => call);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ documentId, kind: 'amendment' });
      const [job] = await withOrg(tenant.orgId, (db) => db.select().from(schema.jobs).where(eq(schema.jobs.id, calls[0].jobId)));
      expect(job).toMatchObject({ type: 'classify', status: 'pending' });
      await check(tenant, documentId, calls[0].jobId);
      expect(await numbers(tenant, documentId)).toMatchObject({ number: 4, source: 'user', status: 'processing' });
      expect(queuedFor(documentId)).toHaveLength(1);
    });

    it('refuses a bad number, a taken number, a deleted file, another kind, and another organization', async () => {
      const tenant = await setup('an-patch-refuse');
      const other = await setup('an-patch-other');
      const call = as(app, tenant.token);
      const documentId = await amendmentDoc(tenant, 'x', { amendmentNo: 1, status: 'processing' });
      await amendmentDoc(tenant, 'y', { amendmentNo: 2, status: 'held' });
      for (const amendmentNo of [0, 1000, 1.5, '2', null]) {
        const response = await call('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo });
        expect(response.statusCode, String(amendmentNo)).toBe(400);
        expect(response.json<{ code: string }>().code).toBe('invalid_amendment_no');
      }
      const taken = await call('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 2 });
      expect(taken.statusCode).toBe(409);
      expect(taken.json<{ code: string }>().code).toBe('amendment_no_taken');
      const solicitation = await call('PATCH', `/api/documents/${tenant.documentId}/amendment-no`, { amendmentNo: 5 });
      expect(solicitation.statusCode).toBe(409);
      expect(solicitation.json<{ code: string }>().code).toBe('not_an_amendment');
      expect((await as(app, other.token)('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 5 })).statusCode).toBe(404);
      expect((await call('PATCH', '/api/documents/not-a-uuid/amendment-no', { amendmentNo: 5 })).statusCode).toBe(404);
      expect((await call('DELETE', `/api/documents/${documentId}`)).statusCode).toBe(200);
      const deleted = await call('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 5 });
      expect(deleted.statusCode).toBe(409);
      expect(deleted.json<{ code: string }>().code).toBe('document_deleted');
      expect(await numbers(tenant, documentId)).toMatchObject({ number: 1, mirror: 1 });
    });

    it('a PATCH and a key check settling a number on one bid never deadlock and never share a number', async () => {
      for (let round = 0; round < 3; round += 1) {
        for (const patchFirst of [true, false]) {
          const tenant = await setup(`an-race-check-${round}`);
          const patched = await amendmentDoc(tenant, 'x', { amendmentNo: 1, status: 'processing' });
          const checked = await amendmentDoc(tenant, `${KEY_LINE}\nNo number here.`);
          const patch = () => as(app, tenant.token)('PATCH', `/api/documents/${patched}/amendment-no`, { amendmentNo: 2 });
          const run = () => check(tenant, checked).then(() => ({ statusCode: 200, body: '' }));
          const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId],
            patchFirst ? [patch, run] : [run, patch]);
          expect(waiting).toBe(2);
          const replies = results.map((result) => fulfilled(result) as Reply);
          const a = await numbers(tenant, patched);
          const b = await numbers(tenant, checked);
          expect(b.number).not.toBeNull();
          expect(a.number).not.toBe(b.number);
          if (patchFirst) {
            // PATCH took 2 first; the check's sequence continues after it.
            expect(replies[0].statusCode).toBe(200);
            expect([a.number, b.number]).toEqual([2, 3]);
          } else {
            // The check took 2 first; PATCH to 2 is refused.
            expect(b.number).toBe(2);
            expect(replies[1].statusCode).toBe(409);
            expect(a.number).toBe(1);
          }
        }
      }
    });
  });
});

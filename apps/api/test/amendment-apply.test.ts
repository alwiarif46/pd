/**
 * The amendment run (04 s3.1 steps 3 to 6) across the worker and the api, against the real
 * database: the worker's classify, matrix and amendment steps are imported from apps/worker; the
 * model passes (extractRows, diffAmendment, mapRows, extractComplianceMatrix) are mocked, while
 * planAmendmentApply and coverage run for real; both queues are spied.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import type { ComplianceRequirement, DiffLink, ExistingRow, PreScanHit } from '@pd/ai';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { enqueueAmendment } from '../src/queue.js';
import { as, createTenant, type Tenant } from './helpers.js';
import { fulfilled, raceInOrder, type Reply } from './races.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const enqueued = vi.hoisted(() => [] as { name: string; documentId: string; bullId: string | undefined }[]);
vi.mock('../../worker/src/enqueue.js', () => ({
  enqueue: vi.fn(async (name: string, payload: { documentId: string }, options?: { jobId?: string }) => {
    enqueued.push({ name, documentId: payload.documentId, bullId: options?.jobId });
  }),
}));

type DiffInput = { newRows: ComplianceRequirement[]; existing: ExistingRow[] };
type MapInput = { rows: ComplianceRequirement[]; pages: { text: string; role?: string | null }[] };
const ai = vi.hoisted(() => ({
  extract: null as null | (() => Promise<unknown>),
  diff: null as null | ((input: DiffInput) => Promise<unknown>),
  map: null as null | ((input: MapInput) => Promise<unknown>),
  calls: { extract: 0, diff: 0, map: 0 },
  diffInputs: [] as DiffInput[],
  mapInputs: [] as MapInput[],
}));
vi.mock('@pd/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pd/ai')>();
  return {
    ...original,
    getProvider: () => ({}),
    extractRows: vi.fn(async () => {
      ai.calls.extract += 1;
      return ai.extract!();
    }),
    diffAmendment: vi.fn(async (input: DiffInput) => {
      ai.calls.diff += 1;
      ai.diffInputs.push(input);
      return ai.diff!(input);
    }),
    mapRows: vi.fn(async (input: MapInput) => {
      ai.calls.map += 1;
      ai.mapInputs.push(input);
      return ai.map ? ai.map(input) : { tokensUsed: 0 };
    }),
    extractComplianceMatrix: vi.fn(async () => ({
      requirements: [newRow('C.3.1', 'The contractor shall answer the phone.')],
      checkThese: [],
      metadata: { skillName: 'compliance-matrix', skillVersion: '1', tokensUsed: 10, costUsd: 0 },
    })),
  };
});

const unavailable = inject('dbUnavailable');
const BID_NUMBER = 'W912-24-R-0001';
const BID_KEY = 'W91224R0001';

function newRow(sectionRef: string, sourceQuote: string, overrides: Partial<ComplianceRequirement> = {}): ComplianceRequirement {
  return {
    id: `${sectionRef}-01`, sectionRef, requirementText: sourceQuote, sourcePage: 1, sourceQuote,
    reqType: 'shall', confidence: 0.9, amendmentNo: 0, origin: 'ai', flags: [], supersedeStatus: 'active', ...overrides,
  };
}

function extracted(rows: ComplianceRequirement[], hits: PreScanHit[] = []) {
  return {
    requirements: rows, hits, classified: [], tokensUsed: 100, chunksProcessed: 1, quoteCheckFailures: 0,
    quoteCheckFailureRate: 0, droppedRows: 0, skillName: 'compliance-matrix', skillVersion: 'test',
  };
}

const link = (overrides: Partial<DiffLink>): DiffLink => ({
  action: 'supersede', newIndex: 0, oldRowId: null, confidence: 0.95, sourcePage: 1, sourceQuote: 'C.3.1 is revised', ...overrides,
});

type Payload = { orgId: string; bidId: string; documentId: string; jobId: string; storagePath: string; kind: 'amendment' | 'solicitation' };

describe.skipIf(Boolean(unavailable))('amendment run', () => {
  let app: FastifyInstance;
  let worker: typeof import('../../worker/src/amendment-job.js');
  let matrix: typeof import('../../worker/src/ai-jobs.js');
  let classify: typeof import('../../worker/src/classify-job.js');

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-amendapply-'));
    getPool({ connectionString: inject('appUrl'), max: 10 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    worker = await import('../../worker/src/amendment-job.js');
    matrix = await import('../../worker/src/ai-jobs.js');
    classify = await import('../../worker/src/classify-job.js');
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  beforeEach(() => {
    enqueued.length = 0;
    ai.calls = { extract: 0, diff: 0, map: 0 };
    ai.diffInputs.length = 0;
    ai.mapInputs.length = 0;
    ai.map = null;
    vi.mocked(enqueueAmendment).mockClear();
    // Default: the amendment revises C.3.1 (row A), deletes C.3.4 (row B) and adds C.3.5.
    ai.extract = async () => extracted([
      newRow('C.3.1', 'The contractor shall staff the help desk from 7 to 7.'),
      newRow('C.3.5', 'The contractor shall keep a visitor log.'),
    ], [
      { text: 'The contractor shall staff the help desk from 7 to 7.', pageNo: 1, kind: 'requirement' },
      { text: 'Offerors shall acknowledge this amendment.', pageNo: 1, kind: 'requirement' },
    ]);
    ai.diff = async ({ existing }) => ({
      links: [
        link({ action: 'supersede', newIndex: 0, oldRowId: idOf(existing, 'C.3.1-01'), confidence: 0.95 }),
        link({ action: 'withdraw', newIndex: null, oldRowId: idOf(existing, 'C.3.4-01'), confidence: 0.9, sourceQuote: 'C.3.4 is deleted' }),
        link({ action: 'add', newIndex: 1, oldRowId: null, confidence: 0.4, sourcePage: null, sourceQuote: null }),
      ],
      dropped: 0,
      tokensUsed: 50,
    });
  });

  function idOf(existing: ExistingRow[], reqId: string): string | null {
    return existing.find((row) => row.reqId === reqId)?.id ?? null;
  }

  interface Fixture { tenant: Tenant; a: string; b: string; c: string }

  /** A tenant whose bid holds a consumed credit, with rows C.3.1-01 (A), C.3.4-01 (B) and C.3.1-03 (C). */
  async function setup(label: string, credit: 'reserved' | 'consumed' = 'consumed'): Promise<Fixture> {
    const tenant = await createTenant(app, label);
    return withOrg(tenant.orgId, async (db) => {
      const [period] = await db.insert(schema.rfpCredits).values({
        orgId: tenant.orgId, periodStart: new Date(Date.now() - 86_400_000), periodEnd: new Date(Date.now() + 86_400_000 * 30),
        allowed: 2, used: credit === 'consumed' ? 1 : 0, reserved: credit === 'reserved' ? 1 : 0,
      }).returning();
      await db.update(schema.bids).set({ creditStatus: credit, creditId: period.id, solicitationNumber: BID_NUMBER, solicitationKey: BID_KEY })
        .where(eq(schema.bids.id, tenant.bidId));
      const base = { orgId: tenant.orgId, bidId: tenant.bidId, documentId: tenant.documentId, origin: 'ai' as const, supersedeStatus: 'active' as const };
      const [a] = await db.insert(schema.complianceRows).values({
        ...base, reqId: 'C.3.1-01', sectionRef: 'C.3.1', requirementText: 'Help desk 8 to 5', sourceQuote: 'The contractor shall staff the help desk from 8 to 5.',
        instrRef: 'L.4', evalRef: 'M.2', responseSection: '3.1',
      }).returning();
      const [b] = await db.insert(schema.complianceRows).values({ ...base, reqId: 'C.3.4-01', sectionRef: 'C.3.4', requirementText: 'Monthly report' }).returning();
      const [c] = await db.insert(schema.complianceRows).values({ ...base, reqId: 'C.3.1-03', sectionRef: 'C.3.1', requirementText: 'Escalation' }).returning();
      return { tenant, a: a.id, b: b.id, c: c.id };
    });
  }

  async function amendmentDoc(tenant: Tenant, text: string): Promise<string> {
    return withOrg(tenant.orgId, async (db) => {
      const [document] = await db.insert(schema.documents).values({
        orgId: tenant.orgId, bidId: tenant.bidId, fileName: 'amendment.pdf', mime: 'application/pdf', sizeBytes: 5,
        sha256: randomUUID(), kind: 'amendment', storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
      }).returning();
      await db.insert(schema.pages).values({ orgId: tenant.orgId, documentId: document.id, pageNo: 1, text, sectionTag: 'other' });
      return document.id;
    });
  }

  const payload = (tenant: Tenant, documentId: string): Payload => ({
    orgId: tenant.orgId, bidId: tenant.bidId, documentId, jobId: randomUUID(), storagePath: '', kind: 'amendment',
  });

  /** An amendment through the key check: processing, with its number settled. */
  async function ready(tenant: Tenant, amendmentNo = 2): Promise<string> {
    const documentId = await amendmentDoc(tenant, `Solicitation No. ${BID_NUMBER}\nAmendment No. ${amendmentNo}\nC.3.1 is revised. C.3.4 is deleted.`);
    await classify.processClassify(payload(tenant, documentId));
    const [row] = await withOrg(tenant.orgId, (db) => db.select().from(schema.amendments).where(eq(schema.amendments.documentId, documentId)));
    expect(row).toMatchObject({ status: 'processing', amendmentNo });
    return documentId;
  }

  const run = (tenant: Tenant, documentId: string) => worker.processAmendmentJob(payload(tenant, documentId));
  const rowsOf = (tenant: Tenant) => withOrg(tenant.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.bidId, tenant.bidId)));
  const amendmentOf = async (tenant: Tenant, documentId: string) => {
    const [row] = await withOrg(tenant.orgId, (db) => db.select().from(schema.amendments).where(eq(schema.amendments.documentId, documentId)));
    return row;
  };
  const linksOf = async (tenant: Tenant, documentId: string) => {
    const amendment = await amendmentOf(tenant, documentId);
    return withOrg(tenant.orgId, (db) => db.select().from(schema.amendmentLinks).where(eq(schema.amendmentLinks.amendmentId, amendment.id)));
  };
  const hitsOf = (tenant: Tenant, documentId: string) => withOrg(tenant.orgId, (db) => db.select().from(schema.checkThese)
    .where(eq(schema.checkThese.documentId, documentId)));
  const credit = async (tenant: Tenant) => withOrg(tenant.orgId, async (db) => {
    const [bid] = await db.select({ creditStatus: schema.bids.creditStatus }).from(schema.bids).where(eq(schema.bids.id, tenant.bidId));
    const credits = await db.select({ used: schema.rfpCredits.used, reserved: schema.rfpCredits.reserved }).from(schema.rfpCredits);
    return { creditStatus: bid.creditStatus, credits };
  });
  const kicked = (documentId: string) => enqueued.filter((item) => item.name === 'ai:amendment' && item.documentId === documentId && item.bullId?.startsWith(`ai:amendment:${documentId}:`));

  describe('apply', () => {
    it('inserts the added rows, closes rows on auto links, writes links, check_these and ai_runs, and spends no credit', async () => {
      const { tenant, a, b, c } = await setup('aa-apply');
      const documentId = await ready(tenant);
      ai.map = async ({ rows }) => {
        // The new C.3.5 row is mapped; the new C.3.1 row is not and inherits from row A.
        rows[1].instrRef = 'L.9';
        return { tokensUsed: 5 };
      };
      const before = await credit(tenant);
      expect(await run(tenant, documentId)).toBe('applied');
      expect(await credit(tenant)).toEqual(before);

      const rows = await rowsOf(tenant);
      const added = rows.filter((row) => row.documentId === documentId).sort((x, y) => x.reqId.localeCompare(y.reqId));
      expect(added.map((row) => [row.reqId, row.amendmentNo, row.quoteVerified, row.origin, row.supersedeStatus])).toEqual([
        ['C.3.1-04', 2, true, 'ai', 'active'],
        ['C.3.5-01', 2, true, 'ai', 'active'],
      ]);
      const [replacement, visitorLog] = added;
      expect(replacement).toMatchObject({ instrRef: 'L.4', evalRef: 'M.2', responseSection: '3.1', sourceQuote: 'The contractor shall staff the help desk from 7 to 7.' });
      expect(visitorLog).toMatchObject({ instrRef: 'L.9', evalRef: null });
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(a)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: replacement.id, changedByAmendment: 2 });
      expect(byId.get(b)).toMatchObject({ supersedeStatus: 'withdrawn', supersededByRowId: null, changedByAmendment: 2 });
      expect(byId.get(c)).toMatchObject({ supersedeStatus: 'active', changedByAmendment: null });

      const links = await linksOf(tenant, documentId);
      expect(links.map((item) => [item.action, item.oldRowId, item.newRowId, item.status, item.sourceQuote]).sort()).toEqual([
        ['add', null, visitorLog.id, 'auto', null],
        ['supersede', a, replacement.id, 'auto', 'C.3.1 is revised'],
        ['withdraw', b, null, 'auto', 'C.3.4 is deleted'],
      ].sort());
      expect((await amendmentOf(tenant, documentId)).status).toBe('applied');
      // check_these: the hit no new row covers.
      expect((await hitsOf(tenant, documentId)).map((hit) => hit.sentence)).toEqual(['Offerors shall acknowledge this amendment.']);
      const runs = await withOrg(tenant.orgId, (db) => db.select().from(schema.aiRuns).where(and(
        eq(schema.aiRuns.bidId, tenant.bidId), eq(schema.aiRuns.task, 'amendment'),
      )));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'completed', inputTokens: 155 });
      // The diff saw the active rows by id; the map saw the solicitation set's instruction pages.
      expect(ai.diffInputs[0].existing.map((row) => row.id)).toEqual(expect.arrayContaining([a, b, c]));
      expect(ai.mapInputs[0].pages.some((page) => page.text.includes('Amendment No. 2'))).toBe(true);

      // The API shows the links with their evidence.
      const response = await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/amendment-links`);
      const supersede = response.json<{ action: string; amendmentNo: number; sourcePage: number; sourceQuote: string; newRow: { label: string } }[]>()
        .find((item) => item.action === 'supersede' && item.amendmentNo === 2)!;
      expect(supersede).toMatchObject({ sourcePage: 1, sourceQuote: 'C.3.1 is revised', newRow: { label: 'C.3.1-04' } });
    });

    it('a proposed link leaves the old row active and the amendment needs_confirmation', async () => {
      const { tenant, a } = await setup('aa-proposed');
      const documentId = await ready(tenant);
      ai.diff = async ({ existing }) => ({
        links: [link({ oldRowId: idOf(existing, 'C.3.1-01'), confidence: 0.5 })],
        dropped: 0,
        tokensUsed: 1,
      });
      expect(await run(tenant, documentId)).toBe('needs_confirmation');
      const rows = await rowsOf(tenant);
      expect(rows.find((row) => row.id === a)).toMatchObject({ supersedeStatus: 'active', changedByAmendment: null });
      expect(rows.filter((row) => row.documentId === documentId)).toHaveLength(2);
      const links = await linksOf(tenant, documentId);
      expect(links.find((item) => item.action === 'supersede')).toMatchObject({ status: 'proposed', oldRowId: a });
      // The C.3.5 row replaces nothing: an add link, always auto.
      expect(links.find((item) => item.action === 'add')).toMatchObject({ status: 'auto', oldRowId: null });
    });

    it('reruns, retries and duplicate jobs write nothing more; two concurrent jobs write one row set', async () => {
      const { tenant } = await setup('aa-once');
      const documentId = await ready(tenant);
      const [first, second] = await Promise.all([run(tenant, documentId), run(tenant, documentId)]);
      expect([first, second].sort()).toEqual(['applied', 'stopped']);
      const count = (await rowsOf(tenant)).length;
      const linkCount = (await linksOf(tenant, documentId)).length;
      const calls = ai.calls.extract;
      expect(await run(tenant, documentId)).toBe('stopped');
      await classify.processClassify(payload(tenant, documentId));
      expect(await run(tenant, documentId)).toBe('stopped');
      expect(ai.calls.extract).toBe(calls);
      expect((await rowsOf(tenant)).length).toBe(count);
      expect((await linksOf(tenant, documentId)).length).toBe(linkCount);
      expect(linkCount).toBe(3);
    });

    it('a provider error fails the amendment with a failed classify step; the retry applies it', async () => {
      const { tenant } = await setup('aa-fail');
      const documentId = await ready(tenant);
      ai.extract = async () => {
        throw new Error('provider down');
      };
      await expect(run(tenant, documentId)).rejects.toThrow('provider down');
      expect((await amendmentOf(tenant, documentId)).status).toBe('failed');
      const jobs = await withOrg(tenant.orgId, (db) => db.select().from(schema.jobs).where(and(
        eq(schema.jobs.documentId, documentId), eq(schema.jobs.status, 'failed'),
      )));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ type: 'classify', error: 'The amendment step failed. Retry it.' });
      expect((await rowsOf(tenant)).filter((row) => row.documentId === documentId)).toHaveLength(0);
      // A failed amendment never runs from a stale job.
      expect(await run(tenant, documentId)).toBe('stopped');

      const retried = await as(app, tenant.token)('POST', `/api/jobs/${jobs[0].id}/retry`);
      expect(retried.statusCode, retried.body).toBe(200);
      enqueued.length = 0;
      await classify.processClassify({ ...payload(tenant, documentId), jobId: retried.json<{ id: string }>().id });
      expect((await amendmentOf(tenant, documentId)).status).toBe('processing');
      expect(enqueued.filter((item) => item.name === 'ai:amendment' && item.documentId === documentId)).toHaveLength(1);
      ai.extract = async () => extracted([newRow('C.3.5', 'The contractor shall keep a visitor log.')]);
      ai.diff = async () => ({ links: [], dropped: 0, tokensUsed: 0 });
      expect(await run(tenant, documentId)).toBe('applied');
      expect((await rowsOf(tenant)).filter((row) => row.documentId === documentId).map((row) => row.amendmentNo)).toEqual([2]);
    });

    it('an attachment matrix run continues the req ids of the bid', async () => {
      const { tenant } = await setup('aa-reqids');
      const attachment = await withOrg(tenant.orgId, async (db) => {
        const [document] = await db.insert(schema.documents).values({
          orgId: tenant.orgId, bidId: tenant.bidId, fileName: 'pws.pdf', mime: 'application/pdf', sizeBytes: 5,
          sha256: randomUUID(), kind: 'attachment', storagePath: 'docs/pws.pdf', liveStatus: 'live',
        }).returning();
        return document.id;
      });
      await matrix.processCompliance({ orgId: tenant.orgId, bidId: tenant.bidId, documentId: attachment, jobId: randomUUID(), storagePath: '', kind: 'attachment' });
      expect((await rowsOf(tenant)).filter((row) => row.documentId === attachment).map((row) => row.reqId)).toEqual(['C.3.1-04']);
    });
  });

  describe('gates', () => {
    it('waits for the solicitation matrix: deferred with no AI call while the credit is reserved; the consume kicks it', async () => {
      const { tenant } = await setup('aa-matrix', 'reserved');
      const documentId = await ready(tenant);
      expect(await run(tenant, documentId)).toBe('deferred');
      expect(ai.calls.extract).toBe(0);
      enqueued.length = 0;
      await matrix.processCompliance({ orgId: tenant.orgId, bidId: tenant.bidId, documentId: tenant.documentId, jobId: randomUUID(), storagePath: '', kind: 'solicitation' });
      expect((await credit(tenant)).creditStatus).toBe('consumed');
      expect(kicked(documentId)).toHaveLength(1);
      expect(await run(tenant, documentId)).toBe('applied');
    });

    it('runs amendments in number order: Amd 3 waits for Amd 2, is kicked, and sees its rows', async () => {
      const { tenant } = await setup('aa-order');
      const two = await ready(tenant, 2);
      const three = await ready(tenant, 3);
      expect(await run(tenant, three)).toBe('deferred');
      expect(ai.calls.extract).toBe(0);
      enqueued.length = 0;
      expect(await run(tenant, two)).toBe('applied');
      expect(kicked(three)).toHaveLength(1);
      const addedByTwo = (await rowsOf(tenant)).filter((row) => row.documentId === two).map((row) => row.id);
      ai.diff = async () => ({ links: [], dropped: 0, tokensUsed: 0 });
      expect(await run(tenant, three)).toBe('applied');
      expect(ai.diffInputs.at(-1)!.existing.map((row) => row.id)).toEqual(expect.arrayContaining(addedByTwo));
      expect((await rowsOf(tenant)).filter((row) => row.documentId === three).map((row) => [row.reqId, row.amendmentNo]).sort()).toEqual([
        ['C.3.1-05', 3], ['C.3.5-02', 3],
      ]);
    });

    it('deleting the lower amendment kicks the next one; a delete after apply keeps the rows', async () => {
      const { tenant } = await setup('aa-delete-kick');
      const two = await ready(tenant, 2);
      const three = await ready(tenant, 3);
      expect(await run(tenant, three)).toBe('deferred');
      expect((await as(app, tenant.token)('DELETE', `/api/documents/${two}`)).statusCode).toBe(200);
      const calls = vi.mocked(enqueueAmendment).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toMatchObject({ documentId: three, kind: 'amendment' });
      expect(calls[0][1]).toMatch(new RegExp(`^ai:amendment:${three}:\\d+$`));
      expect(await run(tenant, three)).toBe('applied');
      const rows = (await rowsOf(tenant)).filter((row) => row.documentId === three);
      expect((await as(app, tenant.token)('DELETE', `/api/documents/${three}`)).statusCode).toBe(200);
      expect((await rowsOf(tenant)).filter((row) => row.documentId === three)).toHaveLength(rows.length);
    });
  });

  describe('decide', () => {
    /** An amendment with one proposed supersede (A -> new C.3.1 row) and one proposed withdraw (B). */
    async function proposals(label: string) {
      const fixture = await setup(label);
      const documentId = await ready(fixture.tenant);
      ai.diff = async ({ existing }) => ({
        links: [
          link({ oldRowId: idOf(existing, 'C.3.1-01'), confidence: 0.5 }),
          link({ action: 'withdraw', newIndex: null, oldRowId: idOf(existing, 'C.3.4-01'), confidence: 0.5, sourceQuote: 'C.3.4 is deleted' }),
        ],
        dropped: 0,
        tokensUsed: 1,
      });
      expect(await run(fixture.tenant, documentId)).toBe('needs_confirmation');
      const links = await linksOf(fixture.tenant, documentId);
      return {
        ...fixture,
        documentId,
        supersede: links.find((item) => item.action === 'supersede')!,
        withdraw: links.find((item) => item.action === 'withdraw')!,
      };
    }

    it('confirm closes the row with changed_by and history; a repeat is 200, a flip 409; the last decision applies', async () => {
      const { tenant, a, b, documentId, supersede, withdraw } = await proposals('aa-decide');
      const call = as(app, tenant.token);
      const confirmed = await call('POST', `/api/amendment-links/${supersede.id}/confirm`);
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toMatchObject({ ok: true, status: 'confirmed', amendmentStatus: 'needs_confirmation' });
      const rows = await rowsOf(tenant);
      expect(rows.find((row) => row.id === a)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: supersede.newRowId, changedByAmendment: 2 });
      const history = await withOrg(tenant.orgId, (db) => db.select().from(schema.rowHistory).where(and(
        eq(schema.rowHistory.rowId, a), eq(schema.rowHistory.userId, tenant.userId),
      )));
      expect(history.map((entry) => [entry.field, entry.oldValue, entry.newValue]).sort()).toEqual([
        ['changed_by_amendment', null, '2'],
        ['superseded_by_row_id', null, supersede.newRowId],
        ['supersede_status', 'active', 'superseded'],
      ].sort());
      expect((await call('POST', `/api/amendment-links/${supersede.id}/confirm`)).statusCode).toBe(200);
      const flip = await call('POST', `/api/amendment-links/${supersede.id}/reject`);
      expect(flip.statusCode).toBe(409);
      expect(flip.json<{ code: string }>().code).toBe('link_already_decided');
      const rejected = await call('POST', `/api/amendment-links/${withdraw.id}/reject`);
      expect(rejected.json()).toMatchObject({ status: 'rejected', amendmentStatus: 'applied' });
      expect((await rowsOf(tenant)).find((row) => row.id === b)).toMatchObject({ supersedeStatus: 'active' });
      expect((await amendmentOf(tenant, documentId)).status).toBe('applied');
    });

    it('confirm refuses a closed old row and a missing new row; another organization gets 404', async () => {
      const { tenant, a, supersede, withdraw } = await proposals('aa-decide-refuse');
      const other = await setup('aa-decide-other');
      expect((await as(app, other.tenant.token)('POST', `/api/amendment-links/${supersede.id}/confirm`)).statusCode).toBe(404);
      await withOrg(tenant.orgId, (db) => db.update(schema.complianceRows).set({ supersedeStatus: 'withdrawn', changedByAmendment: 9 })
        .where(eq(schema.complianceRows.id, a)));
      const closed = await as(app, tenant.token)('POST', `/api/amendment-links/${supersede.id}/confirm`);
      expect(closed.statusCode).toBe(409);
      expect(closed.json<{ code: string }>().code).toBe('row_already_closed');
      await withOrg(tenant.orgId, (db) => db.update(schema.complianceRows).set({ supersedeStatus: 'active', changedByAmendment: null })
        .where(eq(schema.complianceRows.id, a)));
      // The new row removed behind the api's back (the tabs route would have rejected the link).
      await withOrg(tenant.orgId, (db) => db.delete(schema.complianceRows).where(eq(schema.complianceRows.id, supersede.newRowId!)));
      const missing = await as(app, tenant.token)('POST', `/api/amendment-links/${supersede.id}/confirm`);
      expect(missing.statusCode).toBe(409);
      expect(missing.json<{ code: string }>().code).toBe('new_row_missing');
      expect((await rowsOf(tenant)).find((row) => row.id === a)).toMatchObject({ supersedeStatus: 'active' });
      expect((await as(app, tenant.token)('POST', `/api/amendment-links/${withdraw.id}/confirm`)).statusCode).toBe(200);
    });

    it('deleting a new row rejects its proposed link; deleting a replacing row clears the pointer', async () => {
      const { tenant, a, documentId, supersede, withdraw } = await proposals('aa-tabs');
      const call = as(app, tenant.token);
      expect((await call('POST', `/api/amendment-links/${withdraw.id}/reject`)).statusCode).toBe(200);
      const deleted = await call('DELETE', `/api/bids/${tenant.bidId}/rows/compliance_rows/${supersede.newRowId}`);
      expect(deleted.statusCode, deleted.body).toBe(200);
      const [rejected] = await withOrg(tenant.orgId, (db) => db.select().from(schema.amendmentLinks).where(eq(schema.amendmentLinks.id, supersede.id)));
      expect(rejected.status).toBe('rejected');
      expect((await amendmentOf(tenant, documentId)).status).toBe('applied');
      expect((await rowsOf(tenant)).find((row) => row.id === a)).toMatchObject({ supersedeStatus: 'active' });

      // An auto supersede: merging the replacing row away keeps the old row superseded, with no pointer.
      const next = await ready(tenant, 3);
      ai.diff = async ({ existing }) => ({ links: [link({ oldRowId: idOf(existing, 'C.3.1-01'), confidence: 0.99 })], dropped: 0, tokensUsed: 1 });
      expect(await run(tenant, next)).toBe('applied');
      const replacement = (await rowsOf(tenant)).find((row) => row.id === a)!.supersededByRowId!;
      const other = (await rowsOf(tenant)).find((row) => row.documentId === next && row.id !== replacement)!;
      const merged = await call('POST', `/api/bids/${tenant.bidId}/compliance/merge`, { ids: [other.id, replacement] });
      expect(merged.statusCode, merged.body).toBe(200);
      expect((await rowsOf(tenant)).find((row) => row.id === a)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: null, changedByAmendment: 3 });
    });
  });

  describe('races', () => {
    it('a delete and the amendment write: the write committed first (rows kept) or the delete did (nothing written)', async () => {
      for (let round = 0; round < 3; round += 1) {
        for (const deleteFirst of [true, false]) {
          const { tenant } = await setup(`aa-race-del-${round}`);
          const documentId = await ready(tenant);
          const write = () => run(tenant, documentId);
          const remove = () => as(app, tenant.token)('DELETE', `/api/documents/${documentId}`);
          const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from documents where id = $1 for update', [documentId],
            deleteFirst ? [remove, write] : [write, remove]);
          expect(waiting).toBe(2);
          const outcome = fulfilled(results[deleteFirst ? 1 : 0]);
          expect((fulfilled(results[deleteFirst ? 0 : 1]) as Reply).statusCode).toBe(200);
          const rows = (await rowsOf(tenant)).filter((row) => row.documentId === documentId);
          const links = await linksOf(tenant, documentId);
          const hits = await hitsOf(tenant, documentId);
          if (deleteFirst) {
            expect(outcome).toBe('stopped');
            expect([rows.length, links.length, hits.length]).toEqual([0, 0, 0]);
            expect((await amendmentOf(tenant, documentId)).status).toBe('processing');
          } else {
            expect(outcome).toBe('applied');
            expect([rows.length, links.length, hits.length]).toEqual([2, 3, 1]);
          }
        }
      }
    });

    it('a confirm and a key-check rerun on one bid: no deadlock, the link confirmed, no new rows, applied', async () => {
      for (let round = 0; round < 3; round += 1) {
        for (const confirmFirst of [true, false]) {
          const { tenant, a } = await setup(`aa-race-confirm-${round}`);
          const documentId = await ready(tenant);
          ai.diff = async ({ existing }) => ({ links: [link({ oldRowId: idOf(existing, 'C.3.1-01'), confidence: 0.5 })], dropped: 0, tokensUsed: 1 });
          expect(await run(tenant, documentId)).toBe('needs_confirmation');
          const count = (await rowsOf(tenant)).length;
          const supersede = (await linksOf(tenant, documentId)).find((item) => item.action === 'supersede')!;
          const confirm = () => as(app, tenant.token)('POST', `/api/amendment-links/${supersede.id}/confirm`);
          const rerun = () => classify.processClassify(payload(tenant, documentId));
          const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId],
            confirmFirst ? [confirm, rerun] : [rerun, confirm]);
          expect(waiting).toBe(2);
          expect((fulfilled(results[confirmFirst ? 0 : 1]) as Reply).statusCode).toBe(200);
          fulfilled(results[confirmFirst ? 1 : 0]);
          expect(await run(tenant, documentId)).toBe('stopped');
          expect((await rowsOf(tenant)).length).toBe(count);
          expect((await amendmentOf(tenant, documentId)).status).toBe('applied');
          expect((await rowsOf(tenant)).find((row) => row.id === a)).toMatchObject({ supersedeStatus: 'superseded', changedByAmendment: 2 });
        }
      }
    });

    it('a confirm and a second amendment closing the same row: the row is closed once', async () => {
      for (let round = 0; round < 3; round += 1) {
        for (const confirmFirst of [true, false]) {
          const { tenant, a } = await setup(`aa-race-close-${round}`);
          const first = await ready(tenant, 2);
          ai.diff = async ({ existing }) => ({ links: [link({ oldRowId: idOf(existing, 'C.3.1-01'), confidence: 0.5 })], dropped: 0, tokensUsed: 1 });
          expect(await run(tenant, first)).toBe('needs_confirmation');
          const proposal = (await linksOf(tenant, first)).find((item) => item.action === 'supersede')!;
          const second = await ready(tenant, 3);
          ai.diff = async () => ({ links: [link({ action: 'withdraw', newIndex: null, oldRowId: a, confidence: 0.99 })], dropped: 0, tokensUsed: 1 });
          const confirm = () => as(app, tenant.token)('POST', `/api/amendment-links/${proposal.id}/confirm`);
          const write = () => run(tenant, second);
          const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId],
            confirmFirst ? [confirm, write] : [write, confirm]);
          expect(waiting).toBe(2);
          const confirmed = fulfilled(results[confirmFirst ? 0 : 1]) as Reply;
          expect(fulfilled(results[confirmFirst ? 1 : 0])).toBe('applied');
          const row = (await rowsOf(tenant)).find((item) => item.id === a)!;
          const withdrawLinks = (await linksOf(tenant, second)).filter((item) => item.action === 'withdraw');
          if (confirmFirst) {
            expect(confirmed.statusCode).toBe(200);
            expect(row).toMatchObject({ supersedeStatus: 'superseded', changedByAmendment: 2 });
            expect(withdrawLinks).toHaveLength(0);
          } else {
            expect(confirmed.statusCode).toBe(409);
            expect(confirmed.json<{ code: string }>().code).toBe('row_already_closed');
            expect(row).toMatchObject({ supersedeStatus: 'withdrawn', changedByAmendment: 3, supersededByRowId: null });
            expect(withdrawLinks).toHaveLength(1);
          }
        }
      }
    });

    it('a PATCH of the number and the amendment write: the rows carry the final number', async () => {
      for (let round = 0; round < 3; round += 1) {
        for (const patchFirst of [true, false]) {
          const { tenant, a } = await setup(`aa-race-patch-${round}`);
          const documentId = await ready(tenant);
          const patch = () => as(app, tenant.token)('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 7 });
          const write = () => run(tenant, documentId);
          const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId],
            patchFirst ? [patch, write] : [write, patch]);
          expect(waiting).toBe(2);
          expect((fulfilled(results[patchFirst ? 0 : 1]) as Reply).statusCode).toBe(200);
          expect(fulfilled(results[patchFirst ? 1 : 0])).toBe('applied');
          const rows = await rowsOf(tenant);
          expect(rows.filter((row) => row.documentId === documentId).map((row) => row.amendmentNo)).toEqual([7, 7]);
          expect(rows.find((row) => row.id === a)).toMatchObject({ changedByAmendment: 7 });
        }
      }
    });

    it('an upload start and the amendment write on one bid never deadlock, in either order', async () => {
      for (let round = 0; round < 3; round += 1) {
        for (const uploadFirst of [true, false]) {
          const { tenant } = await setup(`aa-race-upload-${round}`);
          const documentId = await ready(tenant);
          const start = () => as(app, tenant.token)('POST', `/api/bids/${tenant.bidId}/uploads`, {
            fileName: 'amd.pdf', kind: 'amendment', declaredSize: 10, sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'), chunkCount: 1, amendmentNo: 8,
          });
          const write = () => run(tenant, documentId);
          const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId],
            uploadFirst ? [start, write] : [write, start]);
          expect(waiting).toBe(2);
          expect((fulfilled(results[uploadFirst ? 0 : 1]) as Reply).statusCode).toBe(201);
          expect(fulfilled(results[uploadFirst ? 1 : 0])).toBe('applied');
        }
      }
    });
  });

  it('never applies a link to another organization\'s row', async () => {
    const { tenant } = await setup('aa-tenant');
    const other = await setup('aa-tenant-other');
    const documentId = await ready(tenant);
    ai.diff = async () => ({ links: [link({ oldRowId: other.a, confidence: 0.99 })], dropped: 0, tokensUsed: 1 });
    expect(await run(tenant, documentId)).toBe('applied');
    const [foreign] = await withOrg(other.tenant.orgId, (db) => db.select().from(schema.complianceRows).where(inArray(schema.complianceRows.id, [other.a])));
    expect(foreign).toMatchObject({ supersedeStatus: 'active', changedByAmendment: null });
    expect((await linksOf(tenant, documentId)).filter((item) => item.oldRowId === other.a)).toHaveLength(0);
  });
});

/**
 * The backfill for amendments applied before the added-rows run (apps/worker/src/amendment-backfill.ts,
 * run by apps/worker/scripts/backfill-amendments.ts), against the real database as pd_app. The
 * model passes (extractRows, diffAmendment, mapRows) are mocked; planning, coverage and every
 * write run for real. Amendments are seeded in the pre-#22 shape: applied or needs_confirmation,
 * links with no new row and no quote, closed rows with no replacement pointer, and no rows from
 * the amendment's own text.
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
import { as, createTenant, type Tenant } from './helpers.js';
import { fulfilled, raceInOrder } from './races.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const enqueued = vi.hoisted(() => [] as { name: string; documentId: string }[]);
vi.mock('../../worker/src/enqueue.js', () => ({
  enqueue: vi.fn(async (name: string, payload: { documentId: string }) => {
    enqueued.push({ name, documentId: payload.documentId });
  }),
}));

type DiffInput = { newRows: ComplianceRequirement[]; existing: ExistingRow[] };
const ai = vi.hoisted(() => ({
  extract: null as null | ((documentId: string) => Promise<unknown>),
  diff: null as null | ((input: DiffInput) => Promise<unknown>),
  calls: { extract: 0, diff: 0, map: 0 },
  diffInputs: [] as DiffInput[],
}));
vi.mock('@pd/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pd/ai')>();
  return {
    ...original,
    getProvider: () => ({}),
    extractRows: vi.fn(async (input: { pages: { text: string }[] }) => {
      ai.calls.extract += 1;
      return ai.extract!(input.pages[0]?.text ?? '');
    }),
    diffAmendment: vi.fn(async (input: DiffInput) => {
      ai.calls.diff += 1;
      ai.diffInputs.push(input);
      return ai.diff!(input);
    }),
    mapRows: vi.fn(async (input: { rows: ComplianceRequirement[] }) => {
      ai.calls.map += 1;
      // The new C.3.5 row is mapped; the replacement of C.3.1 inherits from the row it replaces.
      for (const row of input.rows) {
        if (row.sectionRef === 'C.3.5') {
          row.instrRef = 'L.9';
        }
      }
      return { tokensUsed: 5 };
    }),
  };
});

const unavailable = inject('dbUnavailable');
const BID_NUMBER = 'W912-24-R-0001';
const BID_KEY = 'W91224R0001';

function newRow(sectionRef: string, sourceQuote: string): ComplianceRequirement {
  return {
    id: `${sectionRef}-01`, sectionRef, requirementText: sourceQuote, sourcePage: 1, sourceQuote,
    reqType: 'shall', confidence: 0.9, amendmentNo: 0, origin: 'ai', flags: [], supersedeStatus: 'active',
  };
}

function extracted(rows: ComplianceRequirement[], hits: PreScanHit[] = []) {
  return {
    requirements: rows, hits, classified: [], tokensUsed: 100, chunksProcessed: 1, quoteCheckFailures: 0,
    quoteCheckFailureRate: 0, droppedRows: 0, skillName: 'compliance-matrix', skillVersion: 'test',
  };
}

const link = (overrides: Partial<DiffLink>): DiffLink => ({
  action: 'supersede', newIndex: 0, oldRowId: null, confidence: 0.95, sourcePage: 1, sourceQuote: 'C.3.1 is revised to read', ...overrides,
});

describe.skipIf(Boolean(unavailable))('amendment backfill', () => {
  let app: FastifyInstance;
  let backfill: typeof import('../../worker/src/amendment-backfill.js');
  let lines: string[];

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-backfill-'));
    getPool({ connectionString: inject('appUrl'), max: 10 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    backfill = await import('../../worker/src/amendment-backfill.js');
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  beforeEach(() => {
    enqueued.length = 0;
    lines = [];
    ai.calls = { extract: 0, diff: 0, map: 0 };
    ai.diffInputs.length = 0;
    // Amd 2 revises C.3.1 (row A), deletes C.3.4 (row B) and adds C.3.5. Amd 3 revises C.3.1-03 (row C).
    ai.extract = async (text) => (text.includes('Amendment No. 3')
      ? extracted([newRow('C.3.1', 'The contractor shall escalate within one hour.')])
      : extracted([
        newRow('C.3.1', 'The contractor shall staff the help desk from 7 to 7.'),
        newRow('C.3.5', 'The contractor shall keep a visitor log.'),
      ], [
        { text: 'The contractor shall staff the help desk from 7 to 7.', pageNo: 1, kind: 'requirement' },
        { text: 'Offerors shall acknowledge this amendment.', pageNo: 1, kind: 'requirement' },
      ]));
    ai.diff = async ({ newRows, existing }) => {
      const id = (reqId: string) => existing.find((row) => row.reqId === reqId)?.id ?? null;
      if (newRows.length === 1) {
        return { links: [link({ oldRowId: id('C.3.1-03'), sourceQuote: 'C.3.1 escalation is revised to read' })], dropped: 0, tokensUsed: 7 };
      }
      return {
        links: [
          link({ action: 'supersede', newIndex: 0, oldRowId: id('C.3.1-01'), confidence: 0.95 }),
          link({ action: 'withdraw', newIndex: null, oldRowId: id('C.3.4-01'), confidence: 0.9, sourceQuote: 'C.3.4 Monthly report is deleted' }),
          link({ action: 'add', newIndex: 1, oldRowId: null, confidence: 0.4, sourcePage: null, sourceQuote: null }),
        ],
        dropped: 0,
        tokensUsed: 50,
      };
    };
  });

  interface Fixture {
    tenant: Tenant;
    a: string;
    b: string;
    c: string;
    /** Amd 2, applied before #22: auto supersede of A, auto withdraw of B, an empty add link. */
    amd2: { documentId: string; amendmentId: string };
    /** Amd 3, needs_confirmation before #22: a proposed supersede of C with no new row. */
    amd3: { documentId: string; amendmentId: string };
  }

  async function amendment(tenant: Tenant, amendmentNo: number, status: 'applied' | 'needs_confirmation') {
    return withOrg(tenant.orgId, async (db) => {
      const [document] = await db.insert(schema.documents).values({
        orgId: tenant.orgId, bidId: tenant.bidId, fileName: `amendment-${amendmentNo}.pdf`, mime: 'application/pdf', sizeBytes: 5,
        sha256: randomUUID(), kind: 'amendment', storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
        extractStatus: 'ready', amendmentNo, amendmentNoSource: 'sequence', keyStatus: 'match', keyFound: BID_KEY,
      }).returning();
      await db.insert(schema.pages).values({
        orgId: tenant.orgId, documentId: document.id, pageNo: 1, sectionTag: 'other',
        text: `Solicitation No. ${BID_NUMBER}\nAmendment No. ${amendmentNo}\nC.3.1 is revised to read. C.3.4 Monthly report is deleted.`,
      });
      const [row] = await db.insert(schema.amendments).values({
        orgId: tenant.orgId, bidId: tenant.bidId, documentId: document.id, amendmentNo, solicitationKeyFound: true,
        matchedKey: BID_KEY, status,
      }).returning();
      return { documentId: document.id, amendmentId: row.id };
    });
  }

  /** A tenant whose bid holds a consumed credit, with Amd 2 and Amd 3 in the pre-#22 shape. */
  async function setup(label: string): Promise<Fixture> {
    const tenant = await createTenant(app, label);
    const ids = await withOrg(tenant.orgId, async (db) => {
      const [period] = await db.insert(schema.rfpCredits).values({
        orgId: tenant.orgId, periodStart: new Date(Date.now() - 86_400_000), periodEnd: new Date(Date.now() + 86_400_000 * 30),
        allowed: 2, used: 1, reserved: 0,
      }).returning();
      await db.update(schema.bids).set({ creditStatus: 'consumed', creditId: period.id, solicitationNumber: BID_NUMBER, solicitationKey: BID_KEY })
        .where(eq(schema.bids.id, tenant.bidId));
      const base = { orgId: tenant.orgId, bidId: tenant.bidId, documentId: tenant.documentId, origin: 'ai' as const };
      // A and B were closed by Amd 2 before #22: no replacement pointer; 0009 set changed_by_amendment.
      const [a] = await db.insert(schema.complianceRows).values({
        ...base, reqId: 'C.3.1-01', sectionRef: 'C.3.1', requirementText: 'Help desk 8 to 5', sourceQuote: 'The contractor shall staff the help desk from 8 to 5.',
        instrRef: 'L.4', evalRef: 'M.2', responseSection: '3.1', supersedeStatus: 'superseded', changedByAmendment: 2,
      }).returning();
      const [b] = await db.insert(schema.complianceRows).values({
        ...base, reqId: 'C.3.4-01', sectionRef: 'C.3.4', requirementText: 'Monthly report', supersedeStatus: 'withdrawn', changedByAmendment: 2,
      }).returning();
      const [c] = await db.insert(schema.complianceRows).values({
        ...base, reqId: 'C.3.1-03', sectionRef: 'C.3.1', requirementText: 'Escalation', supersedeStatus: 'active',
      }).returning();
      return { a: a.id, b: b.id, c: c.id };
    });
    const amd2 = await amendment(tenant, 2, 'applied');
    const amd3 = await amendment(tenant, 3, 'needs_confirmation');
    await withOrg(tenant.orgId, (db) => db.insert(schema.amendmentLinks).values([
      { orgId: tenant.orgId, amendmentId: amd2.amendmentId, rowTable: 'compliance_rows', oldRowId: ids.a, action: 'supersede', confidence: '0.95', status: 'auto' },
      { orgId: tenant.orgId, amendmentId: amd2.amendmentId, rowTable: 'compliance_rows', oldRowId: ids.b, action: 'withdraw', confidence: '0.90', status: 'auto' },
      { orgId: tenant.orgId, amendmentId: amd2.amendmentId, rowTable: 'compliance_rows', action: 'add', confidence: '0.40', status: 'auto' },
      { orgId: tenant.orgId, amendmentId: amd3.amendmentId, rowTable: 'compliance_rows', oldRowId: ids.c, action: 'supersede', confidence: '0.50', status: 'proposed' },
    ]));
    return { tenant, ...ids, amd2, amd3 };
  }

  /** Everything the backfill could touch for one organization, for before/after comparison. */
  async function snapshot(tenant: Tenant) {
    return withOrg(tenant.orgId, async (db) => {
      const order = <T extends { id: string }>(rows: T[]) => rows.sort((x, y) => x.id.localeCompare(y.id));
      return {
        rows: order(await db.select().from(schema.complianceRows).where(eq(schema.complianceRows.orgId, tenant.orgId))),
        links: order(await db.select().from(schema.amendmentLinks).where(eq(schema.amendmentLinks.orgId, tenant.orgId))),
        amendments: order(await db.select().from(schema.amendments).where(eq(schema.amendments.orgId, tenant.orgId))),
        hits: order(await db.select().from(schema.checkThese).where(eq(schema.checkThese.orgId, tenant.orgId))),
        runs: order(await db.select().from(schema.aiRuns).where(eq(schema.aiRuns.orgId, tenant.orgId))),
        audit: order(await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, tenant.orgId))),
        credits: order(await db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.orgId, tenant.orgId))),
        bids: order(await db.select().from(schema.bids).where(eq(schema.bids.orgId, tenant.orgId))),
        jobs: order(await db.select().from(schema.jobs).where(eq(schema.jobs.orgId, tenant.orgId))),
      };
    });
  }

  const run = (orgIds: string[], options: { apply?: boolean; bidId?: string; limit?: number } = {}) => backfill.runBackfill({
    orgIds, apply: options.apply ?? false, bidId: options.bidId, limit: options.limit, log: (line) => lines.push(line),
  });

  describe('arguments', () => {
    it('parses --org (repeatable), --bid, --limit and --apply, and refuses anything else', () => {
      const org = randomUUID();
      const other = randomUUID();
      const bid = randomUUID();
      expect(backfill.parseBackfillArgs(['--org', org, '--org', other, '--bid', bid, '--limit', '5', '--apply']))
        .toEqual({ orgIds: [org, other], bidId: bid, limit: 5, apply: true });
      expect(backfill.parseBackfillArgs(['--org', org])).toEqual({ orgIds: [org], bidId: undefined, limit: undefined, apply: false });
      expect(backfill.parseBackfillArgs([])).toMatchObject({ error: expect.stringContaining('--org') });
      expect(backfill.parseBackfillArgs(['--org', 'nope'])).toMatchObject({ error: expect.stringContaining('nope') });
      expect(backfill.parseBackfillArgs(['--org', org, '--bid', 'x'])).toMatchObject({ error: expect.stringContaining('--bid') });
      expect(backfill.parseBackfillArgs(['--org', org, '--limit', '0'])).toMatchObject({ error: expect.stringContaining('--limit') });
      expect(backfill.parseBackfillArgs(['--org', org, '--limit'])).toMatchObject({ error: expect.stringContaining('--limit') });
      expect(backfill.parseBackfillArgs(['--org', org, '--yes'])).toMatchObject({ error: expect.stringContaining('--yes') });
    });
  });

  it('dry run lists each amendment and what would change, calls no model and writes nothing', async () => {
    const fixture = await setup('bf-dry');
    const before = await snapshot(fixture.tenant);
    const report = await run([fixture.tenant.orgId]);
    expect(await snapshot(fixture.tenant)).toEqual(before);
    expect(ai.calls).toEqual({ extract: 0, diff: 0, map: 0 });
    expect(enqueued).toEqual([]);
    expect(report).toMatchObject({ eligible: 2, backfilled: 0, skipped: 0, failed: 0 });
    const amd2 = lines.find((line) => line.includes(`amendment=${fixture.amd2.amendmentId}`))!;
    expect(amd2).toContain('mode=dry-run');
    expect(amd2).toContain(`org=${fixture.tenant.orgId}`);
    expect(amd2).toContain(`bid=${fixture.tenant.bidId}`);
    expect(amd2).toContain('amd=2');
    expect(amd2).toContain('result=would-backfill');
    expect(amd2).toContain('pages=1');
    // One supersede link without its new row, two links without a quote.
    expect(amd2).toContain('unpaired_supersedes=1');
    expect(amd2).toContain('links_without_quote=2');
    const amd3 = lines.find((line) => line.includes(`amendment=${fixture.amd3.amendmentId}`))!;
    expect(amd3).toContain('amd=3');
    expect(amd3).toContain('open_proposals=1');
    expect(lines.at(-1)).toContain('would_backfill=2');
    expect(lines.at(-1)).toContain('mode=dry-run');
  });

  it('apply gives the post-#22 shape: rows from the amendment, paired links with quotes, pointers, check these; no credit or status change', async () => {
    const fixture = await setup('bf-apply');
    const { tenant, a, b, c, amd2, amd3 } = fixture;
    const before = await snapshot(tenant);
    const report = await run([tenant.orgId], { apply: true });
    expect(report).toMatchObject({ eligible: 2, backfilled: 2, skipped: 0, failed: 0 });
    const after = await snapshot(tenant);
    // No credit, bid, job or status change; nothing queued.
    expect(after.credits).toEqual(before.credits);
    expect(after.bids).toEqual(before.bids);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.amendments.map((row) => [row.id, row.status, row.amendmentNo]))
      .toEqual(before.amendments.map((row) => [row.id, row.status, row.amendmentNo]));
    expect(enqueued).toEqual([]);

    const byDoc = (documentId: string) => after.rows.filter((row) => row.documentId === documentId).sort((x, y) => x.reqId.localeCompare(y.reqId));
    const added2 = byDoc(amd2.documentId);
    // Req ids continue the bid's: C.3.1 had -01 and -03, so Amd 2 takes -04 and Amd 3 (run after it) -05.
    expect(added2.map((row) => [row.reqId, row.amendmentNo, row.quoteVerified, row.origin, row.supersedeStatus])).toEqual([
      ['C.3.1-04', 2, true, 'ai', 'active'],
      ['C.3.5-01', 2, true, 'ai', 'active'],
    ]);
    const [replacement, visitorLog] = added2;
    expect(replacement).toMatchObject({ instrRef: 'L.4', evalRef: 'M.2', responseSection: '3.1', sourcePage: 1 });
    expect(visitorLog).toMatchObject({ instrRef: 'L.9', evalRef: null });
    const [escalation] = byDoc(amd3.documentId);
    expect(escalation).toMatchObject({ reqId: 'C.3.1-05', amendmentNo: 3, supersedeStatus: 'active', instrRef: null });

    const rowById = new Map(after.rows.map((row) => [row.id, row]));
    // The closed row now points at its replacement; nothing else about A, B or C changed.
    expect(rowById.get(a)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: replacement.id, changedByAmendment: 2 });
    expect(rowById.get(b)).toMatchObject({ supersedeStatus: 'withdrawn', supersededByRowId: null, changedByAmendment: 2 });
    expect(rowById.get(c)).toMatchObject({ supersedeStatus: 'active', supersededByRowId: null, changedByAmendment: null });

    const linksOf = (amendmentId: string) => after.links.filter((item) => item.amendmentId === amendmentId)
      .map((item) => [item.action, item.oldRowId, item.newRowId, item.status, item.sourcePage, item.sourceQuote]).sort();
    expect(linksOf(amd2.amendmentId)).toEqual([
      // The pre-#22 add link is kept as it was; the new C.3.5 row gets its own add link.
      ['add', null, null, 'auto', null, null],
      ['add', null, visitorLog.id, 'auto', null, null],
      ['supersede', a, replacement.id, 'auto', 1, 'C.3.1 is revised to read'],
      ['withdraw', b, null, 'auto', 1, 'C.3.4 Monthly report is deleted'],
    ].sort());
    // The proposal now names its new row (and its quote), so it can be confirmed; it stays proposed.
    expect(linksOf(amd3.amendmentId)).toEqual([
      ['supersede', c, escalation.id, 'proposed', 1, 'C.3.1 escalation is revised to read'],
    ]);
    // The pre-#22 links kept their ids: they were filled, not replaced.
    const oldIds = before.links.map((item) => item.id);
    expect(after.links.filter((item) => oldIds.includes(item.id))).toHaveLength(oldIds.length);

    // check_these for the amendment document: the hit no new row covers.
    expect(after.hits.filter((hit) => hit.documentId === amd2.documentId).map((hit) => hit.sentence)).toEqual(['Offerors shall acknowledge this amendment.']);
    // One ai_runs row and one audit row per amendment.
    expect(after.runs.filter((item) => item.task === 'amendment_backfill')).toHaveLength(2);
    const audit = after.audit.filter((item) => item.action === 'amendment_backfill');
    expect(audit.map((item) => item.targetId).sort()).toEqual([amd2.amendmentId, amd3.amendmentId].sort());
    expect(audit.find((item) => item.targetId === amd2.amendmentId)!.detail).toMatchObject({
      documentId: amd2.documentId,
      amendmentNo: 2,
      insertedRowIds: expect.arrayContaining([replacement.id, visitorLog.id]),
      pointedRowIds: [a],
    });
    // The diff was offered the rows the amendment's own links name, not the bid's other active rows.
    const offered = ai.diffInputs.map((input) => input.existing.map((row) => row.id).sort());
    expect(offered).toEqual(expect.arrayContaining([[a, b].sort(), [c]]));

    const applied = lines.find((line) => line.includes(`amendment=${amd2.amendmentId}`))!;
    expect(applied).toContain('mode=apply');
    expect(applied).toContain('result=backfilled');
    expect(applied).toContain('rows_inserted=2');
    expect(applied).toContain('links_paired=1');
    expect(applied).toContain('add_links=1');
    expect(applied).toContain('quotes_filled=2');
    expect(applied).toContain('pointers_set=1');

    // The proposal that was not confirmable before (no new row) can be confirmed now.
    const proposal = after.links.find((item) => item.amendmentId === amd3.amendmentId)!;
    const confirmed = await as(app, tenant.token)('POST', `/api/amendment-links/${proposal.id}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: 'confirmed', amendmentStatus: 'applied' });
    const [closed] = await withOrg(tenant.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.id, c)));
    expect(closed).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: escalation.id, changedByAmendment: 3 });
  });

  it('a second run, dry or apply, is a no-op: nothing written, no model call', async () => {
    const fixture = await setup('bf-again');
    await run([fixture.tenant.orgId], { apply: true });
    const before = await snapshot(fixture.tenant);
    ai.calls = { extract: 0, diff: 0, map: 0 };
    lines = [];
    expect(await run([fixture.tenant.orgId])).toMatchObject({ eligible: 0, skipped: 2 });
    expect(await run([fixture.tenant.orgId], { apply: true })).toMatchObject({ eligible: 0, backfilled: 0, skipped: 2, failed: 0 });
    expect(await snapshot(fixture.tenant)).toEqual(before);
    expect(ai.calls).toEqual({ extract: 0, diff: 0, map: 0 });
    expect(lines.filter((line) => line.includes('result=skip')).every((line) => line.includes('reason="already backfilled"'))).toBe(true);
  });

  it('skips a deleted amendment, a bid without a consumed credit, a moved bid key, and an amendment the post-#22 run wrote', async () => {
    const deleted = await setup('bf-skip-deleted');
    await withOrg(deleted.tenant.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' })
      .where(eq(schema.documents.id, deleted.amd2.documentId)));
    const released = await setup('bf-skip-credit');
    await withOrg(released.tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'released' })
      .where(eq(schema.bids.id, released.tenant.bidId)));
    const moved = await setup('bf-skip-key');
    await withOrg(moved.tenant.orgId, (db) => db.update(schema.bids).set({ solicitationNumber: 'W912-24-R-0002', solicitationKey: 'W91224R0002' })
      .where(eq(schema.bids.id, moved.tenant.bidId)));
    const modern = await setup('bf-skip-modern');
    await withOrg(modern.tenant.orgId, (db) => db.insert(schema.complianceRows).values({
      orgId: modern.tenant.orgId, bidId: modern.tenant.bidId, documentId: modern.amd2.documentId, reqId: 'C.3.9-01',
      requirementText: 'Added by the post-#22 run', amendmentNo: 2, origin: 'ai', supersedeStatus: 'active',
    }));
    const modernQuoted = await withOrg(modern.tenant.orgId, (db) => db.update(schema.amendmentLinks).set({ sourceQuote: 'C.3.1 escalation is revised to read', sourcePage: 1 })
      .where(eq(schema.amendmentLinks.amendmentId, modern.amd3.amendmentId)).returning());
    expect(modernQuoted).toHaveLength(1);

    const tenants = [deleted, released, moved, modern];
    const before = await Promise.all(tenants.map((item) => snapshot(item.tenant)));
    const report = await run(tenants.map((item) => item.tenant.orgId), { apply: true });
    // Only the deleted tenant's Amd 3 is still eligible.
    expect(report).toMatchObject({ eligible: 1, backfilled: 1, skipped: 7, failed: 0 });
    const reason = (amendmentId: string) => lines.find((line) => line.includes(`amendment=${amendmentId}`))!;
    expect(reason(deleted.amd2.amendmentId)).toContain('reason="document deleted"');
    expect(reason(deleted.amd3.amendmentId)).toContain('result=backfilled');
    expect(reason(released.amd2.amendmentId)).toContain('reason="bid credit is released, not consumed"');
    expect(reason(moved.amd2.amendmentId)).toContain('reason="bid key changed since the key check"');
    expect(reason(modern.amd2.amendmentId)).toContain('reason="already has rows from its text"');
    expect(reason(modern.amd3.amendmentId)).toContain('reason="links written by the post-#22 run"');
    const after = await Promise.all(tenants.map((item) => snapshot(item.tenant)));
    for (const index of [1, 2, 3]) {
      expect(after[index]).toEqual(before[index]);
    }
    expect(after[0].rows.filter((row) => row.documentId === deleted.amd2.documentId)).toHaveLength(0);
  });

  it('tenant isolation: only the organizations named are read or written, and --bid of another organization finds nothing', async () => {
    const mine = await setup('bf-iso-mine');
    const theirs = await setup('bf-iso-theirs');
    const theirsBefore = await snapshot(theirs.tenant);
    // Their bid named under my organization: row-level security shows nothing.
    expect(await run([mine.tenant.orgId], { apply: true, bidId: theirs.tenant.bidId })).toMatchObject({ eligible: 0, skipped: 0, backfilled: 0 });
    expect(lines.some((line) => line.includes(theirs.tenant.bidId) && !line.includes('summary'))).toBe(false);
    expect(await run([mine.tenant.orgId], { apply: true })).toMatchObject({ backfilled: 2 });
    expect(await snapshot(theirs.tenant)).toEqual(theirsBefore);
    // Every line names my organization; none names theirs.
    expect(lines.filter((line) => line.includes('amendment=')).every((line) => line.includes(`org=${mine.tenant.orgId}`))).toBe(true);
    expect(lines.some((line) => line.includes(theirs.tenant.orgId))).toBe(false);
    // The diff never saw their rows.
    const theirRows = new Set(theirsBefore.rows.map((row) => row.id));
    expect(ai.diffInputs.flatMap((input) => input.existing).some((row) => theirRows.has(row.id))).toBe(false);
    // Their rows are untouched by name, too.
    const touched = await withOrg(mine.tenant.orgId, (db) => db.select({ id: schema.complianceRows.id }).from(schema.complianceRows)
      .where(inArray(schema.complianceRows.id, [...theirRows])));
    expect(touched).toEqual([]);
  });

  it('--bid and --limit narrow the run; amendments run in number order', async () => {
    const fixture = await setup('bf-limit');
    const other = await setup('bf-limit-other');
    expect(await run([fixture.tenant.orgId, other.tenant.orgId], { apply: true, bidId: fixture.tenant.bidId, limit: 1 }))
      .toMatchObject({ eligible: 1, backfilled: 1 });
    const audit = await withOrg(fixture.tenant.orgId, (db) => db.select().from(schema.auditLog).where(and(
      eq(schema.auditLog.orgId, fixture.tenant.orgId), eq(schema.auditLog.action, 'amendment_backfill'),
    )));
    expect(audit.map((item) => item.targetId)).toEqual([fixture.amd2.amendmentId]);
    expect((await snapshot(other.tenant)).audit.filter((item) => item.action === 'amendment_backfill')).toEqual([]);
    expect(await run([fixture.tenant.orgId], { apply: true })).toMatchObject({ backfilled: 1, skipped: 1 });
  });

  it('a model failure leaves that amendment untouched, is reported, and the next amendment still runs', async () => {
    const fixture = await setup('bf-fail');
    const before = await snapshot(fixture.tenant);
    ai.extract = async (text) => {
      if (text.includes('Amendment No. 2')) {
        throw new Error('provider down');
      }
      return extracted([newRow('C.3.1', 'The contractor shall escalate within one hour.')]);
    };
    expect(await run([fixture.tenant.orgId], { apply: true })).toMatchObject({ eligible: 2, backfilled: 1, failed: 1 });
    const failed = lines.find((line) => line.includes(`amendment=${fixture.amd2.amendmentId}`))!;
    expect(failed).toContain('result=failed');
    expect(failed).toContain('provider down');
    const after = await snapshot(fixture.tenant);
    expect(after.rows.filter((row) => row.documentId === fixture.amd2.documentId)).toEqual([]);
    expect(after.amendments).toEqual(before.amendments);
    // No failed job row: the amendment is not moved to failed; the backfill can simply run again.
    expect(after.jobs).toEqual(before.jobs);
  });

  it('two concurrent backfills of one amendment write one row set: the second sees the first and skips', async () => {
    const fixture = await setup('bf-race');
    const { waiting, results } = await raceInOrder(fixture.tenant.orgId, 'select id from bids where id = $1 for update', [fixture.tenant.bidId], [
      () => run([fixture.tenant.orgId], { apply: true, limit: 1 }),
      () => run([fixture.tenant.orgId], { apply: true, limit: 1 }),
    ]);
    expect(waiting).toBe(2);
    const reports = results.map((result) => fulfilled(result) as Awaited<ReturnType<typeof run>>);
    expect(reports.map((item) => item.backfilled).sort()).toEqual([0, 1]);
    expect(reports.find((item) => item.backfilled === 0)).toMatchObject({ skipped: 1, failed: 0 });
    const rows = await withOrg(fixture.tenant.orgId, (db) => db.select().from(schema.complianceRows)
      .where(eq(schema.complianceRows.documentId, fixture.amd2.documentId)));
    expect(rows).toHaveLength(2);
  });

  it('queues behind a holder of the amendment row (the live write and link confirm take it), then writes', async () => {
    const fixture = await setup('bf-lock');
    const { waiting, results } = await raceInOrder(fixture.tenant.orgId, 'select id from amendments where id = $1 for update', [fixture.amd2.amendmentId], [
      () => run([fixture.tenant.orgId], { apply: true, limit: 1 }),
    ]);
    expect(waiting).toBe(1);
    expect(fulfilled(results[0])).toMatchObject({ backfilled: 1 });
  });

  describe('planBackfill', () => {
    const ids = (() => {
      let n = 0;
      return () => `new-${++n}`;
    })();
    it('pairs a supersede link without a new row to its best confident replacement, fills quotes, and adds the rest', () => {
      const plan = backfill.planBackfill(
        [
          { id: 'l1', action: 'supersede', oldRowId: 'A', newRowId: null, sourceQuote: null },
          { id: 'l2', action: 'withdraw', oldRowId: 'B', newRowId: null, sourceQuote: null },
          { id: 'l3', action: 'supersede', oldRowId: 'C', newRowId: null, sourceQuote: 'kept quote' },
          { id: 'l4', action: 'supersede', oldRowId: 'D', newRowId: 'already', sourceQuote: null },
          { id: 'l5', action: 'add', oldRowId: null, newRowId: null, sourceQuote: null },
        ],
        [newRow('C.3.1', 'one'), newRow('C.3.2', 'two'), newRow('C.3.3', 'three')],
        [
          link({ newIndex: 0, oldRowId: 'A', confidence: 0.85, sourceQuote: 'quote low' }),
          link({ newIndex: 1, oldRowId: 'A', confidence: 0.95, sourceQuote: 'quote high' }),
          link({ action: 'withdraw', newIndex: null, oldRowId: 'B', confidence: 0.9, sourceQuote: 'B is deleted' }),
          // Below the threshold: not paired.
          link({ newIndex: 2, oldRowId: 'C', confidence: 0.5 }),
          // A row the amendment's links do not name: ignored.
          link({ newIndex: 2, oldRowId: 'Z', confidence: 0.99 }),
          // A link that already has its row is never re-paired.
          link({ newIndex: 2, oldRowId: 'D', confidence: 0.99 }),
        ],
        0.8,
        ids,
      );
      const [one, two, three] = plan.inserts.map((row) => row.id);
      expect(plan.pairs).toEqual([{ linkId: 'l1', oldRowId: 'A', newRowId: two, sourcePage: 1, sourceQuote: 'quote high' }]);
      expect(plan.quoteFills).toEqual([{ linkId: 'l2', sourcePage: 1, sourceQuote: 'B is deleted' }]);
      expect(plan.addRowIds).toEqual([one, three]);
    });
  });
});

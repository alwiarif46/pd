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
import { closeDb, getDb, getPool, schema, SETTING_AMENDMENT_LINK_CONFIDENCE, withOrg } from '@pd/core';
import { as, createTenant, type Tenant } from './helpers.js';
import { fulfilled, raceInOrder, type Reply } from './races.js';

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

/** transaction_read_only at the end of each withOrg transaction, in order. */
const readOnly = vi.hoisted(() => [] as string[]);
vi.mock('@pd/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pd/core')>();
  const { sql } = await import('drizzle-orm');
  return {
    ...original,
    withOrg: <T>(orgId: string, fn: (db: Parameters<Parameters<typeof original.withOrg>[1]>[0]) => Promise<T>) => original.withOrg(orgId, async (db) => {
      const result = await fn(db);
      const setting = await db.execute<{ ro: string }>(sql`select current_setting('transaction_read_only') as ro`);
      readOnly.push(setting.rows[0].ro);
      return result;
    }),
  };
});

type DiffInput = { newRows: ComplianceRequirement[]; existing: ExistingRow[] };
const ai = vi.hoisted(() => ({
  extract: null as null | ((text: string) => Promise<unknown>),
  /** Runs after extraction, before the write transaction: a stand-in for anything landing meanwhile. */
  afterExtract: null as null | ((text: string) => Promise<void>),
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
      const text = input.pages[0]?.text ?? '';
      const result = await ai.extract!(text);
      await ai.afterExtract?.(text);
      return result;
    }),
    diffAmendment: vi.fn(async (input: DiffInput) => {
      ai.calls.diff += 1;
      ai.diffInputs.push(input);
      return ai.diff!(input);
    }),
    mapRows: vi.fn(async (input: { rows: ComplianceRequirement[] }) => {
      ai.calls.map += 1;
      // The new C.3.5 row is mapped; a replacement inherits from the row it replaces.
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

type AmdStatus = 'applied' | 'needs_confirmation' | 'processing';

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
    ai.afterExtract = null;
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
        // Below the 0.80 threshold, as the original proposal was.
        return { links: [link({ oldRowId: id('C.3.1-03'), confidence: 0.6, sourceQuote: 'C.3.1 escalation is revised to read' })], dropped: 0, tokensUsed: 7 };
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

  type Amd = { documentId: string; amendmentId: string };
  interface Fixture {
    tenant: Tenant;
    /** C.3.1-01, superseded by Amd 2 before #22 (no pointer). */
    a: string;
    /** C.3.4-01, withdrawn by Amd 2. */
    b: string;
    /** C.3.1-03, active; Amd 3 proposes to supersede it. */
    c: string;
    /** C.3.2-01, active and unrelated (instrRef L.7). */
    d: string;
    /** Amd 2: auto supersede of A, auto withdraw of B, an empty add link. */
    amd2?: Amd;
    /** Amd 3: a proposed supersede of C with no new row. */
    amd3?: Amd;
  }

  async function amendment(tenant: Tenant, amendmentNo: number, status: AmdStatus): Promise<Amd> {
    return withOrg(tenant.orgId, async (db) => {
      const [document] = await db.insert(schema.documents).values({
        orgId: tenant.orgId, bidId: tenant.bidId, fileName: `amendment-${amendmentNo}.pdf`, mime: 'application/pdf', sizeBytes: 5,
        sha256: randomUUID(), kind: 'amendment', storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
        extractStatus: 'ready', amendmentNo, amendmentNoSource: 'sequence', keyStatus: 'match', keyFound: BID_KEY,
      }).returning();
      await db.insert(schema.pages).values({
        orgId: tenant.orgId, documentId: document.id, pageNo: 1, sectionTag: 'other',
        text: `Solicitation No. ${BID_NUMBER}\nAmendment No. ${amendmentNo}\nRef ${tenant.orgId}\nC.3.1 is revised to read. C.3.4 Monthly report is deleted.`,
      });
      const [row] = await db.insert(schema.amendments).values({
        orgId: tenant.orgId, bidId: tenant.bidId, documentId: document.id, amendmentNo, solicitationKeyFound: true,
        matchedKey: BID_KEY, status,
      }).returning();
      return { documentId: document.id, amendmentId: row.id };
    });
  }

  /**
   * A tenant whose bid holds a consumed credit, with rows A to D and, in the pre-#22 shape, Amd 2
   * (`amd2`, default applied) and Amd 3 (`amd3`, default none).
   */
  async function setup(label: string, spec: { amd2?: AmdStatus | false; amd3?: AmdStatus | false } = {}): Promise<Fixture> {
    const tenant = await createTenant(app, label);
    const ids = await withOrg(tenant.orgId, async (db) => {
      const [period] = await db.insert(schema.rfpCredits).values({
        orgId: tenant.orgId, periodStart: new Date(Date.now() - 86_400_000), periodEnd: new Date(Date.now() + 86_400_000 * 30),
        allowed: 2, used: 1, reserved: 0,
      }).returning();
      await db.update(schema.bids).set({ creditStatus: 'consumed', creditId: period.id, solicitationNumber: BID_NUMBER, solicitationKey: BID_KEY })
        .where(eq(schema.bids.id, tenant.bidId));
      const base = { orgId: tenant.orgId, bidId: tenant.bidId, documentId: tenant.documentId, origin: 'ai' as const };
      const amd2 = spec.amd2 !== false;
      // A and B were closed by Amd 2 before #22: no replacement pointer; 0009 set changed_by_amendment.
      const [a] = await db.insert(schema.complianceRows).values({
        ...base, reqId: 'C.3.1-01', sectionRef: 'C.3.1', requirementText: 'Help desk 8 to 5', sourceQuote: 'The contractor shall staff the help desk from 8 to 5.',
        instrRef: 'L.4', evalRef: 'M.2', responseSection: '3.1',
        supersedeStatus: amd2 ? 'superseded' : 'active', changedByAmendment: amd2 ? 2 : null,
      }).returning();
      const [b] = await db.insert(schema.complianceRows).values({
        ...base, reqId: 'C.3.4-01', sectionRef: 'C.3.4', requirementText: 'Monthly report',
        supersedeStatus: amd2 ? 'withdrawn' : 'active', changedByAmendment: amd2 ? 2 : null,
      }).returning();
      const [c] = await db.insert(schema.complianceRows).values({
        ...base, reqId: 'C.3.1-03', sectionRef: 'C.3.1', requirementText: 'Escalation', supersedeStatus: 'active',
      }).returning();
      const [d] = await db.insert(schema.complianceRows).values({
        ...base, reqId: 'C.3.2-01', sectionRef: 'C.3.2', requirementText: 'Hours', instrRef: 'L.7', supersedeStatus: 'active',
      }).returning();
      return { a: a.id, b: b.id, c: c.id, d: d.id };
    });
    const fixture: Fixture = { tenant, ...ids };
    if (spec.amd2 !== false) {
      const amd2 = await amendment(tenant, 2, spec.amd2 ?? 'applied');
      await withOrg(tenant.orgId, (db) => db.insert(schema.amendmentLinks).values([
        { orgId: tenant.orgId, amendmentId: amd2.amendmentId, rowTable: 'compliance_rows', oldRowId: ids.a, action: 'supersede', confidence: '0.95', status: 'auto' },
        { orgId: tenant.orgId, amendmentId: amd2.amendmentId, rowTable: 'compliance_rows', oldRowId: ids.b, action: 'withdraw', confidence: '0.90', status: 'auto' },
        { orgId: tenant.orgId, amendmentId: amd2.amendmentId, rowTable: 'compliance_rows', action: 'add', confidence: '0.40', status: 'auto' },
      ]));
      fixture.amd2 = amd2;
    }
    if (spec.amd3) {
      const amd3 = await amendment(tenant, 3, spec.amd3);
      await withOrg(tenant.orgId, (db) => db.insert(schema.amendmentLinks).values({
        orgId: tenant.orgId, amendmentId: amd3.amendmentId, rowTable: 'compliance_rows', oldRowId: ids.c, action: 'supersede', confidence: '0.50', status: 'proposed',
      }));
      fixture.amd3 = amd3;
    }
    return fixture;
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
  type Report = Awaited<ReturnType<typeof run>>;
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  const lineOf = (amendmentId: string) => lines.find((line) => line.includes(`amendment=${amendmentId}`)) ?? '';
  const rowsOfDoc = async (tenant: Tenant, documentId: string) => (await snapshot(tenant)).rows
    .filter((row) => row.documentId === documentId).sort((x, y) => x.reqId.localeCompare(y.reqId));
  const linksOf = (snap: Snapshot, amendmentId: string) => snap.links.filter((item) => item.amendmentId === amendmentId)
    .map((item) => [item.action, item.oldRowId, item.newRowId, item.status, item.sourcePage, item.sourceQuote]).sort();

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

  it('dry run lists each amendment and what would change, in read-only transactions, with no model call and no write', async () => {
    const single = await setup('bf-dry-one');
    const both = await setup('bf-dry-both', { amd3: 'needs_confirmation' });
    const before = [await snapshot(single.tenant), await snapshot(both.tenant)];
    readOnly.length = 0;
    const report = await run([single.tenant.orgId, both.tenant.orgId]);
    // Every transaction the dry run opened was read-only.
    expect(readOnly.length).toBeGreaterThan(0);
    expect(readOnly.every((value) => value === 'on')).toBe(true);
    expect([await snapshot(single.tenant), await snapshot(both.tenant)]).toEqual(before);
    expect(ai.calls).toEqual({ extract: 0, diff: 0, map: 0 });
    expect(enqueued).toEqual([]);
    expect(report).toMatchObject({ eligible: 2, backfilled: 0, skipped: 1, failed: 0 });

    const amd2 = lineOf(single.amd2!.amendmentId);
    for (const part of ['mode=dry-run', `org=${single.tenant.orgId}`, `bid=${single.tenant.bidId}`, 'amd=2', 'result=would-backfill', 'pages=1',
      'unpaired_supersedes=1', 'links_without_quote=2', 'open_proposals=0', 'later_amendments=0']) {
      expect(amd2).toContain(part);
    }
    // Amd 2 under a later Amd 3 is skipped: its rows could sit active next to Amd 3's.
    const blocked = lineOf(both.amd2!.amendmentId);
    expect(blocked).toContain('result=skip');
    expect(blocked).toContain('reason="later amendment 3 exists; rows could duplicate"');
    expect(blocked).toContain('later_amendments=1');
    const amd3 = lineOf(both.amd3!.amendmentId);
    for (const part of ['amd=3', 'result=would-backfill', 'open_proposals=1', 'later_amendments=0', 'unpaired_supersedes=1', 'links_without_quote=1']) {
      expect(amd3).toContain(part);
    }
    expect(lines.at(-1)).toContain('would_backfill=2');
    expect(lines.at(-1)).toContain('mode=dry-run');
  });

  it('apply gives the post-#22 shape: rows from the amendment, paired links with quotes, a pointer, check these; no credit or status change', async () => {
    const { tenant, a, b, amd2 } = await setup('bf-apply');
    const before = await snapshot(tenant);
    readOnly.length = 0;
    const report = await run([tenant.orgId], { apply: true });
    expect(report).toMatchObject({ eligible: 1, backfilled: 1, skipped: 0, failed: 0 });
    // Its own reads (listing, facts, the named rows) are read-only; the live helpers it reuses
    // (setting, pages, solicitation set) open plain read transactions, and then the one write.
    expect(readOnly.filter((value) => value === 'on')).toHaveLength(3);
    expect(readOnly.filter((value) => value === 'off')).toHaveLength(4);
    const after = await snapshot(tenant);
    // No credit, bid, job or status change; nothing queued.
    expect(after.credits).toEqual(before.credits);
    expect(after.bids).toEqual(before.bids);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.amendments.map((row) => [row.id, row.status, row.amendmentNo]))
      .toEqual(before.amendments.map((row) => [row.id, row.status, row.amendmentNo]));
    expect(enqueued).toEqual([]);

    const added = after.rows.filter((row) => row.documentId === amd2!.documentId).sort((x, y) => x.reqId.localeCompare(y.reqId));
    // Req ids continue the bid's: C.3.1 had -01 and -03.
    expect(added.map((row) => [row.reqId, row.amendmentNo, row.quoteVerified, row.origin, row.supersedeStatus])).toEqual([
      ['C.3.1-04', 2, true, 'ai', 'active'],
      ['C.3.5-01', 2, true, 'ai', 'active'],
    ]);
    const [replacement, visitorLog] = added;
    expect(replacement).toMatchObject({ instrRef: 'L.4', evalRef: 'M.2', responseSection: '3.1', sourcePage: 1 });
    expect(visitorLog).toMatchObject({ instrRef: 'L.9', evalRef: null });

    const rowById = new Map(after.rows.map((row) => [row.id, row]));
    expect(rowById.get(a)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: replacement.id, changedByAmendment: 2 });
    expect(rowById.get(b)).toMatchObject({ supersedeStatus: 'withdrawn', supersededByRowId: null, changedByAmendment: 2 });

    expect(linksOf(after, amd2!.amendmentId)).toEqual([
      // The pre-#22 add link is kept as it was; the new C.3.5 row gets its own add link.
      ['add', null, null, 'auto', null, null],
      ['add', null, visitorLog.id, 'auto', null, null],
      ['supersede', a, replacement.id, 'auto', 1, 'C.3.1 is revised to read'],
      ['withdraw', b, null, 'auto', 1, 'C.3.4 Monthly report is deleted'],
    ].sort());
    // The pre-#22 links kept their ids: they were filled, not replaced.
    const oldIds = before.links.map((item) => item.id);
    expect(after.links.filter((item) => oldIds.includes(item.id))).toHaveLength(oldIds.length);

    expect(after.hits.filter((hit) => hit.documentId === amd2!.documentId).map((hit) => hit.sentence)).toEqual(['Offerors shall acknowledge this amendment.']);
    expect(after.runs.filter((item) => item.task === 'amendment_backfill')).toHaveLength(1);
    const audit = after.audit.filter((item) => item.action === 'amendment_backfill');
    expect(audit.map((item) => item.targetId)).toEqual([amd2!.amendmentId]);
    const addLink = after.links.find((item) => item.newRowId === visitorLog.id)!;
    const filled = before.links.filter((item) => item.amendmentId === amd2!.amendmentId && item.action !== 'add').map((item) => item.id).sort();
    expect(audit[0].detail).toMatchObject({
      documentId: amd2!.documentId,
      amendmentNo: 2,
      insertedRowIds: expect.arrayContaining([replacement.id, visitorLog.id]),
      addLinkIds: [addLink.id],
      filledLinkIds: filled,
      pointedRows: [{ rowId: a, prevChangedByAmendment: 2 }],
    });
    // The diff was offered the rows the amendment's own links name, not the bid's other active rows.
    expect(ai.diffInputs.map((input) => input.existing.map((row) => row.id).sort())).toEqual([[a, b].sort()]);

    const applied = lineOf(amd2!.amendmentId);
    for (const part of ['mode=apply', 'result=backfilled', 'rows_inserted=2', 'links_paired=1', 'add_links=1', 'quotes_filled=2',
      'pointers_set=1', 'proposals_unpaired=0']) {
      expect(applied).toContain(part);
    }
  });

  describe('proposals', () => {
    it('a proposal is paired at any confidence (0.6 here), stays proposed, and can then be confirmed', async () => {
      const { tenant, c, amd3 } = await setup('bf-proposal', { amd2: false, amd3: 'needs_confirmation' });
      expect(await run([tenant.orgId], { apply: true })).toMatchObject({ backfilled: 1 });
      const after = await snapshot(tenant);
      const [escalation] = after.rows.filter((row) => row.documentId === amd3!.documentId);
      // Not an applied replacement: no references inherited, no pointer, C still active.
      expect(escalation).toMatchObject({ reqId: 'C.3.1-04', amendmentNo: 3, supersedeStatus: 'active', instrRef: null });
      expect(after.rows.find((row) => row.id === c)).toMatchObject({ supersedeStatus: 'active', supersededByRowId: null, changedByAmendment: null });
      expect(linksOf(after, amd3!.amendmentId)).toEqual([
        ['supersede', c, escalation.id, 'proposed', 1, 'C.3.1 escalation is revised to read'],
      ]);
      expect(after.amendments.find((row) => row.id === amd3!.amendmentId)!.status).toBe('needs_confirmation');
      expect(lineOf(amd3!.amendmentId)).toContain('proposals_unpaired=0');

      // The proposal that was not confirmable before (no new row) can be confirmed now.
      const proposal = after.links.find((item) => item.amendmentId === amd3!.amendmentId)!;
      const confirmed = await as(app, tenant.token)('POST', `/api/amendment-links/${proposal.id}/confirm`);
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toMatchObject({ status: 'confirmed', amendmentStatus: 'applied' });
      const [closed] = await withOrg(tenant.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.id, c)));
      expect(closed).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: escalation.id, changedByAmendment: 3 });
    });

    it('a proposal the diff finds no quoted supersede for stays unpaired and is counted', async () => {
      const { tenant, c, amd3 } = await setup('bf-proposal-none', { amd2: false, amd3: 'needs_confirmation' });
      ai.diff = async () => ({ links: [], dropped: 0, tokensUsed: 1 });
      expect(await run([tenant.orgId], { apply: true })).toMatchObject({ backfilled: 1 });
      const after = await snapshot(tenant);
      const [escalation] = after.rows.filter((row) => row.documentId === amd3!.documentId);
      expect(linksOf(after, amd3!.amendmentId)).toEqual([
        ['add', null, escalation.id, 'auto', null, null],
        ['supersede', c, null, 'proposed', null, null],
      ].sort());
      expect(lineOf(amd3!.amendmentId)).toContain('proposals_unpaired=1');
    });

    it('a link confirm racing the backfill on one bid: no deadlock, the confirm sees the paired row', async () => {
      const { tenant, c, amd3 } = await setup('bf-confirm-race', { amd2: false, amd3: 'needs_confirmation' });
      const [proposal] = await withOrg(tenant.orgId, (db) => db.select().from(schema.amendmentLinks)
        .where(eq(schema.amendmentLinks.amendmentId, amd3!.amendmentId)));
      const { waiting, results } = await raceInOrder(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId], [
        () => run([tenant.orgId], { apply: true }),
        () => as(app, tenant.token)('POST', `/api/amendment-links/${proposal.id}/confirm`),
      ]);
      expect(waiting).toBe(2);
      expect((fulfilled(results[0]) as Report).backfilled).toBe(1);
      const confirmed = fulfilled(results[1]) as Reply;
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const [escalation] = await rowsOfDoc(tenant, amd3!.documentId);
      const [closed] = await withOrg(tenant.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.id, c)));
      expect(closed).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: escalation.id });
    });
  });

  describe('pairing', () => {
    it('an auto supersede the diff scores below the threshold is not paired: no pointer, and the row gets an add link', async () => {
      const { tenant, a, amd2 } = await setup('bf-low');
      const original = ai.diff!;
      ai.diff = async (input) => {
        const result = await original(input) as { links: DiffLink[] };
        return { ...result, links: result.links.map((item) => (item.action === 'supersede' ? { ...item, confidence: 0.6 } : item)) };
      };
      await run([tenant.orgId], { apply: true });
      const after = await snapshot(tenant);
      const added = after.rows.filter((row) => row.documentId === amd2!.documentId).sort((x, y) => x.reqId.localeCompare(y.reqId));
      expect(added).toHaveLength(2);
      // No inheritance from A either.
      expect(added[0]).toMatchObject({ reqId: 'C.3.1-04', instrRef: null });
      expect(after.rows.find((row) => row.id === a)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: null });
      const links = linksOf(after, amd2!.amendmentId);
      expect(links).toContainEqual(['supersede', a, null, 'auto', null, null]);
      expect(links.filter((item) => item[0] === 'add' && item[2] !== null)).toHaveLength(2);
      expect(lineOf(amd2!.amendmentId)).toContain('links_paired=0');
      expect(lineOf(amd2!.amendmentId)).toContain('pointers_set=0');
    });

    it('honours an app_settings threshold override', async () => {
      const { tenant, a, b, amd2 } = await setup('bf-threshold');
      const db = getDb();
      await db.insert(schema.appSettings).values({ key: SETTING_AMENDMENT_LINK_CONFIDENCE, value: '0.99' })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: '0.99', updatedAt: new Date() } });
      try {
        await run([tenant.orgId], { apply: true });
      } finally {
        await db.update(schema.appSettings).set({ value: '0.80', updatedAt: new Date() })
          .where(eq(schema.appSettings.key, SETTING_AMENDMENT_LINK_CONFIDENCE));
      }
      const after = await snapshot(tenant);
      // 0.95 and 0.90 are below 0.99: nothing paired, no quotes filled.
      expect(after.rows.find((row) => row.id === a)).toMatchObject({ supersededByRowId: null });
      const links = linksOf(after, amd2!.amendmentId);
      expect(links).toContainEqual(['supersede', a, null, 'auto', null, null]);
      expect(links).toContainEqual(['withdraw', b, null, 'auto', null, null]);
      expect(lineOf(amd2!.amendmentId)).toContain('quotes_filled=0');
    });

    it('a rejected supersede is paired at the threshold, but its old row stays active with no pointer and gives no references', async () => {
      const { tenant, a, amd2 } = await setup('bf-rejected');
      await withOrg(tenant.orgId, async (db) => {
        await db.update(schema.amendmentLinks).set({ status: 'rejected' }).where(and(
          eq(schema.amendmentLinks.amendmentId, amd2!.amendmentId), eq(schema.amendmentLinks.action, 'supersede'),
        ));
        await db.update(schema.complianceRows).set({ supersedeStatus: 'active', changedByAmendment: null }).where(eq(schema.complianceRows.id, a));
      });
      await run([tenant.orgId], { apply: true });
      const after = await snapshot(tenant);
      const [replacement] = after.rows.filter((row) => row.documentId === amd2!.documentId).sort((x, y) => x.reqId.localeCompare(y.reqId));
      expect(replacement).toMatchObject({ reqId: 'C.3.1-04', instrRef: null, supersedeStatus: 'active' });
      expect(after.rows.find((row) => row.id === a)).toMatchObject({ supersedeStatus: 'active', supersededByRowId: null, changedByAmendment: null });
      const links = linksOf(after, amd2!.amendmentId);
      expect(links).toContainEqual(['supersede', a, replacement.id, 'rejected', 1, 'C.3.1 is revised to read']);
      // Paired, so the replacement gets no add link of its own.
      expect(links.some((item) => item[0] === 'add' && item[2] === replacement.id)).toBe(false);
    });

    it('several old rows paired to one new row: both point at it, and it inherits from the highest-confidence one', async () => {
      const { tenant, a, d, amd2 } = await setup('bf-many');
      await withOrg(tenant.orgId, async (db) => {
        await db.update(schema.complianceRows).set({ supersedeStatus: 'superseded', changedByAmendment: 2 }).where(eq(schema.complianceRows.id, d));
        await db.insert(schema.amendmentLinks).values({
          orgId: tenant.orgId, amendmentId: amd2!.amendmentId, rowTable: 'compliance_rows', oldRowId: d, action: 'supersede', confidence: '0.90', status: 'auto',
        });
      });
      ai.extract = async () => extracted([newRow('C.3.1', 'The contractor shall staff the help desk from 7 to 7.')]);
      ai.diff = async ({ existing }) => {
        const id = (reqId: string) => existing.find((row) => row.reqId === reqId)?.id ?? null;
        return {
          links: [
            link({ newIndex: 0, oldRowId: id('C.3.1-01'), confidence: 0.85 }),
            link({ newIndex: 0, oldRowId: id('C.3.2-01'), confidence: 0.95, sourceQuote: 'C.3.2 hours are revised to read' }),
          ],
          dropped: 0,
          tokensUsed: 3,
        };
      };
      await run([tenant.orgId], { apply: true });
      const after = await snapshot(tenant);
      const [replacement] = after.rows.filter((row) => row.documentId === amd2!.documentId);
      // D (0.95, instrRef L.7) wins over A (0.85, instrRef L.4); A still gives evalRef, which D lacks.
      expect(replacement).toMatchObject({ instrRef: 'L.7', evalRef: 'M.2', responseSection: '3.1' });
      expect(after.rows.find((row) => row.id === a)).toMatchObject({ supersededByRowId: replacement.id });
      expect(after.rows.find((row) => row.id === d)).toMatchObject({ supersededByRowId: replacement.id });
      expect(lineOf(amd2!.amendmentId)).toContain('links_paired=2');
      expect(lineOf(amd2!.amendmentId)).toContain('pointers_set=2');
      expect(lineOf(amd2!.amendmentId)).toContain('add_links=0');
    });
  });

  it('a second run, dry or apply, is a no-op: nothing written, no model call', async () => {
    const fixture = await setup('bf-again');
    await run([fixture.tenant.orgId], { apply: true });
    const before = await snapshot(fixture.tenant);
    ai.calls = { extract: 0, diff: 0, map: 0 };
    lines = [];
    expect(await run([fixture.tenant.orgId])).toMatchObject({ eligible: 0, skipped: 1 });
    expect(await run([fixture.tenant.orgId], { apply: true })).toMatchObject({ eligible: 0, backfilled: 0, skipped: 1, failed: 0 });
    expect(await snapshot(fixture.tenant)).toEqual(before);
    expect(ai.calls).toEqual({ extract: 0, diff: 0, map: 0 });
    expect(lines.filter((line) => line.includes('amendment=')).every((line) => line.includes('reason="already backfilled"'))).toBe(true);
  });

  it('two amendments revising the same clause: the earlier is skipped while a later one is applied or processing, so no duplicate rows', async () => {
    // Amd 2 (pre-#22) revised C.3.1; Amd 3, applied after #22, revised it again and inserted R3.
    const applied = await setup('bf-dup-applied', { amd3: 'applied' });
    await withOrg(applied.tenant.orgId, async (db) => {
      await db.insert(schema.complianceRows).values({
        orgId: applied.tenant.orgId, bidId: applied.tenant.bidId, documentId: applied.amd3!.documentId, reqId: 'C.3.1-04', sectionRef: 'C.3.1',
        requirementText: 'The contractor shall staff the help desk from 6 to 8.', amendmentNo: 3, origin: 'ai', supersedeStatus: 'active',
      });
    });
    const processing = await setup('bf-dup-processing', { amd3: 'processing' });
    const before = [await snapshot(applied.tenant), await snapshot(processing.tenant)];
    const report = await run([applied.tenant.orgId, processing.tenant.orgId], { apply: true });
    expect(report).toMatchObject({ eligible: 0, backfilled: 0, skipped: 4 });
    expect([await snapshot(applied.tenant), await snapshot(processing.tenant)]).toEqual(before);
    expect(ai.calls.extract).toBe(0);
    for (const fixture of [applied, processing]) {
      expect(lineOf(fixture.amd2!.amendmentId)).toContain('reason="later amendment 3 exists; rows could duplicate"');
    }
    expect(lineOf(applied.amd3!.amendmentId)).toContain('reason="already has rows from its text"');
    expect(lineOf(processing.amd3!.amendmentId)).toContain('reason="status is processing"');
    // Still one active amendment row for C.3.1 on the applied bid: Amd 3's.
    const active = (await snapshot(applied.tenant)).rows.filter((row) => row.sectionRef === 'C.3.1' && row.supersedeStatus === 'active' && row.amendmentNo > 0);
    expect(active.map((row) => row.amendmentNo)).toEqual([3]);
  });

  it('skips a deleted amendment, a bid without a consumed credit, a moved bid key, one in processing, and anything the post-#22 run wrote', async () => {
    const deleted = await setup('bf-skip-deleted', { amd3: 'needs_confirmation' });
    await withOrg(deleted.tenant.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' })
      .where(eq(schema.documents.id, deleted.amd2!.documentId)));
    const released = await setup('bf-skip-credit');
    await withOrg(released.tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'released' })
      .where(eq(schema.bids.id, released.tenant.bidId)));
    const moved = await setup('bf-skip-key');
    await withOrg(moved.tenant.orgId, (db) => db.update(schema.bids).set({ solicitationNumber: 'W912-24-R-0002', solicitationKey: 'W91224R0002' })
      .where(eq(schema.bids.id, moved.tenant.bidId)));
    const processing = await setup('bf-skip-processing', { amd2: 'processing' });
    const withRows = await setup('bf-skip-rows');
    await withOrg(withRows.tenant.orgId, (db) => db.insert(schema.complianceRows).values({
      orgId: withRows.tenant.orgId, bidId: withRows.tenant.bidId, documentId: withRows.amd2!.documentId, reqId: 'C.3.9-01',
      requirementText: 'Added by the post-#22 run', amendmentNo: 2, origin: 'ai', supersedeStatus: 'active',
    }));
    const quoted = await setup('bf-skip-quoted', { amd2: false, amd3: 'needs_confirmation' });
    await withOrg(quoted.tenant.orgId, (db) => db.update(schema.amendmentLinks).set({ sourceQuote: 'C.3.1 escalation is revised to read', sourcePage: 1 })
      .where(eq(schema.amendmentLinks.amendmentId, quoted.amd3!.amendmentId)));
    const withHits = await setup('bf-skip-hits');
    await withOrg(withHits.tenant.orgId, (db) => db.insert(schema.checkThese).values({
      orgId: withHits.tenant.orgId, bidId: withHits.tenant.bidId, documentId: withHits.amd2!.documentId, sentence: 'Offerors shall acknowledge.', pageNo: 1,
    }));
    const noLinks = await setup('bf-skip-nolinks');
    await withOrg(noLinks.tenant.orgId, (db) => db.delete(schema.amendmentLinks).where(eq(schema.amendmentLinks.amendmentId, noLinks.amd2!.amendmentId)));

    const untouched = [released, moved, processing, withRows, quoted, withHits, noLinks];
    const before = await Promise.all(untouched.map((item) => snapshot(item.tenant)));
    const report = await run([deleted, ...untouched].map((item) => item.tenant.orgId), { apply: true });
    // Only the deleted tenant's Amd 3 is eligible (a deleted Amd 2 does not hold it back).
    expect(report).toMatchObject({ eligible: 1, backfilled: 1, skipped: 8, failed: 0 });
    expect(lineOf(deleted.amd2!.amendmentId)).toContain('reason="document deleted"');
    expect(lineOf(deleted.amd3!.amendmentId)).toContain('result=backfilled');
    expect(lineOf(released.amd2!.amendmentId)).toContain('reason="bid credit is released, not consumed"');
    expect(lineOf(moved.amd2!.amendmentId)).toContain('reason="bid key changed since the key check"');
    expect(lineOf(processing.amd2!.amendmentId)).toContain('reason="status is processing"');
    expect(lineOf(withRows.amd2!.amendmentId)).toContain('reason="already has rows from its text"');
    expect(lineOf(quoted.amd3!.amendmentId)).toContain('reason="links written by the post-#22 run"');
    expect(lineOf(withHits.amd2!.amendmentId)).toContain('reason="check these written by the post-#22 run"');
    expect(lineOf(noLinks.amd2!.amendmentId)).toContain('reason="no links; cannot tell pre/post-#22"');
    expect(await Promise.all(untouched.map((item) => snapshot(item.tenant)))).toEqual(before);
    expect(await rowsOfDoc(deleted.tenant, deleted.amd2!.documentId)).toHaveLength(0);
  });

  it('a live write landing between the pre-read and the lock is caught under the lock: nothing more is written', async () => {
    const { tenant, amd2 } = await setup('bf-between');
    ai.afterExtract = async () => {
      await withOrg(tenant.orgId, (db) => db.insert(schema.complianceRows).values({
        orgId: tenant.orgId, bidId: tenant.bidId, documentId: amd2!.documentId, reqId: 'C.3.9-01',
        requirementText: 'Written meanwhile', amendmentNo: 2, origin: 'ai', supersedeStatus: 'active',
      }));
    };
    expect(await run([tenant.orgId], { apply: true })).toMatchObject({ eligible: 1, backfilled: 0, skipped: 1, failed: 0 });
    expect(lineOf(amd2!.amendmentId)).toContain('reason="already has rows from its text"');
    expect((await rowsOfDoc(tenant, amd2!.documentId)).map((row) => row.reqId)).toEqual(['C.3.9-01']);
    expect((await snapshot(tenant)).audit.filter((item) => item.action === 'amendment_backfill')).toEqual([]);
  });

  it('tenant isolation: only the organizations named are read or written, and --bid of another organization finds nothing', async () => {
    const mine = await setup('bf-iso-mine');
    const theirs = await setup('bf-iso-theirs');
    const theirsBefore = await snapshot(theirs.tenant);
    // Their bid named under my organization: row-level security shows nothing.
    expect(await run([mine.tenant.orgId], { apply: true, bidId: theirs.tenant.bidId })).toMatchObject({ eligible: 0, skipped: 0, backfilled: 0 });
    expect(lines.some((line) => line.includes('amendment='))).toBe(false);
    expect(await run([mine.tenant.orgId], { apply: true })).toMatchObject({ backfilled: 1 });
    expect(await snapshot(theirs.tenant)).toEqual(theirsBefore);
    expect(lines.filter((line) => line.includes('amendment=')).every((line) => line.includes(`org=${mine.tenant.orgId}`))).toBe(true);
    expect(lines.some((line) => line.includes(theirs.tenant.orgId))).toBe(false);
    // The diff never saw their rows, and pd_app under my organization cannot see them at all.
    const theirRows = new Set(theirsBefore.rows.map((row) => row.id));
    expect(ai.diffInputs.flatMap((input) => input.existing).some((row) => theirRows.has(row.id))).toBe(false);
    const visible = await withOrg(mine.tenant.orgId, (db) => db.select({ id: schema.complianceRows.id }).from(schema.complianceRows)
      .where(inArray(schema.complianceRows.id, [...theirRows])));
    expect(visible).toEqual([]);
  });

  it('--bid and --limit narrow the run', async () => {
    const fixture = await setup('bf-limit');
    const other = await setup('bf-limit-other');
    expect(await run([fixture.tenant.orgId, other.tenant.orgId], { apply: true, bidId: fixture.tenant.bidId, limit: 1 }))
      .toMatchObject({ eligible: 1, backfilled: 1 });
    expect((await snapshot(other.tenant)).audit.filter((item) => item.action === 'amendment_backfill')).toEqual([]);
    expect(await run([fixture.tenant.orgId, other.tenant.orgId], { apply: true, limit: 1 })).toMatchObject({ backfilled: 1, skipped: 1 });
    expect((await snapshot(other.tenant)).audit.filter((item) => item.action === 'amendment_backfill')).toHaveLength(1);
  });

  it('a model failure leaves that amendment untouched, is reported, and the next amendment still runs', async () => {
    const failing = await setup('bf-fail');
    const next = await setup('bf-fail-next');
    const before = await snapshot(failing.tenant);
    const original = ai.extract!;
    ai.extract = async (text) => {
      if (text.includes(failing.tenant.orgId)) {
        throw new Error('provider down');
      }
      return original(text);
    };
    expect(await run([failing.tenant.orgId, next.tenant.orgId], { apply: true })).toMatchObject({ eligible: 2, backfilled: 1, failed: 1 });
    const failed = lineOf(failing.amd2!.amendmentId);
    expect(failed).toContain('result=failed');
    expect(failed).toContain('provider down');
    // No failed job row, no status change: the amendment is as it was, and the backfill can run again.
    expect(await snapshot(failing.tenant)).toEqual(before);
    expect(lineOf(next.amd2!.amendmentId)).toContain('result=backfilled');
  });

  it('two concurrent backfills of one amendment write one row set: the second sees the first and skips', async () => {
    const fixture = await setup('bf-race');
    const { waiting, results } = await raceInOrder(fixture.tenant.orgId, 'select id from bids where id = $1 for update', [fixture.tenant.bidId], [
      () => run([fixture.tenant.orgId], { apply: true }),
      () => run([fixture.tenant.orgId], { apply: true }),
    ]);
    expect(waiting).toBe(2);
    const reports = results.map((result) => fulfilled(result) as Report);
    expect(reports.map((item) => item.backfilled).sort()).toEqual([0, 1]);
    expect(reports.find((item) => item.backfilled === 0)).toMatchObject({ skipped: 1, failed: 0 });
    expect(await rowsOfDoc(fixture.tenant, fixture.amd2!.documentId)).toHaveLength(2);
  });

  it('queues behind a holder of the amendment row (the live write and link confirm take it), then writes', async () => {
    const fixture = await setup('bf-lock');
    const { waiting, results } = await raceInOrder(fixture.tenant.orgId, 'select id from amendments where id = $1 for update', [fixture.amd2!.amendmentId], [
      () => run([fixture.tenant.orgId], { apply: true }),
    ]);
    expect(waiting).toBe(1);
    expect(fulfilled(results[0])).toMatchObject({ backfilled: 1 });
  });

  describe('planBackfill', () => {
    const ids = (() => {
      let n = 0;
      return () => `new-${++n}`;
    })();
    it('pairs at the threshold, a proposal at any quoted confidence, fills quotes, and adds the rest', () => {
      const plan = backfill.planBackfill(
        [
          { id: 'l1', action: 'supersede', status: 'auto', oldRowId: 'A', newRowId: null, sourceQuote: null },
          { id: 'l2', action: 'withdraw', status: 'auto', oldRowId: 'B', newRowId: null, sourceQuote: null },
          { id: 'l3', action: 'supersede', status: 'confirmed', oldRowId: 'C', newRowId: null, sourceQuote: 'kept quote' },
          { id: 'l4', action: 'supersede', status: 'auto', oldRowId: 'D', newRowId: 'already', sourceQuote: null },
          { id: 'l5', action: 'add', status: 'auto', oldRowId: null, newRowId: null, sourceQuote: null },
          { id: 'l6', action: 'supersede', status: 'proposed', oldRowId: 'E', newRowId: null, sourceQuote: null },
          { id: 'l7', action: 'withdraw', status: 'proposed', oldRowId: 'F', newRowId: null, sourceQuote: null },
        ],
        [newRow('C.3.1', 'one'), newRow('C.3.2', 'two'), newRow('C.3.3', 'three'), newRow('C.3.4', 'four')],
        [
          link({ newIndex: 0, oldRowId: 'A', confidence: 0.85, sourceQuote: 'quote low' }),
          link({ newIndex: 1, oldRowId: 'A', confidence: 0.95, sourceQuote: 'quote high' }),
          link({ action: 'withdraw', newIndex: null, oldRowId: 'B', confidence: 0.9, sourceQuote: 'B is deleted' }),
          // Below the threshold for a confirmed link: not paired.
          link({ newIndex: 2, oldRowId: 'C', confidence: 0.5 }),
          // A row the amendment's links do not name: ignored.
          link({ newIndex: 2, oldRowId: 'Z', confidence: 0.99 }),
          // A link that already has its row is never re-paired.
          link({ newIndex: 2, oldRowId: 'D', confidence: 0.99 }),
          // A proposal: any confidence, as long as it is quoted.
          link({ newIndex: 3, oldRowId: 'E', confidence: 0.3, sourceQuote: 'E is revised' }),
          link({ action: 'withdraw', newIndex: null, oldRowId: 'F', confidence: 0.2, sourceQuote: 'F is struck' }),
        ],
        0.8,
        ids,
      );
      const [one, two, three, four] = plan.inserts.map((row) => row.id);
      expect(plan.pairs).toEqual([
        { linkId: 'l1', oldRowId: 'A', newRowId: two, confidence: 0.95, sourcePage: 1, sourceQuote: 'quote high' },
        { linkId: 'l6', oldRowId: 'E', newRowId: four, confidence: 0.3, sourcePage: 1, sourceQuote: 'E is revised' },
      ]);
      expect(plan.quoteFills).toEqual([
        { linkId: 'l2', sourcePage: 1, sourceQuote: 'B is deleted' },
        { linkId: 'l7', sourcePage: 1, sourceQuote: 'F is struck' },
      ]);
      expect(plan.addRowIds).toEqual([one, three]);
    });
  });
});

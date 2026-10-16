/**
 * Amendment step 8 (04 s3.1, PR5) across the worker and the api, against the real database: the
 * worker's ai:amendment-tabs step (apps/worker/src/amendment-tabs-job.ts) with the bid-summary
 * model call mocked, the supersede rules (packages/core amendment-tabs.ts) for real, the schedule
 * tab's proposals and pendingDateChange, link confirm and reject, and /schedule/adjust answering
 * an amendment's date change.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { as, createTenant, type Tenant } from './helpers.js';
import { fulfilled, raceInOrder } from './races.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const enqueued = vi.hoisted(() => [] as { name: string; documentId: string; bullId: string | undefined }[]);
const queue = vi.hoisted(() => ({ fail: null as null | string }));
vi.mock('../../worker/src/enqueue.js', () => ({
  enqueue: vi.fn(async (name: string, payload: { documentId: string }, options?: { jobId?: string }) => {
    if (queue.fail === name) {
      throw new Error('redis down');
    }
    enqueued.push({ name, documentId: payload.documentId, bullId: options?.jobId });
  }),
}));

type Fact = { field: string; value: string; sourceQuote: string; sourcePage?: number };
const ai = vi.hoisted(() => ({ facts: [] as Fact[], fail: false, calls: 0 }));
vi.mock('@pd/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pd/ai')>();
  return {
    ...original,
    loadSkill: () => ({ name: 'bid-summary', version: '1' }),
    buildSystemPrompt: () => 'Extract bid facts.',
    getProvider: () => ({
      complete: async () => {
        ai.calls += 1;
        if (ai.fail) {
          throw new Error('provider down');
        }
        return { json: { facts: ai.facts }, usage: { totalTokens: 7 } };
      },
    }),
  };
});

const unavailable = inject('dbUnavailable');
const BID_NUMBER = 'W912-24-R-0001';
const BID_KEY = 'W91224R0001';
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

type Payload = { orgId: string; bidId: string; documentId: string; jobId: string; storagePath: string; kind: 'amendment' };

describe.skipIf(Boolean(unavailable))('amendment step 8: bid facts and dates', () => {
  let app: FastifyInstance;
  let tabs: typeof import('../../worker/src/amendment-tabs-job.js');
  let aiJobs: typeof import('../../worker/src/ai-jobs.js');
  let classify: typeof import('../../worker/src/classify-job.js');

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-amendtabs-'));
    getPool({ connectionString: inject('appUrl'), max: 10 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    tabs = await import('../../worker/src/amendment-tabs-job.js');
    aiJobs = await import('../../worker/src/ai-jobs.js');
    classify = await import('../../worker/src/classify-job.js');
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  beforeEach(() => {
    enqueued.length = 0;
    queue.fail = null;
    ai.fail = false;
    ai.calls = 0;
    ai.facts = [
      { field: 'agency', value: 'Department of the Navy', sourceQuote: 'The issuing agency is the Department of the Navy', sourcePage: 1 },
      // The same NAICS again: a restatement, not written.
      { field: 'naics', value: '541511', sourceQuote: 'NAICS 541511', sourcePage: 1 },
      { field: 'bidType', value: 'federal', sourceQuote: 'Amendment No.', sourcePage: 1 },
      // A quote that is not on the amendment's pages: dropped.
      { field: 'contractingOfficer', value: 'Pat Smith', sourceQuote: 'Contracting Officer Pat Smith signs here', sourcePage: 1 },
    ];
  });

  interface Fixture { tenant: Tenant; agency: string; naics: string; due: string; questions: string; draft: string }

  /**
   * A tenant whose bid holds a consumed credit and is due 2026-12-15, with the solicitation's AI
   * facts (agency, naics) and dates (the proposal due date, locked; the questions date), and an
   * unlocked user activity.
   */
  async function setup(label: string): Promise<Fixture> {
    const tenant = await createTenant(app, label);
    return withOrg(tenant.orgId, async (db) => {
      await db.update(schema.bids).set({
        creditStatus: 'consumed', solicitationNumber: BID_NUMBER, solicitationKey: BID_KEY, dueDate: day('2026-12-15'),
      }).where(eq(schema.bids.id, tenant.bidId));
      const base = { orgId: tenant.orgId, bidId: tenant.bidId, documentId: tenant.documentId, origin: 'ai' as const, quoteVerified: true };
      const [agency] = await db.insert(schema.bidFacts).values({
        ...base, field: 'agency', value: 'Department of the Army', factKey: 'agency', sourcePage: 1, sourceQuote: 'Department of the Army',
      }).returning();
      const [naics] = await db.insert(schema.bidFacts).values({
        ...base, field: 'naics', value: '541511', factKey: 'naics', sourcePage: 1, sourceQuote: 'NAICS 541511',
      }).returning();
      const [due] = await db.insert(schema.scheduleActivities).values({
        ...base, label: 'Proposal due', kind: 'submission', dateKey: 'proposal_due', locked: true,
        startDate: day('2026-12-15'), endDate: day('2026-12-15'), sourcePage: 3, sourceQuote: 'Proposals are due 2026-12-15.',
      }).returning();
      const [questions] = await db.insert(schema.scheduleActivities).values({
        ...base, label: 'Questions due', kind: 'milestone', dateKey: 'questions_due', locked: true,
        startDate: day('2026-11-01'), endDate: day('2026-11-01'), sourcePage: 3, sourceQuote: 'Questions are due 2026-11-01.',
      }).returning();
      const [draft] = await db.insert(schema.scheduleActivities).values({
        orgId: tenant.orgId, bidId: tenant.bidId, label: 'Draft', kind: 'writing', origin: 'template',
        startDate: day('2026-12-01'), endDate: day('2026-12-01'),
      }).returning();
      return { tenant, agency: agency.id, naics: naics.id, due: due.id, questions: questions.id, draft: draft.id };
    });
  }

  const PAGE = (amendmentNo: number, dueText = 'Proposals are due December 22, 2026.') => [
    `Solicitation No. ${BID_NUMBER}`,
    `Amendment No. ${amendmentNo}`,
    'The issuing agency is the Department of the Navy.',
    'NAICS 541511.',
    dueText,
    'Questions are due November 1, 2026.',
  ].join('\n');

  /** An amendment document whose compliance apply is done: applied, step 8 pending. */
  async function amendment(tenant: Tenant, amendmentNo: number, text = PAGE(amendmentNo)): Promise<string> {
    return withOrg(tenant.orgId, async (db) => {
      const [document] = await db.insert(schema.documents).values({
        orgId: tenant.orgId, bidId: tenant.bidId, fileName: `amendment-${amendmentNo}.pdf`, mime: 'application/pdf', sizeBytes: 5,
        sha256: randomUUID(), kind: 'amendment', storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live', amendmentNo, amendmentNoSource: 'user',
      }).returning();
      await db.insert(schema.pages).values({ orgId: tenant.orgId, documentId: document.id, pageNo: 1, text, sectionTag: 'other' });
      await db.insert(schema.amendments).values({
        orgId: tenant.orgId, bidId: tenant.bidId, documentId: document.id, amendmentNo, solicitationKeyFound: true,
        status: 'applied', tabsStatus: 'pending', matchedKey: BID_KEY,
      });
      return document.id;
    });
  }

  const payload = (tenant: Tenant, documentId: string): Payload => ({
    orgId: tenant.orgId, bidId: tenant.bidId, documentId, jobId: randomUUID(), storagePath: '', kind: 'amendment',
  });
  const run = (tenant: Tenant, documentId: string) => tabs.processAmendmentTabsJob(payload(tenant, documentId));
  const factsOf = (tenant: Tenant) => withOrg(tenant.orgId, (db) => db.select().from(schema.bidFacts).where(eq(schema.bidFacts.bidId, tenant.bidId)));
  const datesOf = (tenant: Tenant) => withOrg(tenant.orgId, (db) => db.select().from(schema.scheduleActivities)
    .where(eq(schema.scheduleActivities.bidId, tenant.bidId)));
  const amendmentOf = async (tenant: Tenant, documentId: string) => {
    const [row] = await withOrg(tenant.orgId, (db) => db.select().from(schema.amendments).where(eq(schema.amendments.documentId, documentId)));
    return row;
  };
  const linksOf = async (tenant: Tenant, documentId: string) => {
    const row = await amendmentOf(tenant, documentId);
    return withOrg(tenant.orgId, (db) => db.select().from(schema.amendmentLinks).where(eq(schema.amendmentLinks.amendmentId, row.id)));
  };
  const bidOf = async (tenant: Tenant) => {
    const [bid] = await withOrg(tenant.orgId, (db) => db.select().from(schema.bids).where(eq(schema.bids.id, tenant.bidId)));
    return bid;
  };
  const active = <T extends { supersedeStatus: string | null }>(rows: T[]) => rows.filter((row) => row.supersedeStatus === null || row.supersedeStatus === 'active');

  describe('supersede', () => {
    it('supersedes untouched AI facts and dates, adds others, skips restatements, records the due date change', async () => {
      const { tenant, agency, naics, due, questions, draft } = await setup('at-auto');
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');

      const facts = await factsOf(tenant);
      const added = facts.filter((fact) => fact.documentId === documentId).sort((a, b) => a.field.localeCompare(b.field));
      expect(added.map((fact) => [fact.field, fact.value, fact.factKey, fact.amendmentNo, fact.supersedeStatus, fact.quoteVerified, fact.sourcePage, fact.origin]))
        .toEqual([
          ['agency', 'Department of the Navy', 'agency', 2, 'active', true, 1, 'ai'],
          ['bidType', 'federal', 'other', 2, 'active', true, 1, 'ai'],
        ]);
      const navy = added[0];
      expect(facts.find((fact) => fact.id === agency)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: navy.id, changedByAmendment: 2 });
      expect(facts.find((fact) => fact.id === naics)).toMatchObject({ supersedeStatus: null, changedByAmendment: null });

      const dates = await datesOf(tenant);
      const newDates = dates.filter((row) => row.documentId === documentId);
      const newDue = newDates.find((row) => row.dateKey === 'proposal_due')!;
      expect(newDue).toMatchObject({
        label: 'Proposal due', kind: 'submission', locked: true, origin: 'ai', amendmentNo: 2, supersedeStatus: 'active',
        sourcePage: 1, sourceQuote: 'Proposals are due December 22, 2026.', quoteVerified: true,
      });
      expect(iso(newDue.startDate)).toBe('2026-12-22');
      expect(iso(newDue.endDate)).toBe('2026-12-22');
      // The same questions date: a restatement. The other lines carry no date.
      expect(newDates.filter((row) => row.dateKey === 'questions_due')).toEqual([]);
      expect(dates.find((row) => row.id === due)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: newDue.id, changedByAmendment: 2 });
      expect(dates.find((row) => row.id === questions)).toMatchObject({ supersedeStatus: null });
      expect(dates.find((row) => row.id === draft)).toMatchObject({ supersedeStatus: null });

      const links = await linksOf(tenant, documentId);
      const key = (link: { rowTable: string; action: string; oldRowId: string | null; newRowId: string | null; status: string }) =>
        [link.rowTable, link.action, link.oldRowId, link.newRowId, link.status].join(' ');
      expect(links.map(key).sort()).toEqual([
        ['bid_facts', 'supersede', agency, navy.id, 'auto'].join(' '),
        ['bid_facts', 'add', '', added[1].id, 'auto'].join(' '),
        ['schedule_activities', 'supersede', due, newDue.id, 'auto'].join(' '),
        ...newDates.filter((row) => row.id !== newDue.id).map((row) => ['schedule_activities', 'add', '', row.id, 'auto'].join(' ')),
      ].sort());
      expect(links.find((link) => link.oldRowId === agency)).toMatchObject({ sourcePage: 1, sourceQuote: 'The issuing agency is the Department of the Navy' });

      const record = await amendmentOf(tenant, documentId);
      expect(record).toMatchObject({ status: 'applied', tabsStatus: 'applied' });
      expect(record.datesChanged).toEqual({
        previousDue: '2026-12-15', nextDue: '2026-12-22', sourcePage: 1, sourceQuote: 'Proposals are due December 22, 2026.', resolvedAt: null,
      });
      // The worker never changes the bid's due date.
      expect(iso((await bidOf(tenant)).dueDate)).toBe('2026-12-15');
      const runs = await withOrg(tenant.orgId, (db) => db.select().from(schema.aiRuns).where(and(
        eq(schema.aiRuns.bidId, tenant.bidId), eq(schema.aiRuns.task, 'amendment-tabs'),
      )));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'completed', inputTokens: 7, skillName: 'bid-summary' });

      // The schedule tab shows the change for the prompt; both tabs list superseded rows.
      const call = as(app, tenant.token);
      const schedule = (await call('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json<{
        activities: { id: string }[]; proposals: unknown[]; pendingDateChange: unknown;
      }>();
      expect(schedule.pendingDateChange).toEqual({
        amendmentId: record.id, amendmentNo: 2, previousDue: '2026-12-15', nextDue: '2026-12-22',
        sourcePage: 1, sourceQuote: 'Proposals are due December 22, 2026.',
      });
      expect(schedule.proposals).toEqual([]);
      expect(schedule.activities.map((row) => row.id)).toEqual(expect.arrayContaining([due, newDue.id]));
      const overview = (await call('GET', `/api/bids/${tenant.bidId}/tabs/overview`)).json<{ facts: { id: string }[]; proposals: unknown[] }>();
      expect(overview.facts.map((fact) => fact.id)).toEqual(expect.arrayContaining([agency, navy.id]));
      expect(overview.proposals).toEqual([]);
      // The link list names fact and activity rows.
      const listed = (await call('GET', `/api/bids/${tenant.bidId}/amendment-links`)).json<{ oldRowId: string; oldRow: unknown; newRow: unknown }[]>();
      expect(listed.find((link) => link.oldRowId === agency)).toMatchObject({
        oldRow: { rowId: agency, label: 'agency', text: 'Department of the Army' },
        newRow: { rowId: navy.id, label: 'agency', text: 'Department of the Navy' },
      });
      expect(listed.find((link) => link.oldRowId === due)).toMatchObject({ newRow: { rowId: newDue.id, label: 'Proposal due', text: '2026-12-22' } });
    });

    it('proposes the replacement of a fact or date a user touched; insert puts it in force', async () => {
      const { tenant, agency, due } = await setup('at-touched');
      const call = as(app, tenant.token);
      // The user confirms the agency and unlocks the due date (both through the api).
      expect((await call('PATCH', `/api/bids/${tenant.bidId}/rows/bid_facts/${agency}`, { fields: { confirmed: true } })).statusCode).toBe(200);
      expect((await call('PATCH', `/api/bids/${tenant.bidId}/rows/schedule_activities/${due}`, { fields: { locked: false } })).statusCode).toBe(200);
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');

      const facts = await factsOf(tenant);
      const proposedFact = facts.find((fact) => fact.documentId === documentId && fact.field === 'agency')!;
      expect(proposedFact).toMatchObject({ supersedeStatus: 'proposed', value: 'Department of the Navy', amendmentNo: 2 });
      expect(facts.find((fact) => fact.id === agency)).toMatchObject({ supersedeStatus: null, changedByAmendment: null });
      const dates = await datesOf(tenant);
      const proposedDue = dates.find((row) => row.documentId === documentId && row.dateKey === 'proposal_due')!;
      expect(proposedDue.supersedeStatus).toBe('proposed');
      expect(dates.find((row) => row.id === due)).toMatchObject({ supersedeStatus: null });
      const record = await amendmentOf(tenant, documentId);
      // Open tab proposals keep the amendment in needs_confirmation; the due date change is still recorded.
      expect(record).toMatchObject({ status: 'needs_confirmation', tabsStatus: 'applied' });
      expect(record.datesChanged).toMatchObject({ previousDue: '2026-12-15', nextDue: '2026-12-22' });

      const links = await linksOf(tenant, documentId);
      const factLink = links.find((link) => link.newRowId === proposedFact.id)!;
      const dueLink = links.find((link) => link.newRowId === proposedDue.id)!;
      expect(factLink).toMatchObject({ action: 'supersede', oldRowId: agency, status: 'proposed', rowTable: 'bid_facts' });
      expect(dueLink).toMatchObject({ action: 'supersede', oldRowId: due, status: 'proposed', rowTable: 'schedule_activities' });

      // The tabs leave proposed rows out of their lists and offer them as proposals.
      const overview = (await call('GET', `/api/bids/${tenant.bidId}/tabs/overview`)).json<{
        facts: { id: string }[]; proposals: { linkId: string; amendmentNo: number; oldRowId: string; row: { id: string; value: string } }[];
      }>();
      expect(overview.facts.map((fact) => fact.id)).not.toContain(proposedFact.id);
      expect(overview.proposals).toEqual([expect.objectContaining({
        linkId: factLink.id, linkIds: [factLink.id], amendmentNo: 2, oldRowIds: [agency], row: expect.objectContaining({ id: proposedFact.id, value: 'Department of the Navy' }),
      })]);
      const schedule = (await call('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json<{
        activities: { id: string }[]; proposals: { linkId: string; row: { id: string } }[];
      }>();
      expect(schedule.activities.map((row) => row.id)).not.toContain(proposedDue.id);
      expect(schedule.proposals.map((proposal) => [proposal.linkId, proposal.row.id])).toEqual([[dueLink.id, proposedDue.id]]);

      // Insert the fact: it is in force and the user's row is superseded by it, with row history.
      const inserted = await call('POST', `/api/amendment-links/${factLink.id}/confirm`);
      expect(inserted.statusCode, inserted.body).toBe(200);
      expect(inserted.json()).toMatchObject({ status: 'confirmed', amendmentStatus: 'needs_confirmation' });
      const after = await factsOf(tenant);
      expect(after.find((fact) => fact.id === proposedFact.id)).toMatchObject({ supersedeStatus: 'active' });
      expect(after.find((fact) => fact.id === agency)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: proposedFact.id, changedByAmendment: 2 });
      const history = await withOrg(tenant.orgId, (db) => db.select().from(schema.rowHistory).where(eq(schema.rowHistory.rowTable, 'bid_facts')));
      expect(history.filter((row) => row.rowId === agency).map((row) => row.field).sort()).toEqual(
        expect.arrayContaining(['changed_by_amendment', 'superseded_by_row_id', 'supersede_status']),
      );
      expect(history.find((row) => row.rowId === proposedFact.id)).toMatchObject({ field: 'supersede_status', oldValue: 'proposed', newValue: 'active' });
      // Dismiss the date: the user's row stays; the proposal is gone; the amendment is applied.
      const dismissed = await call('POST', `/api/amendment-links/${dueLink.id}/reject`);
      expect(dismissed.json()).toMatchObject({ status: 'rejected', amendmentStatus: 'applied' });
      expect((await datesOf(tenant)).find((row) => row.id === due)).toMatchObject({ supersedeStatus: null });
      const later = (await call('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json<{ activities: { id: string }[]; proposals: unknown[] }>();
      expect(later.proposals).toEqual([]);
      expect(later.activities.map((row) => row.id)).not.toContain(proposedDue.id);
      // Decisions are final.
      expect((await call('POST', `/api/amendment-links/${dueLink.id}/confirm`)).statusCode).toBe(409);
    });

    it('a user fact on a key gets a proposal; deleting a proposed row rejects its proposal', async () => {
      const { tenant } = await setup('at-userfact');
      const call = as(app, tenant.token);
      const created = await call('POST', `/api/bids/${tenant.bidId}/tabs/overview/rows`, { kind: 'fact', field: 'placeOfPerformance', value: 'Norfolk, VA' });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ factKey: 'place', origin: 'user' });
      ai.facts = [{ field: 'placeOfPerformance', value: 'San Diego, CA', sourceQuote: 'The issuing agency is the Department of the Navy', sourcePage: 1 }];
      const documentId = await amendment(tenant, 2, PAGE(2, 'No date change.'));
      expect(await run(tenant, documentId)).toBe('applied');
      const proposed = (await factsOf(tenant)).find((fact) => fact.documentId === documentId)!;
      expect(proposed).toMatchObject({ supersedeStatus: 'proposed', factKey: 'place' });
      expect(await amendmentOf(tenant, documentId)).toMatchObject({ status: 'needs_confirmation', datesChanged: null });

      expect((await call('DELETE', `/api/bids/${tenant.bidId}/rows/bid_facts/${proposed.id}`)).statusCode).toBe(200);
      const [link] = (await linksOf(tenant, documentId)).filter((item) => item.rowTable === 'bid_facts');
      expect(link.status).toBe('rejected');
      expect((await amendmentOf(tenant, documentId)).status).toBe('applied');
    });

    it('a new amendment number carries to the facts and dates it wrote and the rows they replace, leaving them untouched', async () => {
      const { tenant, agency, due } = await setup('at-renumber');
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');
      const renumbered = await as(app, tenant.token)('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 5 });
      expect(renumbered.statusCode, renumbered.body).toBe(200);
      const facts = await factsOf(tenant);
      const navy = facts.find((fact) => fact.documentId === documentId && fact.factKey === 'agency')!;
      expect(navy).toMatchObject({ amendmentNo: 5, supersedeStatus: 'active' });
      expect(facts.find((fact) => fact.id === agency)).toMatchObject({ changedByAmendment: 5, supersededByRowId: navy.id });
      const dates = await datesOf(tenant);
      expect(dates.find((row) => row.documentId === documentId && row.dateKey === 'proposal_due')).toMatchObject({ amendmentNo: 5 });
      expect(dates.find((row) => row.id === due)).toMatchObject({ changedByAmendment: 5 });
      const history = await withOrg(tenant.orgId, (db) => db.select().from(schema.rowHistory).where(eq(schema.rowHistory.rowId, navy.id)));
      expect(history.map((row) => [row.field, row.oldValue, row.newValue])).toEqual([['amendment_no', '2', '5']]);
      // The renumbered AI row still counts as untouched: amendment 6 supersedes it automatically.
      const six = await amendment(tenant, 6);
      ai.facts = [{ field: 'agency', value: 'Department of the Air Force', sourceQuote: 'Amendment No. 6', sourcePage: 1 }];
      expect(await run(tenant, six)).toBe('applied');
      expect((await factsOf(tenant)).find((fact) => fact.id === navy.id)).toMatchObject({ supersedeStatus: 'superseded', changedByAmendment: 6 });
    });

    it('a solicitation-set file whose overview and dates run after step 8 writes its keyed rows already superseded', async () => {
      const { tenant } = await setup('at-late');
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');
      const late = await withOrg(tenant.orgId, async (db) => {
        const [document] = await db.insert(schema.documents).values({
          orgId: tenant.orgId, bidId: tenant.bidId, fileName: 'attachment.pdf', mime: 'application/pdf', sizeBytes: 5,
          sha256: randomUUID(), kind: 'attachment', storagePath: `docs/${randomUUID()}.pdf`, liveStatus: 'live',
        }).returning();
        await db.insert(schema.pages).values({
          orgId: tenant.orgId, documentId: document.id, pageNo: 1, text: 'Issued by the Department of the Army.\nProposals are due 2026-12-15.\nThe kickoff is 2027-01-04.',
        });
        return document.id;
      });
      ai.facts = [
        { field: 'agency', value: 'Department of the Army', sourceQuote: 'Issued by the Department of the Army', sourcePage: 1 },
        { field: 'naics', value: '541512', sourceQuote: 'Issued by the Department of the Army', sourcePage: 1 },
      ];
      const latePayload = { ...payload(tenant, documentId), documentId: late, kind: 'attachment' as const };
      await aiJobs.processOverview(latePayload);
      await aiJobs.processDates(latePayload);
      const facts = await factsOf(tenant);
      const navy = facts.find((fact) => fact.documentId === documentId && fact.factKey === 'agency')!;
      expect(facts.find((fact) => fact.documentId === late && fact.factKey === 'agency'))
        .toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: navy.id, changedByAmendment: 2, amendmentNo: 0 });
      // No amendment wrote the NAICS: the late fact is added like any other.
      expect(facts.find((fact) => fact.documentId === late && fact.factKey === 'naics')).toMatchObject({ supersedeStatus: null });
      const dates = await datesOf(tenant);
      const newDue = dates.find((row) => row.documentId === documentId && row.dateKey === 'proposal_due')!;
      expect(dates.find((row) => row.documentId === late && row.dateKey === 'proposal_due'))
        .toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: newDue.id, changedByAmendment: 2 });
      expect(dates.find((row) => row.documentId === late && row.dateKey === 'other')).toMatchObject({ supersedeStatus: null });
      expect(active(dates).filter((row) => row.dateKey === 'proposal_due').map((row) => row.id)).toEqual([newDue.id]);
    });

    it('gives the same facts and dates in force whichever amendment finishes first', async () => {
      const result = async (label: string, order: number[]) => {
        const { tenant } = await setup(label);
        const documents = new Map<number, string>();
        for (const no of [2, 3]) {
          documents.set(no, await amendment(tenant, no, PAGE(no, no === 2 ? 'Proposals are due December 22, 2026.' : 'Proposals are due 12/29/2026.')));
        }
        for (const no of order) {
          ai.facts = [{ field: 'agency', value: no === 2 ? 'Department of the Navy' : 'Department of the Air Force', sourceQuote: `Amendment No. ${no}`, sourcePage: 1 }];
          expect(await run(tenant, documents.get(no)!)).toBe('applied');
        }
        const facts = active(await factsOf(tenant)).filter((fact) => fact.factKey === 'agency').map((fact) => [fact.value, fact.amendmentNo]);
        const dues = active(await datesOf(tenant)).filter((row) => row.dateKey === 'proposal_due').map((row) => [iso(row.startDate), row.amendmentNo]);
        const changes = await Promise.all([2, 3].map(async (no) => (await amendmentOf(tenant, documents.get(no)!)).datesChanged));
        return { tenant, documents, facts, dues, changes };
      };
      const inOrder = await result('at-order', [2, 3]);
      const outOfOrder = await result('at-reverse', [3, 2]);
      expect(inOrder.facts).toEqual([['Department of the Air Force', 3]]);
      expect(outOfOrder.facts).toEqual(inOrder.facts);
      expect(inOrder.dues).toEqual([['2026-12-29', 3]]);
      expect(outOfOrder.dues).toEqual(inOrder.dues);
      // Out of order, amendment 2's rows are inserted already superseded by amendment 3's, and it
      // records no due date change: 3 put a later date in force first.
      const late = (await factsOf(outOfOrder.tenant)).find((fact) => fact.amendmentNo === 2 && fact.factKey === 'agency')!;
      const winner = (await factsOf(outOfOrder.tenant)).find((fact) => fact.amendmentNo === 3 && fact.factKey === 'agency')!;
      expect(late).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: winner.id, changedByAmendment: 3 });
      expect(outOfOrder.changes[0]).toBeNull();
      expect(outOfOrder.changes[1]).toMatchObject({ previousDue: '2026-12-15', nextDue: '2026-12-29' });
      // In order, both recorded one; the schedule tab offers the highest.
      expect(inOrder.changes[0]).toMatchObject({ previousDue: '2026-12-15', nextDue: '2026-12-22' });
      expect(inOrder.changes[1]).toMatchObject({ previousDue: '2026-12-15', nextDue: '2026-12-29' });
      const schedule = (await as(app, inOrder.tenant.token)('GET', `/api/bids/${inOrder.tenant.bidId}/tabs/schedule`))
        .json<{ pendingDateChange: { amendmentNo: number; nextDue: string } }>();
      expect(schedule.pendingDateChange).toMatchObject({ amendmentNo: 3, nextDue: '2026-12-29' });
    });
  });

  describe('exactly once', () => {
    it('reruns, duplicate jobs and two concurrent jobs write one row set', async () => {
      const { tenant } = await setup('at-once');
      const documentId = await amendment(tenant, 2);
      // Both past the pre-check and the AI call, queued on the schedule lock: exactly one writes.
      const { waiting, results } = await raceInOrder(
        tenant.orgId,
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`schedule:${tenant.bidId}`],
        [() => run(tenant, documentId), () => run(tenant, documentId)],
      );
      expect(waiting).toBe(2);
      expect(results.map((item) => fulfilled(item)).sort()).toEqual(['applied', 'stopped']);
      const facts = (await factsOf(tenant)).length;
      const dates = (await datesOf(tenant)).length;
      const links = (await linksOf(tenant, documentId)).length;
      const calls = ai.calls;
      expect(await run(tenant, documentId)).toBe('stopped');
      expect(ai.calls).toBe(calls);
      expect((await factsOf(tenant)).length).toBe(facts);
      expect((await datesOf(tenant)).length).toBe(dates);
      expect((await linksOf(tenant, documentId)).length).toBe(links);
    });

    it('a provider error fails step 8 visibly; the retry queues it again and it applies', async () => {
      const { tenant } = await setup('at-fail');
      const documentId = await amendment(tenant, 2);
      ai.fail = true;
      await expect(run(tenant, documentId)).rejects.toThrow('provider down');
      expect(await amendmentOf(tenant, documentId)).toMatchObject({ status: 'applied', tabsStatus: 'failed' });
      const [failed] = await withOrg(tenant.orgId, (db) => db.select().from(schema.jobs).where(and(
        eq(schema.jobs.documentId, documentId), eq(schema.jobs.status, 'failed'),
      )));
      expect(failed).toMatchObject({ type: 'classify', error: "The amendment's bid facts and dates could not be updated. Retry it." });
      expect((await factsOf(tenant)).filter((fact) => fact.documentId === documentId)).toEqual([]);
      // A failed step 8 never runs from a stale job.
      ai.fail = false;
      expect(await run(tenant, documentId)).toBe('stopped');

      const retried = await as(app, tenant.token)('POST', `/api/jobs/${failed.id}/retry`);
      expect(retried.statusCode, retried.body).toBe(200);
      await classify.processClassify({ ...payload(tenant, documentId), jobId: retried.json<{ id: string }>().id });
      expect(await amendmentOf(tenant, documentId)).toMatchObject({ status: 'applied', tabsStatus: 'pending' });
      expect(enqueued.filter((item) => item.name === 'ai:amendment-tabs' && item.documentId === documentId)).toHaveLength(1);
      // The compliance step is not rerun.
      expect(enqueued.filter((item) => item.name === 'ai:amendment')).toEqual([]);
      expect(await run(tenant, documentId)).toBe('applied');
      expect(await amendmentOf(tenant, documentId)).toMatchObject({ tabsStatus: 'applied' });
    });

    it('a queue failure fails step 8 with a row the user can retry', async () => {
      const { tenant } = await setup('at-queue');
      const documentId = await amendment(tenant, 2);
      queue.fail = 'ai:amendment-tabs';
      await tabs.queueAmendmentTabs(payload(tenant, documentId));
      expect(await amendmentOf(tenant, documentId)).toMatchObject({ tabsStatus: 'failed' });
      const jobs = await withOrg(tenant.orgId, (db) => db.select().from(schema.jobs).where(eq(schema.jobs.documentId, documentId)));
      expect(jobs).toEqual([expect.objectContaining({ type: 'classify', status: 'failed', error: "The amendment's bid facts and dates could not be queued. Retry it." })]);
    });

    it('fails step 8 visibly when the bid credit was released; never runs for a needs_number or deleted amendment', async () => {
      const { tenant } = await setup('at-credit');
      const documentId = await amendment(tenant, 2);
      await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'released' }).where(eq(schema.bids.id, tenant.bidId)));
      expect(await run(tenant, documentId)).toBe('stopped');
      expect(await amendmentOf(tenant, documentId)).toMatchObject({ tabsStatus: 'failed' });
      expect(ai.calls).toBe(0);

      await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'consumed' }).where(eq(schema.bids.id, tenant.bidId)));
      const deleted = await amendment(tenant, 3);
      await withOrg(tenant.orgId, (db) => db.update(schema.documents).set({ liveStatus: 'deleted' }).where(eq(schema.documents.id, deleted)));
      expect(await run(tenant, deleted)).toBe('stopped');
      const processing = await amendment(tenant, 4);
      await withOrg(tenant.orgId, (db) => db.update(schema.amendments).set({ status: 'processing' }).where(eq(schema.amendments.documentId, processing)));
      expect(await run(tenant, processing)).toBe('stopped');
      expect(ai.calls).toBe(0);
    });
  });

  describe('tenant safety', () => {
    it('a job or a call of another organization sees and changes nothing', async () => {
      const a = await setup('at-tenant-a');
      const b = await setup('at-tenant-b');
      const documentId = await amendment(a.tenant, 2);
      // A payload naming A's document under B's organization finds nothing under B's org_id.
      expect(await tabs.processAmendmentTabsJob({ ...payload(a.tenant, documentId), orgId: b.tenant.orgId, bidId: b.tenant.bidId })).toBe('stopped');
      expect(await tabs.processAmendmentTabsJob({ ...payload(a.tenant, documentId), orgId: b.tenant.orgId })).toBe('stopped');
      expect(ai.calls).toBe(0);
      expect(await amendmentOf(a.tenant, documentId)).toMatchObject({ tabsStatus: 'pending' });

      expect(await run(a.tenant, documentId)).toBe('applied');
      const amendmentId = (await amendmentOf(a.tenant, documentId)).id;
      const callB = as(app, b.tenant.token);
      // B cannot answer A's date change, on B's bid or on A's.
      expect((await callB('POST', `/api/bids/${b.tenant.bidId}/schedule/adjust`, { mode: 'keep', amendmentId })).statusCode).toBe(404);
      expect((await callB('POST', `/api/bids/${a.tenant.bidId}/schedule/adjust`, { mode: 'keep', amendmentId })).statusCode).toBe(404);
      expect((await callB('GET', `/api/bids/${b.tenant.bidId}/tabs/schedule`)).json()).toMatchObject({ pendingDateChange: null, proposals: [] });
      const [link] = await linksOf(a.tenant, documentId);
      expect((await callB('POST', `/api/amendment-links/${link.id}/confirm`)).statusCode).toBe(404);
      expect((await amendmentOf(a.tenant, documentId)).datesChanged).toMatchObject({ resolvedAt: null });
      expect(iso((await bidOf(a.tenant)).dueDate)).toBe('2026-12-15');
      // B's own rows were never touched.
      expect(active(await factsOf(b.tenant)).filter((fact) => fact.factKey === 'agency').map((fact) => fact.value)).toEqual(['Department of the Army']);
    });
  });

  describe('the date-change prompt', () => {
    it('shift with the amendmentId moves the schedule, applies the due date, and resolves the change once', async () => {
      const { tenant, due, draft, questions } = await setup('at-prompt');
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');
      const amendmentId = (await amendmentOf(tenant, documentId)).id;
      const call = as(app, tenant.token);
      const answered = await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, {
        mode: 'shift', amendmentId, workdaysOnly: false, previousDue: '2000-01-01', nextDue: '2000-01-02',
      });
      expect(answered.statusCode, answered.body).toBe(200);
      // The amendment's dates are used, not the ones sent.
      expect(answered.json()).toMatchObject({ ok: true, amendmentId, dueDate: '2026-12-22', mode: 'shift', delta: 7, unit: 'days' });
      const dates = await datesOf(tenant);
      // The unlocked draft moves; the superseded due date row and the locked questions date stay.
      expect(iso(dates.find((row) => row.id === draft)!.startDate)).toBe('2026-12-08');
      expect(iso(dates.find((row) => row.id === due)!.startDate)).toBe('2026-12-15');
      expect(iso(dates.find((row) => row.id === questions)!.startDate)).toBe('2026-11-01');
      expect(iso((await bidOf(tenant)).dueDate)).toBe('2026-12-22');
      expect((await amendmentOf(tenant, documentId)).datesChanged).toMatchObject({ nextDue: '2026-12-22', resolvedMode: 'shift', resolvedAt: expect.any(String) });
      expect((await call('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json()).toMatchObject({ pendingDateChange: null });
      // Answered once: a second answer is refused and moves nothing.
      const again = await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'shift', amendmentId });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'date_change_resolved' });
      expect(iso((await datesOf(tenant)).find((row) => row.id === draft)!.startDate)).toBe('2026-12-08');
    });

    it('keep applies the due date only; answering the highest change resolves the lower ones', async () => {
      const { tenant, draft } = await setup('at-keep');
      const two = await amendment(tenant, 2);
      const three = await amendment(tenant, 3, PAGE(3, 'Proposals are due 12/29/2026.'));
      expect(await run(tenant, two)).toBe('applied');
      expect(await run(tenant, three)).toBe('applied');
      const call = as(app, tenant.token);
      const amendmentId = (await amendmentOf(tenant, three)).id;
      const kept = await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'keep', amendmentId });
      expect(kept.statusCode, kept.body).toBe(200);
      expect(kept.json()).toMatchObject({ moved: 0, dueDate: '2026-12-29' });
      expect(iso((await datesOf(tenant)).find((row) => row.id === draft)!.startDate)).toBe('2026-12-01');
      expect(iso((await bidOf(tenant)).dueDate)).toBe('2026-12-29');
      expect((await amendmentOf(tenant, two)).datesChanged).toMatchObject({ resolvedAt: expect.any(String) });
      expect((await call('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json()).toMatchObject({ pendingDateChange: null });
      // An amendment with no date change, or a malformed id, is 404.
      const plain = await amendment(tenant, 4, 'Amendment No. 4');
      expect(await run(tenant, plain)).toBe('applied');
      const plainId = (await amendmentOf(tenant, plain)).id;
      expect((await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'keep', amendmentId: plainId })).statusCode).toBe(404);
      expect((await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'keep', amendmentId: 'nope' })).statusCode).toBe(404);
    });

    it('step 8 of a later amendment racing the answer to an earlier change never shifts twice, in either order', async () => {
      for (const order of [['tabs', 'adjust'], ['adjust', 'tabs']] as const) {
        const { tenant, draft } = await setup(`at-race-${order[0]}`);
        const two = await amendment(tenant, 2);
        const three = await amendment(tenant, 3, PAGE(3, 'Proposals are due 12/29/2026.'));
        expect(await run(tenant, two)).toBe('applied');
        const twoId = (await amendmentOf(tenant, two)).id;
        const call = as(app, tenant.token);
        const contenders = {
          tabs: () => run(tenant, three),
          adjust: () => call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'shift', amendmentId: twoId, workdaysOnly: false }),
        };
        // Both queue on the bid's schedule lock and run one after the other in the order given.
        const { waiting, results } = await raceInOrder(
          tenant.orgId,
          'select pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`schedule:${tenant.bidId}`],
          order.map((name) => contenders[name]),
        );
        expect(waiting).toBe(2);
        const [first, second] = results.map((item) => fulfilled(item));
        const answer = (order[0] === 'adjust' ? first : second) as { statusCode: number };
        // Step 8 of amendment 3 first: it puts 12/29 in force and outdates amendment 2's change,
        // so the late answer to it is refused and nothing moves. Answer first: it applies 12/22.
        expect(answer.statusCode, order.join()).toBe(order[0] === 'adjust' ? 200 : 409);
        const moved = order[0] === 'adjust';
        expect(iso((await datesOf(tenant)).find((row) => row.id === draft)!.startDate), order.join()).toBe(moved ? '2026-12-08' : '2026-12-01');
        expect(iso((await bidOf(tenant)).dueDate)).toBe(moved ? '2026-12-22' : '2026-12-15');
        // Amendment 3's change moves from the due date in force now, whichever wrote first.
        const pending = (await call('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json<{ pendingDateChange: unknown }>().pendingDateChange;
        expect(pending, order.join()).toMatchObject({ amendmentNo: 3, previousDue: moved ? '2026-12-22' : '2026-12-15', nextDue: '2026-12-29' });
        const threeId = (await amendmentOf(tenant, three)).id;
        const answered = await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'shift', amendmentId: threeId, workdaysOnly: false });
        expect(answered.json()).toMatchObject({ delta: moved ? 7 : 14, dueDate: '2026-12-29' });
        // Either way the schedule moved once from 12/15 to 12/29 in total.
        expect(iso((await datesOf(tenant)).find((row) => row.id === draft)!.startDate)).toBe('2026-12-15');
      }
    });

    it('a due date already set to the new date in Bid settings leaves no prompt', async () => {
      const { tenant } = await setup('at-settings');
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');
      const call = as(app, tenant.token);
      expect((await call('PATCH', `/api/bids/${tenant.bidId}`, { dueDate: '2026-12-22' })).statusCode).toBe(200);
      expect((await call('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json()).toMatchObject({ pendingDateChange: null });
    });

    it('shift is refused when the bid had no due date; keep sets it', async () => {
      const { tenant } = await setup('at-nodue');
      await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ dueDate: null }).where(eq(schema.bids.id, tenant.bidId)));
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');
      const record = await amendmentOf(tenant, documentId);
      expect(record.datesChanged).toMatchObject({ previousDue: null, nextDue: '2026-12-22' });
      const call = as(app, tenant.token);
      const shifted = await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'shift', amendmentId: record.id });
      expect(shifted.statusCode).toBe(400);
      expect(shifted.json()).toMatchObject({ code: 'invalid_date' });
      expect((await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'keep', amendmentId: record.id })).statusCode).toBe(200);
      expect(iso((await bidOf(tenant)).dueDate)).toBe('2026-12-22');
    });
  });

  describe('review fixes', () => {
    const touch = async (tenant: Tenant, agency: string) => {
      const patched = await as(app, tenant.token)('PATCH', `/api/bids/${tenant.bidId}/rows/bid_facts/${agency}`, { fields: { confirmed: true } });
      expect(patched.statusCode).toBe(200);
    };
    const agencyFacts = (no: number) => [{
      field: 'agency', value: no === 2 ? 'Department of the Navy' : 'Department of the Air Force', sourceQuote: `Amendment No. ${no}`, sourcePage: 1,
    }];
    const overviewOf = async (tenant: Tenant) => (await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/tabs/overview`)).json<{
      facts: { id: string }[];
      proposals: { linkId: string; linkIds: string[]; amendmentNo: number; oldRowIds: string[]; row: { id: string; value: string } }[];
    }>();

    it('a later amendment replaces an earlier open proposal on a touched fact, in either run order; insert ends it', async () => {
      for (const order of [[2, 3], [3, 2]]) {
        const { tenant, agency } = await setup(`at-f1-${order.join('')}`);
        await touch(tenant, agency);
        const documents = new Map<number, string>();
        for (const no of [2, 3]) {
          documents.set(no, await amendment(tenant, no, PAGE(no, 'No date change.')));
        }
        for (const no of order) {
          ai.facts = agencyFacts(no);
          expect(await run(tenant, documents.get(no)!)).toBe('applied');
        }
        const facts = await factsOf(tenant);
        const p2 = facts.find((fact) => fact.documentId === documents.get(2) && fact.factKey === 'agency')!;
        const p3 = facts.find((fact) => fact.documentId === documents.get(3) && fact.factKey === 'agency')!;
        expect(p3.supersedeStatus, order.join()).toBe('proposed');
        expect(p2, order.join()).toMatchObject(order[0] === 2
          ? { supersedeStatus: 'proposed', supersededByRowId: p3.id, changedByAmendment: 3 }
          : { supersedeStatus: 'superseded', supersededByRowId: p3.id, changedByAmendment: 3 });
        const p2Links = (await linksOf(tenant, documents.get(2)!)).filter((link) => link.rowTable === 'bid_facts');
        expect(p2Links.every((link) => link.status === 'rejected'), order.join()).toBe(true);
        expect((await amendmentOf(tenant, documents.get(2)!)).status, order.join()).toBe('applied');
        expect((await amendmentOf(tenant, documents.get(3)!)).status).toBe('needs_confirmation');
        // One proposal is offered: amendment 3's.
        const { proposals } = await overviewOf(tenant);
        expect(proposals.map((proposal) => [proposal.amendmentNo, proposal.row.value, proposal.oldRowIds])).toEqual([[3, 'Department of the Air Force', [agency]]]);
        const inserted = await as(app, tenant.token)('POST', `/api/amendment-links/${proposals[0].linkId}/confirm`);
        expect(inserted.statusCode, inserted.body).toBe(200);
        expect(inserted.json()).toMatchObject({ amendmentStatus: 'applied' });
        expect((await factsOf(tenant)).find((fact) => fact.id === agency)).toMatchObject({ supersedeStatus: 'superseded', supersededByRowId: p3.id, changedByAmendment: 3 });
        expect(active(await factsOf(tenant)).filter((fact) => fact.factKey === 'agency').map((fact) => fact.id)).toEqual([p3.id]);
      }
    });

    it('one proposal over a touched and an untouched row: nothing changes until insert, which decides every link', async () => {
      const results = new Map<string, Awaited<ReturnType<typeof setup>>>();
      for (const decision of ['confirm', 'reject'] as const) {
        const fixture = await setup(`at-f2-${decision}`);
        results.set(decision, fixture);
        const { tenant, agency } = fixture;
        const call = as(app, tenant.token);
        const created = await call('POST', `/api/bids/${tenant.bidId}/tabs/overview/rows`, { kind: 'fact', field: 'agency', value: 'Army Contracting Command' });
        const mine = created.json<{ id: string }>().id;
        ai.facts = agencyFacts(2);
        const documentId = await amendment(tenant, 2, PAGE(2, 'No date change.'));
        expect(await run(tenant, documentId)).toBe('applied');
        // The untouched AI row is not superseded while the proposal is open.
        expect((await factsOf(tenant)).find((fact) => fact.id === agency)).toMatchObject({ supersedeStatus: null });
        const { proposals } = await overviewOf(tenant);
        expect(proposals).toHaveLength(1);
        expect([...proposals[0].oldRowIds].sort()).toEqual([agency, mine].sort());
        expect(proposals[0].linkIds).toHaveLength(2);
        const proposed = proposals[0].row.id;
        // Decide through the second link: the whole proposal is decided.
        const answered = await call('POST', `/api/amendment-links/${proposals[0].linkIds[1]}/${decision}`);
        expect(answered.statusCode, answered.body).toBe(200);
        expect(answered.json()).toMatchObject({ amendmentStatus: 'applied' });
        const links = (await linksOf(tenant, documentId)).filter((link) => link.newRowId === proposed);
        expect(links.map((link) => link.status)).toEqual([decision === 'confirm' ? 'confirmed' : 'rejected', decision === 'confirm' ? 'confirmed' : 'rejected']);
        const facts = await factsOf(tenant);
        for (const id of [agency, mine]) {
          expect(facts.find((fact) => fact.id === id), decision).toMatchObject(decision === 'confirm'
            ? { supersedeStatus: 'superseded', supersededByRowId: proposed, changedByAmendment: 2 }
            : { supersedeStatus: null });
        }
        expect(facts.find((fact) => fact.id === proposed)?.supersedeStatus).toBe(decision === 'confirm' ? 'active' : 'proposed');
        expect((await overviewOf(tenant)).proposals).toEqual([]);
        if (decision === 'confirm') {
          const history = await withOrg(tenant.orgId, (db) => db.select().from(schema.rowHistory).where(eq(schema.rowHistory.rowTable, 'bid_facts')));
          expect(new Set(history.filter((row) => row.field === 'superseded_by_row_id').map((row) => row.rowId))).toEqual(new Set([agency, mine]));
        }
      }
    });

    it('a due date set in Bid settings answers the change that names it, so it never resurfaces', async () => {
      const { tenant } = await setup('at-f3a');
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');
      const call = as(app, tenant.token);
      expect((await call('PATCH', `/api/bids/${tenant.bidId}`, { dueDate: '2026-12-22' })).statusCode).toBe(200);
      expect((await amendmentOf(tenant, documentId)).datesChanged).toMatchObject({ resolvedMode: 'settings', resolvedAt: expect.any(String) });
      expect((await call('PATCH', `/api/bids/${tenant.bidId}`, { dueDate: '2026-12-30' })).statusCode).toBe(200);
      expect((await call('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json()).toMatchObject({ pendingDateChange: null });
      // A date no change names resolves nothing.
      const other = await setup('at-f3a-other');
      const otherDocument = await amendment(other.tenant, 2);
      expect(await run(other.tenant, otherDocument)).toBe('applied');
      expect((await as(app, other.tenant.token)('PATCH', `/api/bids/${other.tenant.bidId}`, { dueDate: '2026-12-18' })).statusCode).toBe(200);
      expect((await as(app, other.tenant.token)('GET', `/api/bids/${other.tenant.bidId}/tabs/schedule`)).json())
        .toMatchObject({ pendingDateChange: { amendmentNo: 2, previousDue: '2026-12-18', nextDue: '2026-12-22' } });
    });

    it('a later amendment that restores the due date resolves the earlier change it outdates', async () => {
      const { tenant } = await setup('at-f3b');
      const two = await amendment(tenant, 2);
      expect(await run(tenant, two)).toBe('applied');
      const three = await amendment(tenant, 3, PAGE(3, 'Proposals are due 2026-12-15.'));
      expect(await run(tenant, three)).toBe('applied');
      expect((await amendmentOf(tenant, two)).datesChanged).toMatchObject({ resolvedMode: 'superseded', resolvedAt: expect.any(String) });
      expect((await amendmentOf(tenant, three)).datesChanged).toBeNull();
      expect((await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json()).toMatchObject({ pendingDateChange: null });
      expect(active(await datesOf(tenant)).filter((row) => row.dateKey === 'proposal_due').map((row) => [iso(row.startDate), row.amendmentNo]))
        .toEqual([['2026-12-15', 3]]);
    });

    it('answering after the due date was already set to the new date is refused and changes nothing', async () => {
      const { tenant, draft } = await setup('at-f5');
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');
      const amendmentId = (await amendmentOf(tenant, documentId)).id;
      // Set without Bid settings (no resolution): the answer still must not move nothing and close it.
      await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ dueDate: day('2026-12-22') }).where(eq(schema.bids.id, tenant.bidId)));
      const call = as(app, tenant.token);
      const refused = await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'shift', amendmentId });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'date_change_resolved' });
      expect((await amendmentOf(tenant, documentId)).datesChanged).toMatchObject({ resolvedAt: null });
      expect(iso((await datesOf(tenant)).find((row) => row.id === draft)!.startDate)).toBe('2026-12-01');
      // The path without an amendmentId is unchanged.
      const plain = await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'shift', previousDue: '2026-12-15', nextDue: '2026-12-22', workdaysOnly: false });
      expect(plain.json()).toMatchObject({ delta: 7 });
      expect(plain.json()).not.toHaveProperty('dueDate');
    });

    it('a step 8 pending past the stale limit is queued again by the key check; a fresh one is not', async () => {
      const { tenant } = await setup('at-f6');
      const stale = await amendment(tenant, 2);
      const fresh = await amendment(tenant, 3);
      await withOrg(tenant.orgId, (db) => db.update(schema.amendments).set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(schema.amendments.documentId, stale)));
      await classify.processClassify(payload(tenant, stale));
      await classify.processClassify(payload(tenant, fresh));
      expect(enqueued.filter((item) => item.name === 'ai:amendment-tabs').map((item) => item.documentId)).toEqual([stale]);
      expect(enqueued.filter((item) => item.name === 'ai:amendment')).toEqual([]);
      expect((await amendmentOf(tenant, stale)).updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      // The documents list shows step 8's state.
      const documents = (await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/documents`)).json<{ id: string; amendmentTabsStatus: string | null }[]>();
      expect(documents.find((document) => document.id === stale)?.amendmentTabsStatus).toBe('pending');
      expect(await run(tenant, stale)).toBe('applied');
      const after = (await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/documents`)).json<{ id: string; amendmentTabsStatus: string | null }[]>();
      expect(after.find((document) => document.id === stale)?.amendmentTabsStatus).toBe('applied');
    });

    it('a deleted amendment offers no proposal and its date change cannot be answered', async () => {
      const { tenant, agency } = await setup('at-f8');
      await touch(tenant, agency);
      const documentId = await amendment(tenant, 2);
      expect(await run(tenant, documentId)).toBe('applied');
      expect((await overviewOf(tenant)).proposals).toHaveLength(1);
      const call = as(app, tenant.token);
      expect((await call('DELETE', `/api/documents/${documentId}`)).statusCode).toBe(200);
      expect((await overviewOf(tenant)).proposals).toEqual([]);
      const amendmentId = (await amendmentOf(tenant, documentId)).id;
      expect((await call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'keep', amendmentId })).statusCode).toBe(404);
      expect(iso((await bidOf(tenant)).dueDate)).toBe('2026-12-15');
      // A later amendment does not treat the deleted one's proposal as open.
      ai.facts = agencyFacts(3);
      const three = await amendment(tenant, 3, PAGE(3, 'No date change.'));
      expect(await run(tenant, three)).toBe('applied');
      expect((await overviewOf(tenant)).proposals.map((proposal) => proposal.amendmentNo)).toEqual([3]);
    });
  });

  describe('races with step 8', () => {
    const holdThen = async (orgId: string, lock: string, params: unknown[], contenders: (() => Promise<unknown>)[]) => {
      const { waiting, results } = await raceInOrder(orgId, lock, params, contenders);
      expect(waiting).toBe(contenders.length);
      return results.map((item) => fulfilled(item));
    };

    it('a row PATCH: the edit is kept either way; first wins the supersede decision', async () => {
      for (const first of ['step8', 'patch'] as const) {
        const { tenant, agency } = await setup(`at-race-patch-${first}`);
        const documentId = await amendment(tenant, 2);
        const contenders = {
          step8: () => run(tenant, documentId),
          patch: () => as(app, tenant.token)('PATCH', `/api/bids/${tenant.bidId}/rows/bid_facts/${agency}`, { fields: { confirmed: true } }),
        };
        await holdThen(tenant.orgId, 'select id from bid_facts where id = $1 for update', [agency],
          (first === 'step8' ? ['step8', 'patch'] as const : ['patch', 'step8'] as const).map((name) => contenders[name]));
        const facts = await factsOf(tenant);
        expect(facts.find((fact) => fact.id === agency)?.confirmed, first).toBe(true);
        const navy = facts.find((fact) => fact.documentId === documentId && fact.factKey === 'agency')!;
        expect(navy.supersedeStatus, first).toBe(first === 'step8' ? 'active' : 'proposed');
        expect(facts.find((fact) => fact.id === agency)?.supersedeStatus, first).toBe(first === 'step8' ? 'superseded' : null);
      }
    });

    it('a number PATCH: the rows end with the new number either way', async () => {
      for (const first of ['step8', 'number'] as const) {
        const { tenant, agency } = await setup(`at-race-no-${first}`);
        const documentId = await amendment(tenant, 2);
        const contenders = {
          step8: () => run(tenant, documentId),
          number: () => as(app, tenant.token)('PATCH', `/api/documents/${documentId}/amendment-no`, { amendmentNo: 5 }),
        };
        const results = await holdThen(tenant.orgId, 'select id from documents where id = $1 for update', [documentId],
          (first === 'step8' ? ['step8', 'number'] as const : ['number', 'step8'] as const).map((name) => contenders[name]));
        expect(results).toContain('applied');
        const facts = await factsOf(tenant);
        expect(facts.find((fact) => fact.documentId === documentId && fact.factKey === 'agency'), first).toMatchObject({ amendmentNo: 5 });
        expect(facts.find((fact) => fact.id === agency), first).toMatchObject({ changedByAmendment: 5 });
      }
    });

    it('a document delete: step 8 writes before it or not at all', async () => {
      for (const first of ['step8', 'delete'] as const) {
        const { tenant } = await setup(`at-race-del-${first}`);
        const documentId = await amendment(tenant, 2);
        const contenders = {
          step8: () => run(tenant, documentId),
          delete: () => as(app, tenant.token)('DELETE', `/api/documents/${documentId}`),
        };
        const results = await holdThen(tenant.orgId, 'select id from documents where id = $1 for update', [documentId],
          (first === 'step8' ? ['step8', 'delete'] as const : ['delete', 'step8'] as const).map((name) => contenders[name]));
        const written = (await factsOf(tenant)).filter((fact) => fact.documentId === documentId);
        expect(results.includes('applied'), first).toBe(first === 'step8');
        expect(written.length > 0, first).toBe(first === 'step8');
        // Either way no prompt is offered for the deleted amendment.
        expect((await as(app, tenant.token)('GET', `/api/bids/${tenant.bidId}/tabs/schedule`)).json()).toMatchObject({ pendingDateChange: null });
      }
    });

    it('a credit release: step 8 writes before it, or fails visibly after it', async () => {
      for (const first of ['step8', 'release'] as const) {
        const { tenant } = await setup(`at-race-credit-${first}`);
        const documentId = await amendment(tenant, 2);
        const contenders = {
          step8: () => run(tenant, documentId),
          release: () => withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ creditStatus: 'released' }).where(eq(schema.bids.id, tenant.bidId))),
        };
        await holdThen(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId],
          (first === 'step8' ? ['step8', 'release'] as const : ['release', 'step8'] as const).map((name) => contenders[name]));
        expect((await amendmentOf(tenant, documentId)).tabsStatus, first).toBe(first === 'step8' ? 'applied' : 'failed');
      }
    });

    it('a link confirm racing an adjust with the amendmentId: both apply, in either order', async () => {
      for (const first of ['confirm', 'adjust'] as const) {
        const { tenant, due, draft } = await setup(`at-race-confirm-${first}`);
        const call = as(app, tenant.token);
        // The user touched the due date row (an owner), so the new due date is a proposal.
        expect((await call('PATCH', `/api/bids/${tenant.bidId}/rows/schedule_activities/${due}`, { fields: { owner: 'Sam' } })).statusCode).toBe(200);
        const documentId = await amendment(tenant, 2);
        expect(await run(tenant, documentId)).toBe('applied');
        const record = await amendmentOf(tenant, documentId);
        const dueLink = (await linksOf(tenant, documentId)).find((link) => link.rowTable === 'schedule_activities' && link.status === 'proposed')!;
        const contenders = {
          confirm: () => call('POST', `/api/amendment-links/${dueLink.id}/confirm`),
          adjust: () => call('POST', `/api/bids/${tenant.bidId}/schedule/adjust`, { mode: 'shift', amendmentId: record.id, workdaysOnly: false }),
        };
        const replies = await holdThen(tenant.orgId, 'select id from bids where id = $1 for update', [tenant.bidId],
          (first === 'confirm' ? ['confirm', 'adjust'] as const : ['adjust', 'confirm'] as const).map((name) => contenders[name])) as { statusCode: number; body: string }[];
        replies.forEach((reply) => expect(reply.statusCode, reply.body).toBe(200));
        expect(iso((await bidOf(tenant)).dueDate), first).toBe('2026-12-22');
        expect((await amendmentOf(tenant, documentId)).datesChanged).toMatchObject({ resolvedAt: expect.any(String) });
        const dates = await datesOf(tenant);
        expect(iso(dates.find((row) => row.id === draft)!.startDate), first).toBe('2026-12-08');
        expect(dates.find((row) => row.id === dueLink.newRowId), first).toMatchObject({ supersedeStatus: 'active' });
        expect(dates.find((row) => row.id === due), first).toMatchObject({ supersedeStatus: 'superseded' });
      }
    });
  });
});

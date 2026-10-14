import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isUuid, schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { type Db, findBid } from './scope.js';

const TABS = [
  'overview',
  'schedule',
  'compliance',
  'outline',
  'resumes',
  'reviews',
  'production',
  'orals',
  'lessons',
] as const;

type TabName = (typeof TABS)[number];

const TABLES = [
  'bid_facts',
  'kickoff_items',
  'schedule_activities',
  'compliance_rows',
  'outline_items',
  'personnel_requirements',
  'candidates',
  'resume_matches',
  'reviews',
  'review_assignments',
  'review_findings',
  'production_items',
  'orals_items',
  'lessons',
] as const;

type RowTable = (typeof TABLES)[number];

const KICKOFF = [
  'Roles',
  'Schedule agreed',
  'Compliance matrix owner',
  'Page budgets',
  'Data calls',
  'Review dates',
];

const PRODUCTION = [
  ['Fonts', 'Confirm the required font and size'],
  ['Margins', 'Confirm the required margins'],
  ['Page limits', 'Confirm page limits for each volume'],
  ['File naming', 'Confirm the portal file names'],
  ['Portal', 'Confirm the submission portal and deadline'],
  ['Copies', 'Confirm how many copies to submit'],
];

const ORALS = [
  ['Rules', 'Orals format from the solicitation'],
  ['Checklist', 'Confirm length, attendees, and materials'],
  ['Session', 'Topics, presenters, and minutes'],
];

const LESSONS = [
  'What worked?',
  'What should change next time?',
  'What feedback did the evaluator give?',
];

function isTab(value: string): value is TabName {
  return (TABS as readonly string[]).includes(value);
}

function isTable(value: string): value is RowTable {
  return (TABLES as readonly string[]).includes(value);
}

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

function flag(value: unknown): boolean {
  return value === true || value === 'true';
}

function when(value: unknown): Date | null {
  if (value === null || value === '') {
    return null;
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}



async function history(
  db: Db,
  orgId: string,
  userId: string,
  table: string,
  rowId: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): Promise<void> {
  await db.insert(schema.rowHistory).values({
    orgId,
    rowTable: table,
    rowId,
    userId,
    field,
    oldValue: oldValue == null ? null : String(oldValue),
    newValue: newValue == null ? null : String(newValue),
    changedAt: new Date(),
  });
}

async function loadTab(db: Db, bidId: string, tab: TabName) {
  switch (tab) {
    case 'overview':
      return {
        facts: await db.select().from(schema.bidFacts).where(eq(schema.bidFacts.bidId, bidId)),
        kickoff: await db.select().from(schema.kickoffItems).where(eq(schema.kickoffItems.bidId, bidId)),
      };
    case 'schedule':
      return {
        activities: await db.select().from(schema.scheduleActivities).where(eq(schema.scheduleActivities.bidId, bidId)),
      };
    case 'compliance':
      return {
        rows: await db.select().from(schema.complianceRows).where(eq(schema.complianceRows.bidId, bidId)),
      };
    case 'outline':
      return {
        items: await db.select().from(schema.outlineItems).where(eq(schema.outlineItems.bidId, bidId)),
      };
    case 'resumes':
      return {
        requirements: await db.select().from(schema.personnelRequirements).where(eq(schema.personnelRequirements.bidId, bidId)),
        candidates: await db.select().from(schema.candidates).where(eq(schema.candidates.bidId, bidId)),
        matches: await db.select().from(schema.resumeMatches).where(sql`false`),
      };
    case 'reviews':
      return {
        reviews: await db.select().from(schema.reviews).where(eq(schema.reviews.bidId, bidId)),
        assignments: await db.select().from(schema.reviewAssignments),
        findings: await db.select().from(schema.reviewFindings),
      };
    case 'production':
      return {
        items: await db.select().from(schema.productionItems).where(eq(schema.productionItems.bidId, bidId)),
      };
    case 'orals':
      return {
        items: await db.select().from(schema.oralsItems).where(eq(schema.oralsItems.bidId, bidId)),
      };
    case 'lessons':
      return {
        items: await db.select().from(schema.lessons).where(eq(schema.lessons.bidId, bidId)),
      };
    default: {
      const unreachable: never = tab;
      return unreachable;
    }
  }
}

export async function registerTabs(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/tabs/:tab', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const { id, tab } = request.params as { id: string; tab: string };
    if (!isTab(tab)) {
      return reply.code(404).send({ error: 'Unknown tab' });
    }
    return withOrg(orgId, async (db) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      if (tab === 'resumes') {
        const requirements = await db.select().from(schema.personnelRequirements).where(eq(schema.personnelRequirements.bidId, id));
        const candidates = await db.select().from(schema.candidates).where(eq(schema.candidates.bidId, id));
        const matches = [];
        for (const candidate of candidates) {
          const rows = await db.select().from(schema.resumeMatches).where(eq(schema.resumeMatches.candidateId, candidate.id));
          matches.push(...rows);
        }
        return { requirements, candidates, matches };
      }
      if (tab === 'reviews') {
        const reviews = await db.select().from(schema.reviews).where(eq(schema.reviews.bidId, id));
        const assignments = [];
        const findings = [];
        for (const review of reviews) {
          assignments.push(...await db.select().from(schema.reviewAssignments).where(eq(schema.reviewAssignments.reviewId, review.id)));
          findings.push(...await db.select().from(schema.reviewFindings).where(eq(schema.reviewFindings.reviewId, review.id)));
        }
        return { reviews, assignments, findings };
      }
      return loadTab(db, id, tab);
    });
  });

  app.get('/api/bids/:id/rows/:table/:rowId', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const { id, table, rowId } = request.params as { id: string; table: string; rowId: string };
    if (!isTable(table)) {
      return reply.code(404).send({ error: 'Unknown table' });
    }
    if (!isUuid(rowId)) {
      return reply.code(404).send({ error: 'Row not found' });
    }
    return withOrg(orgId, async (db) => {
      if (!await findBid(db, orgId, id)) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const row = await readRow(db, orgId, id, table, rowId);
      if (!row) {
        return reply.code(404).send({ error: 'Row not found' });
      }
      const changes = await db.select().from(schema.rowHistory).where(and(
        eq(schema.rowHistory.rowTable, table),
        eq(schema.rowHistory.rowId, rowId),
        eq(schema.rowHistory.orgId, orgId),
      ));
      return { row, history: changes };
    });
  });

  app.patch('/api/bids/:id/rows/:table/:rowId', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const userId = request.auth!.userId;
    const { id, table, rowId } = request.params as { id: string; table: string; rowId: string };
    const fields = (request.body as { fields?: Record<string, unknown> }).fields ?? {};
    if (!isTable(table)) {
      return reply.code(404).send({ error: 'Unknown table' });
    }
    if (!isUuid(rowId)) {
      return reply.code(404).send({ error: 'Row not found' });
    }
    return withOrg(orgId, async (db) => {
      if (!await findBid(db, orgId, id)) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const updated = await patchRow(db, orgId, userId, id, table, rowId, fields);
      if (!updated) {
        return reply.code(404).send({ error: 'Row not found' });
      }
      return { ok: true };
    });
  });

  app.delete('/api/bids/:id/rows/:table/:rowId', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const { id, table, rowId } = request.params as { id: string; table: string; rowId: string };
    if (!isTable(table)) {
      return reply.code(404).send({ error: 'Unknown table' });
    }
    if (!isUuid(rowId)) {
      return reply.code(404).send({ error: 'Row not found' });
    }
    return withOrg(orgId, async (db) => {
      if (!await findBid(db, orgId, id)) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const removed = await deleteRow(db, orgId, id, table, rowId);
      if (!removed) {
        return reply.code(404).send({ error: 'Row not found' });
      }
      return { ok: true };
    });
  });

  app.post('/api/bids/:id/tabs/:tab/rows', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const { id, tab } = request.params as { id: string; tab: string };
    const body = request.body as Record<string, unknown>;
    if (!isTab(tab)) {
      return reply.code(404).send({ error: 'Unknown tab' });
    }
    return withOrg(orgId, async (db) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const created = await insertRow(db, orgId, id, tab, body);
      if (!created) {
        return reply.code(400).send({ error: 'That row is missing a required field' });
      }
      return reply.code(201).send(created);
    });
  });

  app.post('/api/bids/:id/tabs/:tab/seed', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const { id, tab } = request.params as { id: string; tab: string };
    if (!isTab(tab)) {
      return reply.code(404).send({ error: 'Unknown tab' });
    }
    return withOrg(orgId, async (db) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      if (tab === 'overview') {
        const existing = await db.select().from(schema.kickoffItems).where(eq(schema.kickoffItems.bidId, id));
        if (existing.length === 0) {
          await db.insert(schema.kickoffItems).values(KICKOFF.map((label) => ({ orgId, bidId: id, label })));
        }
      } else if (tab === 'production') {
        const existing = await db.select().from(schema.productionItems).where(eq(schema.productionItems.bidId, id));
        if (existing.length === 0) {
          await db.insert(schema.productionItems).values(PRODUCTION.map(([category, rule]) => ({
            orgId,
            bidId: id,
            category,
            rule,
            origin: 'user' as const,
          })));
        }
      } else if (tab === 'orals') {
        const existing = await db.select().from(schema.oralsItems).where(eq(schema.oralsItems.bidId, id));
        if (existing.length === 0) {
          await db.insert(schema.oralsItems).values(ORALS.map(([category, item]) => ({
            orgId,
            bidId: id,
            category,
            item,
            origin: 'user' as const,
          })));
        }
      } else if (tab === 'lessons') {
        const existing = await db.select().from(schema.lessons).where(eq(schema.lessons.bidId, id));
        if (existing.length === 0) {
          await db.insert(schema.lessons).values(LESSONS.map((question) => ({
            orgId,
            bidId: id,
            question,
            answer: '',
          })));
        }
      } else if (tab === 'schedule') {
        const template = (request.body as { template?: string }).template;
        const labels = template === 'color-reviews'
          ? ['Pink team', 'Red team', 'Gold team', 'Production']
          : ['Kickoff', 'Storyboard', 'Draft', 'Pink team', 'Red team', 'Production', 'Submit'];
        const start = bid.startDate ?? new Date();
        await db.insert(schema.scheduleActivities).values(labels.map((label, index) => ({
          orgId,
          bidId: id,
          label,
          startDate: new Date(start.getTime() + index * 86400000),
          endDate: new Date(start.getTime() + index * 86400000),
          origin: 'user' as const,
        })));
      }
      return { ok: true };
    });
  });

  app.post('/api/bids/:id/schedule/adjust', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const id = (request.params as { id: string }).id;
    const body = request.body as { mode?: string; previousDue?: string; nextDue?: string };
    if (body.mode !== 'shift' && body.mode !== 'scale' && body.mode !== 'keep') {
      return reply.code(400).send({ error: 'Choose shift, scale, or keep' });
    }
    return withOrg(orgId, async (db) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      if (body.mode === 'keep' || !body.previousDue || !body.nextDue) {
        return { ok: true, moved: 0 };
      }
      const previous = new Date(body.previousDue).getTime();
      const next = new Date(body.nextDue).getTime();
      const delta = next - previous;
      const anchor = (bid.startDate ?? new Date(previous)).getTime();
      const oldSpan = previous - anchor;
      const activities = await db.select().from(schema.scheduleActivities).where(eq(schema.scheduleActivities.bidId, id));
      let moved = 0;
      for (const activity of activities) {
        if (activity.locked || !activity.startDate) {
          continue;
        }
        const startMs = activity.startDate.getTime();
        const endMs = activity.endDate?.getTime() ?? startMs;
        let nextStart = startMs + delta;
        let nextEnd = endMs + delta;
        if (body.mode === 'scale' && oldSpan !== 0) {
          const ratio = (next - anchor) / oldSpan;
          nextStart = anchor + (startMs - anchor) * ratio;
          nextEnd = anchor + (endMs - anchor) * ratio;
        }
        await db.update(schema.scheduleActivities).set({
          startDate: new Date(nextStart),
          endDate: new Date(nextEnd),
          updatedAt: new Date(),
        }).where(and(eq(schema.scheduleActivities.id, activity.id), eq(schema.scheduleActivities.orgId, orgId)));
        moved += 1;
      }
      return { ok: true, moved };
    });
  });

  app.post('/api/bids/:id/compliance/merge', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const id = (request.params as { id: string }).id;
    const requested = (request.body as { ids?: unknown }).ids;
    // Unique ids only: the same id twice would merge a row into itself and then delete it.
    const ids = Array.isArray(requested) ? [...new Set(requested.filter(isUuid))] : [];
    if (ids.length < 2) {
      return reply.code(400).send({ error: 'Choose at least two rows' });
    }
    return withOrg(orgId, async (db) => {
      if (!await findBid(db, orgId, id)) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const rows = [];
      for (const rowId of ids) {
        const [row] = await db.select().from(schema.complianceRows).where(and(
          eq(schema.complianceRows.id, rowId),
          eq(schema.complianceRows.bidId, id),
          eq(schema.complianceRows.orgId, orgId),
        ));
        if (row) {
          rows.push(row);
        }
      }
      if (rows.length < 2) {
        return reply.code(404).send({ error: 'Row not found' });
      }
      const [keep, ...rest] = rows;
      await db.update(schema.complianceRows).set({
        requirementText: rows.map((row) => row.requirementText).join(' '),
        updatedAt: new Date(),
      }).where(and(eq(schema.complianceRows.id, keep.id), eq(schema.complianceRows.orgId, orgId)));
      for (const row of rest) {
        await db.delete(schema.complianceRows).where(and(eq(schema.complianceRows.id, row.id), eq(schema.complianceRows.orgId, orgId)));
      }
      return { id: keep.id };
    });
  });

  app.post('/api/bids/:id/compliance/split', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const id = (request.params as { id: string }).id;
    const body = request.body as { rowId?: string; at?: number };
    const at = body.at ?? 0;
    return withOrg(orgId, async (db) => {
      if (!await findBid(db, orgId, id)) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const [row] = isUuid(body.rowId)
        ? await db.select().from(schema.complianceRows).where(and(
          eq(schema.complianceRows.id, body.rowId),
          eq(schema.complianceRows.bidId, id),
          eq(schema.complianceRows.orgId, orgId),
        ))
        : [];
      if (!row) {
        return reply.code(404).send({ error: 'Row not found' });
      }
      if (at <= 0 || at >= row.requirementText.length) {
        return reply.code(400).send({ error: 'Choose a split point inside the requirement' });
      }
      await db.update(schema.complianceRows).set({
        requirementText: row.requirementText.slice(0, at).trim(),
        updatedAt: new Date(),
      }).where(and(eq(schema.complianceRows.id, row.id), eq(schema.complianceRows.orgId, orgId)));
      const [created] = await db.insert(schema.complianceRows).values({
        orgId,
        bidId: id,
        reqId: `${row.reqId}-b`,
        sectionRef: row.sectionRef,
        requirementText: row.requirementText.slice(at).trim(),
        reqType: row.reqType,
        origin: 'user',
        status: 'open',
      }).returning();
      return reply.code(201).send(created);
    });
  });
}

/** True when `id` names a row of `table` on this bid in this organization. */
async function onBid(db: Db, orgId: string, bidId: string, table: RowTable, id: unknown): Promise<boolean> {
  return isUuid(id) && (await readRow(db, orgId, bidId, table, id)) !== null;
}

async function readRow(db: Db, orgId: string, bidId: string, table: RowTable, rowId: string): Promise<object | null> {
  switch (table) {
    case 'bid_facts': {
      const [row] = await db.select().from(schema.bidFacts).where(and(eq(schema.bidFacts.id, rowId), eq(schema.bidFacts.bidId, bidId), eq(schema.bidFacts.orgId, orgId)));
      return row ?? null;
    }
    case 'kickoff_items': {
      const [row] = await db.select().from(schema.kickoffItems).where(and(eq(schema.kickoffItems.id, rowId), eq(schema.kickoffItems.bidId, bidId), eq(schema.kickoffItems.orgId, orgId)));
      return row ?? null;
    }
    case 'schedule_activities': {
      const [row] = await db.select().from(schema.scheduleActivities).where(and(eq(schema.scheduleActivities.id, rowId), eq(schema.scheduleActivities.bidId, bidId), eq(schema.scheduleActivities.orgId, orgId)));
      return row ?? null;
    }
    case 'compliance_rows': {
      const [row] = await db.select().from(schema.complianceRows).where(and(eq(schema.complianceRows.id, rowId), eq(schema.complianceRows.bidId, bidId), eq(schema.complianceRows.orgId, orgId)));
      return row ?? null;
    }
    case 'outline_items': {
      const [row] = await db.select().from(schema.outlineItems).where(and(eq(schema.outlineItems.id, rowId), eq(schema.outlineItems.bidId, bidId), eq(schema.outlineItems.orgId, orgId)));
      return row ?? null;
    }
    case 'personnel_requirements': {
      const [row] = await db.select().from(schema.personnelRequirements).where(and(eq(schema.personnelRequirements.id, rowId), eq(schema.personnelRequirements.bidId, bidId), eq(schema.personnelRequirements.orgId, orgId)));
      return row ?? null;
    }
    case 'candidates': {
      const [row] = await db.select().from(schema.candidates).where(and(eq(schema.candidates.id, rowId), eq(schema.candidates.bidId, bidId), eq(schema.candidates.orgId, orgId)));
      return row ?? null;
    }
    case 'resume_matches': {
      const [row] = await db.select().from(schema.resumeMatches).where(and(eq(schema.resumeMatches.id, rowId), eq(schema.resumeMatches.orgId, orgId)));
      if (!row) return null;
      const [candidate] = await db.select().from(schema.candidates).where(and(eq(schema.candidates.id, row.candidateId), eq(schema.candidates.bidId, bidId), eq(schema.candidates.orgId, orgId)));
      return candidate ? row : null;
    }
    case 'reviews': {
      const [row] = await db.select().from(schema.reviews).where(and(eq(schema.reviews.id, rowId), eq(schema.reviews.bidId, bidId), eq(schema.reviews.orgId, orgId)));
      return row ?? null;
    }
    case 'review_assignments': {
      const [row] = await db.select().from(schema.reviewAssignments).where(and(eq(schema.reviewAssignments.id, rowId), eq(schema.reviewAssignments.orgId, orgId)));
      if (!row) return null;
      const [review] = await db.select().from(schema.reviews).where(and(eq(schema.reviews.id, row.reviewId), eq(schema.reviews.bidId, bidId), eq(schema.reviews.orgId, orgId)));
      return review ? row : null;
    }
    case 'review_findings': {
      const [row] = await db.select().from(schema.reviewFindings).where(and(eq(schema.reviewFindings.id, rowId), eq(schema.reviewFindings.orgId, orgId)));
      if (!row) return null;
      const [review] = await db.select().from(schema.reviews).where(and(eq(schema.reviews.id, row.reviewId), eq(schema.reviews.bidId, bidId), eq(schema.reviews.orgId, orgId)));
      return review ? row : null;
    }
    case 'production_items': {
      const [row] = await db.select().from(schema.productionItems).where(and(eq(schema.productionItems.id, rowId), eq(schema.productionItems.bidId, bidId), eq(schema.productionItems.orgId, orgId)));
      return row ?? null;
    }
    case 'orals_items': {
      const [row] = await db.select().from(schema.oralsItems).where(and(eq(schema.oralsItems.id, rowId), eq(schema.oralsItems.bidId, bidId), eq(schema.oralsItems.orgId, orgId)));
      return row ?? null;
    }
    case 'lessons': {
      const [row] = await db.select().from(schema.lessons).where(and(eq(schema.lessons.id, rowId), eq(schema.lessons.bidId, bidId), eq(schema.lessons.orgId, orgId)));
      return row ?? null;
    }
    default: {
      const unreachable: never = table;
      return unreachable;
    }
  }
}

async function deleteRow(db: Db, orgId: string, bidId: string, table: RowTable, rowId: string): Promise<boolean> {
  const row = await readRow(db, orgId, bidId, table, rowId);
  if (!row) {
    return false;
  }
  switch (table) {
    case 'bid_facts':
      await db.delete(schema.bidFacts).where(and(eq(schema.bidFacts.id, rowId), eq(schema.bidFacts.orgId, orgId)));
      return true;
    case 'kickoff_items':
      await db.delete(schema.kickoffItems).where(and(eq(schema.kickoffItems.id, rowId), eq(schema.kickoffItems.orgId, orgId)));
      return true;
    case 'schedule_activities':
      await db.delete(schema.scheduleActivities).where(and(eq(schema.scheduleActivities.id, rowId), eq(schema.scheduleActivities.orgId, orgId)));
      return true;
    case 'compliance_rows':
      await db.delete(schema.complianceRows).where(and(eq(schema.complianceRows.id, rowId), eq(schema.complianceRows.orgId, orgId)));
      return true;
    case 'outline_items':
      await db.delete(schema.outlineItems).where(and(eq(schema.outlineItems.id, rowId), eq(schema.outlineItems.orgId, orgId)));
      return true;
    case 'personnel_requirements':
      await db.delete(schema.personnelRequirements).where(and(eq(schema.personnelRequirements.id, rowId), eq(schema.personnelRequirements.orgId, orgId)));
      return true;
    case 'candidates':
      await db.delete(schema.candidates).where(and(eq(schema.candidates.id, rowId), eq(schema.candidates.orgId, orgId)));
      return true;
    case 'resume_matches':
      await db.delete(schema.resumeMatches).where(and(eq(schema.resumeMatches.id, rowId), eq(schema.resumeMatches.orgId, orgId)));
      return true;
    case 'reviews':
      await db.delete(schema.reviews).where(and(eq(schema.reviews.id, rowId), eq(schema.reviews.orgId, orgId)));
      return true;
    case 'review_assignments':
      await db.delete(schema.reviewAssignments).where(and(eq(schema.reviewAssignments.id, rowId), eq(schema.reviewAssignments.orgId, orgId)));
      return true;
    case 'review_findings':
      await db.delete(schema.reviewFindings).where(and(eq(schema.reviewFindings.id, rowId), eq(schema.reviewFindings.orgId, orgId)));
      return true;
    case 'production_items':
      await db.delete(schema.productionItems).where(and(eq(schema.productionItems.id, rowId), eq(schema.productionItems.orgId, orgId)));
      return true;
    case 'orals_items':
      await db.delete(schema.oralsItems).where(and(eq(schema.oralsItems.id, rowId), eq(schema.oralsItems.orgId, orgId)));
      return true;
    case 'lessons':
      await db.delete(schema.lessons).where(and(eq(schema.lessons.id, rowId), eq(schema.lessons.orgId, orgId)));
      return true;
    default: {
      const unreachable: never = table;
      return unreachable;
    }
  }
}

async function insertRow(db: Db, orgId: string, bidId: string, tab: TabName, body: Record<string, unknown>) {
  switch (tab) {
    case 'overview':
      if (body.kind === 'fact' && text(body.field) && text(body.value)) {
        const [row] = await db.insert(schema.bidFacts).values({
          orgId,
          bidId,
          field: text(body.field)!,
          value: text(body.value)!,
          origin: 'user',
        }).returning();
        return row;
      }
      if (text(body.label)) {
        const [row] = await db.insert(schema.kickoffItems).values({ orgId, bidId, label: text(body.label)! }).returning();
        return row;
      }
      return null;
    case 'schedule': {
      if (!text(body.label)) return null;
      const [activity] = await db.insert(schema.scheduleActivities).values({
        orgId,
        bidId,
        label: text(body.label)!,
        startDate: when(body.startDate),
        endDate: when(body.endDate) ?? when(body.startDate),
        origin: 'user',
      }).returning();
      return activity;
    }
    case 'compliance': {
      if (!text(body.requirementText)) return null;
      const [compliance] = await db.insert(schema.complianceRows).values({
        orgId,
        bidId,
        reqId: text(body.reqId) || `user-${Date.now()}`,
        sectionRef: text(body.sectionRef),
        requirementText: text(body.requirementText)!,
        reqType: body.reqType === 'shall' || body.reqType === 'must' || body.reqType === 'will' || body.reqType === 'should' || body.reqType === 'other' ? body.reqType : 'other',
        owner: text(body.owner),
        status: text(body.status) || 'open',
        origin: 'user',
      }).returning();
      return compliance;
    }
    case 'outline': {
      if (!text(body.title)) return null;
      if (text(body.parentId) && !await onBid(db, orgId, bidId, 'outline_items', body.parentId)) return null;
      const [outline] = await db.insert(schema.outlineItems).values({
        orgId,
        bidId,
        title: text(body.title)!,
        number: text(body.number),
        parentId: text(body.parentId),
        pageLimit: typeof body.pageLimit === 'number' ? body.pageLimit : null,
        writer: text(body.writer),
        status: text(body.status) || 'not started',
        origin: 'user',
      }).returning();
      return outline;
    }
    case 'resumes': {
      if (body.kind === 'candidate' && text(body.name) && text(body.role)) {
        const [row] = await db.insert(schema.candidates).values({
          orgId,
          bidId,
          name: text(body.name)!,
          role: text(body.role)!,
        }).returning();
        return row;
      }
      if (body.kind === 'match' && text(body.candidateId) && text(body.requirementId)) {
        if (
          !await onBid(db, orgId, bidId, 'candidates', body.candidateId)
          || !await onBid(db, orgId, bidId, 'personnel_requirements', body.requirementId)
        ) {
          return null;
        }
        const result = body.result === 'meets' || body.result === 'partial' || body.result === 'gap' || body.result === 'unknown' ? body.result : 'unknown';
        const [row] = await db.insert(schema.resumeMatches).values({
          orgId,
          candidateId: text(body.candidateId)!,
          requirementId: text(body.requirementId)!,
          result,
        }).returning();
        return row;
      }
      if (!text(body.role) || !text(body.requirement)) return null;
      const [requirement] = await db.insert(schema.personnelRequirements).values({
        orgId,
        bidId,
        role: text(body.role)!,
        requirement: text(body.requirement)!,
        kind: body.kind === 'degree' || body.kind === 'years' || body.kind === 'certification' || body.kind === 'clearance' || body.kind === 'skill' || body.kind === 'other' ? body.kind : 'other',
        origin: 'user',
      }).returning();
      return requirement;
    }
    case 'reviews': {
      if ((body.kind === 'finding' || body.kind === 'assignment') && !await onBid(db, orgId, bidId, 'reviews', body.reviewId)) {
        return null;
      }
      if (body.kind === 'finding' && text(body.reviewId) && text(body.text)) {
        const kind = body.findingKind === 'strength' || body.findingKind === 'weakness' || body.findingKind === 'deficiency' || body.findingKind === 'risk' || body.findingKind === 'comment' ? body.findingKind : 'comment';
        const [row] = await db.insert(schema.reviewFindings).values({
          orgId,
          reviewId: text(body.reviewId)!,
          kind,
          text: text(body.text)!,
          evalFactor: text(body.evalFactor),
          origin: 'user',
        }).returning();
        return row;
      }
      if (body.kind === 'assignment' && text(body.reviewId) && text(body.reviewerName)) {
        const [row] = await db.insert(schema.reviewAssignments).values({
          orgId,
          reviewId: text(body.reviewId)!,
          reviewerName: text(body.reviewerName)!,
          sections: text(body.sections),
        }).returning();
        return row;
      }
      if (body.type !== 'pink' && body.type !== 'red' && body.type !== 'green' && body.type !== 'gold' && body.type !== 'other') {
        return null;
      }
      const [review] = await db.insert(schema.reviews).values({
        orgId,
        bidId,
        type: body.type,
        scheduledAt: when(body.scheduledAt),
        status: 'open',
      }).returning();
      return review;
    }
    case 'production': {
      if (!text(body.category) || !text(body.rule)) return null;
      const [production] = await db.insert(schema.productionItems).values({
        orgId,
        bidId,
        category: text(body.category)!,
        rule: text(body.rule)!,
        origin: 'user',
      }).returning();
      return production;
    }
    case 'orals': {
      if (!text(body.category) || !text(body.item)) return null;
      const [oral] = await db.insert(schema.oralsItems).values({
        orgId,
        bidId,
        category: text(body.category)!,
        item: text(body.item)!,
        origin: 'user',
      }).returning();
      return oral;
    }
    case 'lessons': {
      if (!text(body.question)) return null;
      const [lesson] = await db.insert(schema.lessons).values({
        orgId,
        bidId,
        question: text(body.question)!,
        answer: text(body.answer) ?? '',
        author: text(body.author),
      }).returning();
      return lesson;
    }
    default: {
      const unreachable: never = tab;
      return unreachable;
    }
  }
}

async function patchRow(
  db: Db,
  orgId: string,
  userId: string,
  bidId: string,
  table: RowTable,
  rowId: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const current = await readRow(db, orgId, bidId, table, rowId);
  if (!current) {
    return false;
  }
  const record = current as Record<string, unknown>;
  const note = async (field: string, value: unknown) => {
    if (String(record[field] ?? '') !== String(value ?? '')) {
      await history(db, orgId, userId, table, rowId, field, record[field], value);
    }
  };
  switch (table) {
    case 'bid_facts':
      await note('value', text(fields.value) ?? record.value);
      await note('confirmed', flag(fields.confirmed));
      await db.update(schema.bidFacts).set({
        value: fields.value === undefined ? String(record.value) : (text(fields.value) ?? ''),
        confirmed: fields.confirmed === undefined ? Boolean(record.confirmed) : flag(fields.confirmed),
        updatedAt: new Date(),
      }).where(and(eq(schema.bidFacts.id, rowId), eq(schema.bidFacts.orgId, orgId)));
      return true;
    case 'kickoff_items':
      await db.update(schema.kickoffItems).set({
        done: fields.done === undefined ? Boolean(record.done) : flag(fields.done),
        owner: fields.owner === undefined ? text(record.owner) : text(fields.owner),
        note: fields.note === undefined ? text(record.note) : text(fields.note),
        updatedAt: new Date(),
      }).where(and(eq(schema.kickoffItems.id, rowId), eq(schema.kickoffItems.orgId, orgId)));
      return true;
    case 'schedule_activities':
      if (record.locked === true && fields.startDate) {
        return true;
      }
      await db.update(schema.scheduleActivities).set({
        label: fields.label === undefined ? String(record.label) : (text(fields.label) ?? String(record.label)),
        startDate: fields.startDate === undefined ? (record.startDate as Date | null) : when(fields.startDate),
        endDate: fields.endDate === undefined ? (record.endDate as Date | null) : when(fields.endDate),
        locked: fields.locked === undefined ? Boolean(record.locked) : flag(fields.locked),
        owner: fields.owner === undefined ? text(record.owner) : text(fields.owner),
        status: fields.status === undefined ? text(record.status) : text(fields.status),
        updatedAt: new Date(),
      }).where(and(eq(schema.scheduleActivities.id, rowId), eq(schema.scheduleActivities.orgId, orgId)));
      return true;
    case 'compliance_rows':
      await note('requirementText', fields.requirementText);
      await note('owner', fields.owner);
      await note('status', fields.status);
      await db.update(schema.complianceRows).set({
        requirementText: fields.requirementText === undefined ? String(record.requirementText) : (text(fields.requirementText) ?? String(record.requirementText)),
        owner: fields.owner === undefined ? text(record.owner) : text(fields.owner),
        status: fields.status === undefined ? text(record.status) : text(fields.status),
        responseSection: fields.responseSection === undefined ? text(record.responseSection) : text(fields.responseSection),
        updatedAt: new Date(),
      }).where(and(eq(schema.complianceRows.id, rowId), eq(schema.complianceRows.orgId, orgId)));
      return true;
    case 'outline_items':
      await db.update(schema.outlineItems).set({
        title: fields.title === undefined ? String(record.title) : (text(fields.title) ?? String(record.title)),
        writer: fields.writer === undefined ? text(record.writer) : text(fields.writer),
        status: fields.status === undefined ? text(record.status) : text(fields.status),
        pageLimit: fields.pageLimit === undefined ? (record.pageLimit as number | null) : Number(fields.pageLimit),
        dueDate: fields.dueDate === undefined ? (record.dueDate as Date | null) : when(fields.dueDate),
        updatedAt: new Date(),
      }).where(and(eq(schema.outlineItems.id, rowId), eq(schema.outlineItems.orgId, orgId)));
      return true;
    case 'personnel_requirements':
      await db.update(schema.personnelRequirements).set({
        role: fields.role === undefined ? String(record.role) : (text(fields.role) ?? String(record.role)),
        requirement: fields.requirement === undefined ? String(record.requirement) : (text(fields.requirement) ?? String(record.requirement)),
        updatedAt: new Date(),
      }).where(and(eq(schema.personnelRequirements.id, rowId), eq(schema.personnelRequirements.orgId, orgId)));
      return true;
    case 'candidates':
      await db.update(schema.candidates).set({
        name: fields.name === undefined ? String(record.name) : (text(fields.name) ?? String(record.name)),
        role: fields.role === undefined ? String(record.role) : (text(fields.role) ?? String(record.role)),
        updatedAt: new Date(),
      }).where(and(eq(schema.candidates.id, rowId), eq(schema.candidates.orgId, orgId)));
      return true;
    case 'resume_matches': {
      const result = fields.result === 'meets' || fields.result === 'partial' || fields.result === 'gap' || fields.result === 'unknown'
        ? fields.result
        : (record.result as 'meets' | 'partial' | 'gap' | 'unknown');
      await db.update(schema.resumeMatches).set({
        result,
        reviewerOverride: fields.reviewerOverride === undefined ? Boolean(record.reviewerOverride) : flag(fields.reviewerOverride),
        updatedAt: new Date(),
      }).where(and(eq(schema.resumeMatches.id, rowId), eq(schema.resumeMatches.orgId, orgId)));
      return true;
    }
    case 'reviews':
      await db.update(schema.reviews).set({
        status: fields.status === undefined ? text(record.status) : text(fields.status),
        scheduledAt: fields.scheduledAt === undefined ? (record.scheduledAt as Date | null) : when(fields.scheduledAt),
        updatedAt: new Date(),
      }).where(and(eq(schema.reviews.id, rowId), eq(schema.reviews.orgId, orgId)));
      return true;
    case 'review_assignments':
      await db.update(schema.reviewAssignments).set({
        reviewerName: fields.reviewerName === undefined ? String(record.reviewerName) : (text(fields.reviewerName) ?? String(record.reviewerName)),
        sections: fields.sections === undefined ? text(record.sections) : text(fields.sections),
        updatedAt: new Date(),
      }).where(and(eq(schema.reviewAssignments.id, rowId), eq(schema.reviewAssignments.orgId, orgId)));
      return true;
    case 'review_findings':
      await note('disposition', fields.disposition);
      await db.update(schema.reviewFindings).set({
        disposition: fields.disposition === undefined ? text(record.disposition) : text(fields.disposition),
        text: fields.text === undefined ? String(record.text) : (text(fields.text) ?? String(record.text)),
        updatedAt: new Date(),
      }).where(and(eq(schema.reviewFindings.id, rowId), eq(schema.reviewFindings.orgId, orgId)));
      return true;
    case 'production_items':
      await db.update(schema.productionItems).set({
        done: fields.done === undefined ? Boolean(record.done) : flag(fields.done),
        rule: fields.rule === undefined ? String(record.rule) : (text(fields.rule) ?? String(record.rule)),
        updatedAt: new Date(),
      }).where(and(eq(schema.productionItems.id, rowId), eq(schema.productionItems.orgId, orgId)));
      return true;
    case 'orals_items':
      await db.update(schema.oralsItems).set({
        done: fields.done === undefined ? Boolean(record.done) : flag(fields.done),
        item: fields.item === undefined ? String(record.item) : (text(fields.item) ?? String(record.item)),
        updatedAt: new Date(),
      }).where(and(eq(schema.oralsItems.id, rowId), eq(schema.oralsItems.orgId, orgId)));
      return true;
    case 'lessons':
      await db.update(schema.lessons).set({
        answer: fields.answer === undefined ? String(record.answer) : (text(fields.answer) ?? ''),
        author: fields.author === undefined ? text(record.author) : text(fields.author),
        updatedAt: new Date(),
      }).where(and(eq(schema.lessons.id, rowId), eq(schema.lessons.orgId, orgId)));
      return true;
    default: {
      const unreachable: never = table;
      return unreachable;
    }
  }
}

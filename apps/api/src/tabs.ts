import { and, asc, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isUuid, schema } from '@pd/core';
import { registerCheckThese } from './check-these.js';
import { requireAuth } from './context.js';
import { type Db, findBid, inOrg } from './scope.js';

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

// Typed values from the tab contracts (09 s5.4 to 5.9). Migration 0006 holds the same lists
// as CHECK constraints; a value outside them is answered 400 here, before the database refuses it.
const ROW_STATUSES = ['open', 'assigned', 'drafted', 'done'] as const;
const OUTLINE_STATUSES = ['not_started', 'in_progress', 'review', 'done'] as const;
const REVIEW_STATUSES = ['planned', 'in_progress', 'done'] as const;
const DISPOSITIONS = ['open', 'accepted', 'rejected', 'done'] as const;
const MATCH_RESULTS = ['meets', 'partial', 'gap', 'unknown'] as const;
const PRODUCTION_CATEGORIES = ['format', 'files', 'submission', 'copies', 'other'] as const;
const ORALS_CATEGORIES = ['rules', 'prep', 'session'] as const;

const KICKOFF = [
  'Roles',
  'Schedule agreed',
  'Compliance matrix owner',
  'Page budgets',
  'Data calls',
  'Review dates',
];

const PRODUCTION: [(typeof PRODUCTION_CATEGORIES)[number], string][] = [
  ['format', 'Confirm the required font and size'],
  ['format', 'Confirm the required margins'],
  ['format', 'Confirm page limits for each volume'],
  ['files', 'Confirm the portal file names'],
  ['submission', 'Confirm the submission portal and deadline'],
  ['copies', 'Confirm how many copies to submit'],
];

const ORALS: [(typeof ORALS_CATEGORIES)[number], string][] = [
  ['rules', 'Orals format from the solicitation'],
  ['prep', 'Confirm length, attendees, and materials'],
  ['session', 'Topics, presenters, and minutes'],
];

const LESSONS = [
  'What worked?',
  'What should change next time?',
  'What feedback did the evaluator give?',
];

/** What insert, patch, and move decided: a value, or the error the route answers with. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: 400 | 404 | 409; error: string };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(code: 400 | 404 | 409, error: string): Result<T> {
  return { ok: false, code, error };
}

function isTab(value: string): value is TabName {
  return (TABS as readonly string[]).includes(value);
}

function isTable(value: string): value is RowTable {
  return (TABLES as readonly string[]).includes(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function choose(values: readonly string[]): string {
  return `Choose one of: ${values.join(', ')}`;
}

/** A typed field: its contract values and the legacy labels older clients send for them. */
interface TypedField<T extends string> {
  label: string;
  values: readonly T[];
  aliases: Readonly<Record<string, T>>;
}

// Aliases are keyed by `aliasKey` and match the legacy labels migration 0006 maps.
const ROW_STATUS: TypedField<(typeof ROW_STATUSES)[number]> = { label: 'Status', values: ROW_STATUSES, aliases: {} };
const OUTLINE_STATUS: TypedField<(typeof OUTLINE_STATUSES)[number]> = { label: 'Status', values: OUTLINE_STATUSES, aliases: {} };
const REVIEW_STATUS: TypedField<(typeof REVIEW_STATUSES)[number]> = { label: 'Status', values: REVIEW_STATUSES, aliases: { open: 'planned' } };
const DISPOSITION: TypedField<(typeof DISPOSITIONS)[number]> = {
  label: 'Disposition', values: DISPOSITIONS, aliases: { accept: 'accepted', reject: 'rejected' },
};
const MATCH_RESULT: TypedField<(typeof MATCH_RESULTS)[number]> = { label: 'Result', values: MATCH_RESULTS, aliases: {} };
const PRODUCTION_CATEGORY: TypedField<(typeof PRODUCTION_CATEGORIES)[number]> = {
  label: 'Category',
  values: PRODUCTION_CATEGORIES,
  aliases: { fonts: 'format', margins: 'format', page_limits: 'format', file_naming: 'files', portal: 'submission' },
};
const ORALS_CATEGORY: TypedField<(typeof ORALS_CATEGORIES)[number]> = {
  label: 'Category', values: ORALS_CATEGORIES, aliases: { checklist: 'prep' },
};

/** Case, surrounding space, and inner spaces or hyphens do not matter: 'Not started' is not_started. */
function aliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** The contract value `value` names, exactly, loosely written, or as a legacy alias; else undefined. */
function coerce<T extends string>(field: TypedField<T>, value: unknown): T | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const key = aliasKey(value);
  return oneOf(field.values, key) ? key : field.aliases[key];
}

/**
 * An optional typed input: undefined when not sent or empty (the legacy row slider sends ''),
 * the contract value when it names one, else 400. Null is refused: these columns are NOT NULL.
 */
function input<T extends string>(field: TypedField<T>, value: unknown): Result<T | undefined> {
  if (value === undefined || value === '') {
    return ok(undefined);
  }
  const coerced = coerce(field, value);
  return coerced === undefined ? fail(400, `${field.label}: ${choose(field.values)}`) : ok(coerced);
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

/** A whole number >= 0, null, or undefined (not sent). Anything else is `false`. */
function count(value: unknown): number | null | undefined | false {
  if (value === undefined || value === null) {
    return value;
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : false;
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

/**
 * Serializes outline writes for one bid (insert at the end, move, delete) so sibling positions
 * stay contiguous. An advisory lock, not a row lock: it is outside the credit lock order
 * (credits.ts) and no other code path takes it.
 */
async function lockOutline(db: Db, bidId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`outline:${bidId}`}, 0))`);
}

const outlineOrder = [asc(schema.outlineItems.position), asc(schema.outlineItems.createdAt), asc(schema.outlineItems.id)];

function outlineItems(db: Db, orgId: string, bidId: string) {
  return db.select().from(schema.outlineItems)
    .where(and(eq(schema.outlineItems.bidId, bidId), eq(schema.outlineItems.orgId, orgId)))
    .orderBy(...outlineOrder);
}

/** Writes positions 0..n-1 for `items`, in the order given, touching only rows that change. */
async function renumber(db: Db, orgId: string, items: { id: string; position: number }[]): Promise<void> {
  for (const [index, item] of items.entries()) {
    if (item.position !== index) {
      await db.update(schema.outlineItems).set({ position: index, updatedAt: new Date() })
        .where(and(eq(schema.outlineItems.id, item.id), eq(schema.outlineItems.orgId, orgId)));
    }
  }
}

type OutlineRow = typeof schema.outlineItems.$inferSelect;

/** Siblings of `parentId` (null: the volumes) in display order. */
function siblings(items: OutlineRow[], parentId: string | null): OutlineRow[] {
  return items.filter((item) => item.parentId === parentId);
}

/**
 * Moves an outline item under `parentId` (null: a volume) at `index` among its new siblings.
 * Refuses a move onto itself or under its own descendant (409). The index is clamped.
 */
async function moveOutline(
  db: Db,
  orgId: string,
  userId: string,
  bidId: string,
  id: string,
  parentId: string | null,
  index: number,
): Promise<Result<OutlineRow[]>> {
  await lockOutline(db, bidId);
  // Read after the lock: a move that committed meanwhile is visible (read committed).
  const items = await outlineItems(db, orgId, bidId);
  const byId = new Map(items.map((item) => [item.id, item]));
  const item = byId.get(id);
  if (!item) {
    return fail(404, 'Outline item not found');
  }
  if (parentId !== null && !byId.has(parentId)) {
    return fail(404, 'Parent outline item not found');
  }
  // Walk up from the new parent. The visited set ends the walk on a cycle already stored.
  const visited = new Set<string>();
  for (let cursor = parentId; cursor !== null && !visited.has(cursor); cursor = byId.get(cursor)?.parentId ?? null) {
    if (cursor === id) {
      return fail(409, 'An item cannot move under itself or one of its own sections');
    }
    visited.add(cursor);
  }
  const oldParent = item.parentId;
  const target = siblings(items, parentId).filter((row) => row.id !== id);
  const at = Math.max(0, Math.min(Math.trunc(index), target.length));
  target.splice(at, 0, item);
  if (oldParent !== parentId) {
    await db.update(schema.outlineItems).set({ parentId, updatedAt: new Date() })
      .where(and(eq(schema.outlineItems.id, id), eq(schema.outlineItems.orgId, orgId)));
    await history(db, orgId, userId, 'outline_items', id, 'parentId', oldParent, parentId);
    await renumber(db, orgId, siblings(items, oldParent).filter((row) => row.id !== id));
  }
  if (item.position !== at) {
    await history(db, orgId, userId, 'outline_items', id, 'position', item.position, at);
  }
  // The moved item's stored position may equal its new index while its parent changed; force it.
  await renumber(db, orgId, target.map((row) => (row.id === id ? { ...row, position: -1 } : row)));
  return ok(await outlineItems(db, orgId, bidId));
}

// ---------------------------------------------------------------------------
// Derived DTO fields (09 s5.6, 5.7, 5.17)
// ---------------------------------------------------------------------------

type CandidateRow = typeof schema.candidates.$inferSelect;
type ReviewRow = typeof schema.reviews.$inferSelect;
type FindingRow = typeof schema.reviewFindings.$inferSelect;

/**
 * Candidates with `status` (from the latest job on the resume: failed -> 'failed', pending or
 * running -> 'processing', otherwise 'ready'; no resume -> 'ready'), `uploadedAt` (the resume's
 * createdAt) and `resumeDeleted` (the resume document is deleted).
 */
async function presentCandidates(db: Db, orgId: string, rows: CandidateRow[]) {
  const documentIds = [...new Set(rows.map((row) => row.documentId).filter((id): id is string => id !== null))];
  const documents = await db.select({
    id: schema.documents.id,
    createdAt: schema.documents.createdAt,
    liveStatus: schema.documents.liveStatus,
  }).from(schema.documents).where(and(inArray(schema.documents.id, documentIds), eq(schema.documents.orgId, orgId)));
  const jobs = await db.select({ documentId: schema.jobs.documentId, status: schema.jobs.status }).from(schema.jobs)
    .where(and(inArray(schema.jobs.documentId, documentIds), eq(schema.jobs.orgId, orgId)))
    .orderBy(desc(schema.jobs.createdAt), desc(schema.jobs.id));
  const latest = new Map<string, string>();
  for (const job of jobs) {
    if (job.documentId && !latest.has(job.documentId)) {
      latest.set(job.documentId, job.status);
    }
  }
  const byId = new Map(documents.map((document) => [document.id, document]));
  return rows.map((row) => {
    const document = row.documentId ? byId.get(row.documentId) : undefined;
    const job = row.documentId ? latest.get(row.documentId) : undefined;
    const status: 'processing' | 'ready' | 'failed' = job === 'failed'
      ? 'failed'
      : job === 'pending' || job === 'running' ? 'processing' : 'ready';
    return {
      ...row,
      status,
      uploadedAt: document?.createdAt ?? null,
      resumeDeleted: document?.liveStatus === 'deleted',
    };
  });
}

/** Reviews with `draftFileName`, the name of the draft document. */
async function presentReviews(db: Db, orgId: string, rows: ReviewRow[]) {
  const ids = [...new Set(rows.map((row) => row.draftDocumentId).filter((id): id is string => id !== null))];
  const documents = await db.select({ id: schema.documents.id, fileName: schema.documents.fileName })
    .from(schema.documents).where(and(inArray(schema.documents.id, ids), eq(schema.documents.orgId, orgId)));
  const names = new Map(documents.map((document) => [document.id, document.fileName]));
  return rows.map((row) => ({ ...row, draftFileName: row.draftDocumentId ? names.get(row.draftDocumentId) ?? null : null }));
}

/** users.name, falling back to email, by id. `users` has no row-level security. */
async function userNames(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const users = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users).where(inArray(schema.users.id, unique));
  return new Map(users.map((user) => [user.id, user.name || user.email]));
}

/** Findings with `author`: the name of the user who added it; null for AI findings. */
async function presentFindings(db: Db, rows: FindingRow[]) {
  const names = await userNames(db, rows.map((row) => row.authorUserId));
  return rows.map((row) => ({
    ...row,
    author: row.origin === 'ai' || !row.authorUserId ? null : names.get(row.authorUserId) ?? null,
  }));
}

// Migration 0006 CHECKs the stored categories, so these only guard the DTO type: they return a
// stored contract value unchanged and map anything else the way 0006 does.
function presentProduction<T extends { category: string }>(row: T) {
  return { ...row, category: coerce(PRODUCTION_CATEGORY, row.category) ?? 'other' };
}

function presentOrals<T extends { category: string }>(row: T) {
  return { ...row, category: coerce(ORALS_CATEGORY, row.category) ?? 'prep' };
}

/** A row as its DTO: the derived fields for candidates, reviews, and findings; others as stored. */
async function present(db: Db, orgId: string, table: RowTable, row: object): Promise<object> {
  switch (table) {
    case 'production_items':
      return presentProduction(row as { category: string });
    case 'orals_items':
      return presentOrals(row as { category: string });
    case 'candidates':
      return (await presentCandidates(db, orgId, [row as CandidateRow]))[0];
    case 'reviews':
      return (await presentReviews(db, orgId, [row as ReviewRow]))[0];
    case 'review_findings':
      return (await presentFindings(db, [row as FindingRow]))[0];
    default:
      return row;
  }
}

// 'resumes' and 'reviews' are loaded in the tab route itself, through their parent rows.
async function loadTab(db: Db, orgId: string, bidId: string, tab: Exclude<TabName, 'resumes' | 'reviews'>) {
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
      return { items: await outlineItems(db, orgId, bidId) };
    case 'production':
      return {
        items: (await db.select().from(schema.productionItems).where(eq(schema.productionItems.bidId, bidId))).map(presentProduction),
      };
    case 'orals':
      return {
        items: (await db.select().from(schema.oralsItems).where(eq(schema.oralsItems.bidId, bidId))).map(presentOrals),
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
  await registerCheckThese(app);

  app.get('/api/bids/:id/tabs/:tab', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const { id, tab } = request.params as { id: string; tab: string };
    if (!isTab(tab)) {
      return reply.code(404).send({ error: 'Unknown tab' });
    }
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      if (tab === 'resumes') {
        const requirements = await db.select().from(schema.personnelRequirements).where(eq(schema.personnelRequirements.bidId, id));
        const candidates = await db.select().from(schema.candidates).where(eq(schema.candidates.bidId, id));
        const matches = await db.select().from(schema.resumeMatches).where(and(
          inArray(schema.resumeMatches.candidateId, candidates.map((candidate) => candidate.id)),
          eq(schema.resumeMatches.orgId, orgId),
        ));
        return { requirements, candidates: await presentCandidates(db, orgId, candidates), matches };
      }
      if (tab === 'reviews') {
        const reviews = await db.select().from(schema.reviews).where(eq(schema.reviews.bidId, id));
        const reviewIds = reviews.map((review) => review.id);
        const assignments = await db.select().from(schema.reviewAssignments).where(and(
          inArray(schema.reviewAssignments.reviewId, reviewIds),
          eq(schema.reviewAssignments.orgId, orgId),
        ));
        const findings = await db.select().from(schema.reviewFindings).where(and(
          inArray(schema.reviewFindings.reviewId, reviewIds),
          eq(schema.reviewFindings.orgId, orgId),
        ));
        return {
          reviews: await presentReviews(db, orgId, reviews),
          assignments,
          findings: await presentFindings(db, findings),
        };
      }
      return loadTab(db, orgId, id, tab);
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
    return inOrg(reply, orgId, async (db, respond) => {
      if (!await findBid(db, orgId, id)) {
        return respond(404, { error: 'Bid not found' });
      }
      const row = await readRow(db, orgId, id, table, rowId);
      if (!row) {
        return respond(404, { error: 'Row not found' });
      }
      const changes = await db.select().from(schema.rowHistory).where(and(
        eq(schema.rowHistory.rowTable, table),
        eq(schema.rowHistory.rowId, rowId),
        eq(schema.rowHistory.orgId, orgId),
      )).orderBy(asc(schema.rowHistory.changedAt), asc(schema.rowHistory.createdAt));
      const names = await userNames(db, changes.map((change) => change.userId));
      return {
        row: await present(db, orgId, table, row),
        history: changes.map((change) => ({ ...change, userName: change.userId ? names.get(change.userId) ?? null : null })),
      };
    });
  });

  app.patch('/api/bids/:id/rows/:table/:rowId', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const userId = request.auth!.userId;
    const { id, table, rowId } = request.params as { id: string; table: string; rowId: string };
    const fields = (request.body as { fields?: Record<string, unknown> } | undefined)?.fields ?? {};
    if (!isTable(table)) {
      return reply.code(404).send({ error: 'Unknown table' });
    }
    if (!isUuid(rowId)) {
      return reply.code(404).send({ error: 'Row not found' });
    }
    return inOrg(reply, orgId, async (db, respond) => {
      if (!await findBid(db, orgId, id)) {
        return respond(404, { error: 'Bid not found' });
      }
      const result = await patchRow(db, orgId, userId, id, table, rowId, fields);
      if (!result.ok) {
        return respond(result.code, { error: result.error });
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
    return inOrg(reply, orgId, async (db, respond) => {
      if (!await findBid(db, orgId, id)) {
        return respond(404, { error: 'Bid not found' });
      }
      const removed = await deleteRow(db, orgId, id, table, rowId);
      if (!removed) {
        return respond(404, { error: 'Row not found' });
      }
      return { ok: true };
    });
  });

  app.post('/api/bids/:id/tabs/:tab/rows', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const userId = request.auth!.userId;
    const { id, tab } = request.params as { id: string; tab: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isTab(tab)) {
      return reply.code(404).send({ error: 'Unknown tab' });
    }
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      const created = await insertRow(db, orgId, userId, id, tab, body);
      if (!created.ok) {
        return respond(created.code, { error: created.error });
      }
      return respond(201, await present(db, orgId, created.value.table, created.value.row));
    });
  });

  app.post('/api/bids/:id/outline/move', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const userId = request.auth!.userId;
    const bidId = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { id?: unknown; parentId?: unknown; index?: unknown };
    const parentId = body.parentId ?? null;
    return inOrg(reply, orgId, async (db, respond) => {
      // The bid first: another organization's bid is 404 whatever the body says.
      if (!await findBid(db, orgId, bidId)) {
        return respond(404, { error: 'Bid not found' });
      }
      if (!isUuid(body.id)) {
        return respond(404, { error: 'Outline item not found' });
      }
      if (parentId !== null && !isUuid(parentId)) {
        return respond(404, { error: 'Parent outline item not found' });
      }
      if (typeof body.index !== 'number' || !Number.isFinite(body.index)) {
        return respond(400, { error: 'Send the new index as a number' });
      }
      const itemId = body.id;
      const index = body.index;
      const moved = await moveOutline(db, orgId, userId, bidId, itemId, parentId, index);
      if (!moved.ok) {
        return respond(moved.code, { error: moved.error });
      }
      return moved.value;
    });
  });

  app.post('/api/bids/:id/tabs/:tab/seed', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const { id, tab } = request.params as { id: string; tab: string };
    if (!isTab(tab)) {
      return reply.code(404).send({ error: 'Unknown tab' });
    }
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
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
            origin: 'standard' as const,
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
            origin: 'standard' as const,
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
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
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
    return inOrg(reply, orgId, async (db, respond) => {
      if (!await findBid(db, orgId, id)) {
        return respond(404, { error: 'Bid not found' });
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
        return respond(404, { error: 'Row not found' });
      }
      const [keep, ...rest] = rows;
      // Amendment links first, then rows (lock order).
      for (const row of rest) {
        await detachComplianceRow(db, orgId, row.id);
      }
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
    return inOrg(reply, orgId, async (db, respond) => {
      if (!await findBid(db, orgId, id)) {
        return respond(404, { error: 'Bid not found' });
      }
      const [row] = isUuid(body.rowId)
        ? await db.select().from(schema.complianceRows).where(and(
          eq(schema.complianceRows.id, body.rowId),
          eq(schema.complianceRows.bidId, id),
          eq(schema.complianceRows.orgId, orgId),
        ))
        : [];
      if (!row) {
        return respond(404, { error: 'Row not found' });
      }
      if (at <= 0 || at >= row.requirementText.length) {
        return respond(400, { error: 'Choose a split point inside the requirement' });
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
      return respond(201, created);
    });
  });
}

/**
 * Before a compliance row is deleted (row delete, merge; 05 s3.3): an amendment proposal that
 * would bring the row in can no longer be confirmed, so it becomes 'rejected' (and an amendment
 * left with no proposal is applied); a row the deleted row replaced stays 'superseded' with no
 * pointer. Lock order: amendments (by id), then their links, then rows (apps/api/src/credits.ts).
 */
async function detachComplianceRow(db: Db, orgId: string, rowId: string): Promise<void> {
  const proposed = await db.select({ amendmentId: schema.amendmentLinks.amendmentId }).from(schema.amendmentLinks).where(and(
    eq(schema.amendmentLinks.newRowId, rowId),
    eq(schema.amendmentLinks.orgId, orgId),
    eq(schema.amendmentLinks.rowTable, 'compliance_rows'),
    eq(schema.amendmentLinks.status, 'proposed'),
  ));
  const amendmentIds = [...new Set(proposed.map((link) => link.amendmentId))].sort();
  const now = new Date();
  if (amendmentIds.length > 0) {
    await db.select({ id: schema.amendments.id }).from(schema.amendments).where(and(
      inArray(schema.amendments.id, amendmentIds),
      eq(schema.amendments.orgId, orgId),
    )).orderBy(asc(schema.amendments.id)).for('update');
    await db.update(schema.amendmentLinks).set({ status: 'rejected', updatedAt: now }).where(and(
      eq(schema.amendmentLinks.newRowId, rowId),
      eq(schema.amendmentLinks.orgId, orgId),
      eq(schema.amendmentLinks.rowTable, 'compliance_rows'),
      eq(schema.amendmentLinks.status, 'proposed'),
    ));
    for (const amendmentId of amendmentIds) {
      const [open] = await db.select({ id: schema.amendmentLinks.id }).from(schema.amendmentLinks).where(and(
        eq(schema.amendmentLinks.amendmentId, amendmentId),
        eq(schema.amendmentLinks.orgId, orgId),
        eq(schema.amendmentLinks.status, 'proposed'),
      )).limit(1);
      if (!open) {
        await db.update(schema.amendments).set({ status: 'applied', updatedAt: now }).where(and(
          eq(schema.amendments.id, amendmentId),
          eq(schema.amendments.orgId, orgId),
          eq(schema.amendments.status, 'needs_confirmation'),
        ));
      }
    }
  }
  await db.update(schema.complianceRows).set({ supersededByRowId: null, updatedAt: now }).where(and(
    eq(schema.complianceRows.supersededByRowId, rowId),
    eq(schema.complianceRows.orgId, orgId),
  ));
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
  if (table === 'outline_items') {
    // Before the read, so the renumber below sees every committed move.
    await lockOutline(db, bidId);
  }
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
      await detachComplianceRow(db, orgId, rowId);
      await db.delete(schema.complianceRows).where(and(eq(schema.complianceRows.id, rowId), eq(schema.complianceRows.orgId, orgId)));
      return true;
    case 'outline_items': {
      // Its sections become volumes (ON DELETE SET NULL): close the gap it leaves among its
      // siblings and put the promoted sections after the existing volumes.
      const parentId = (row as OutlineRow).parentId;
      const children = siblings(await outlineItems(db, orgId, bidId), rowId).map((item) => item.id);
      await db.delete(schema.outlineItems).where(and(eq(schema.outlineItems.id, rowId), eq(schema.outlineItems.orgId, orgId)));
      const items = await outlineItems(db, orgId, bidId);
      if (parentId !== null) {
        await renumber(db, orgId, siblings(items, parentId));
      }
      const volumes = siblings(items, null);
      const byId = new Map(volumes.map((item) => [item.id, item]));
      await renumber(db, orgId, [
        ...volumes.filter((item) => !children.includes(item.id)),
        ...children.flatMap((id) => byId.get(id) ?? []),
      ]);
      return true;
    }
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

type Created = Result<{ table: RowTable; row: object }>;

function created(table: RowTable, row: object): Created {
  return ok({ table, row });
}

const MISSING = 'That row is missing a required field';

async function insertRow(
  db: Db,
  orgId: string,
  userId: string,
  bidId: string,
  tab: TabName,
  body: Record<string, unknown>,
): Promise<Created> {
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
        return created('bid_facts', row);
      }
      if (text(body.label)) {
        const [row] = await db.insert(schema.kickoffItems).values({ orgId, bidId, label: text(body.label)! }).returning();
        return created('kickoff_items', row);
      }
      return fail(400, MISSING);
    case 'schedule': {
      if (!text(body.label)) return fail(400, MISSING);
      const [activity] = await db.insert(schema.scheduleActivities).values({
        orgId,
        bidId,
        label: text(body.label)!,
        startDate: when(body.startDate),
        endDate: when(body.endDate) ?? when(body.startDate),
        origin: 'user',
      }).returning();
      return created('schedule_activities', activity);
    }
    case 'compliance': {
      if (!text(body.requirementText)) return fail(400, MISSING);
      const status = input(ROW_STATUS, body.status);
      if (!status.ok) return status;
      const [compliance] = await db.insert(schema.complianceRows).values({
        orgId,
        bidId,
        reqId: text(body.reqId) || `user-${Date.now()}`,
        sectionRef: text(body.sectionRef),
        requirementText: text(body.requirementText)!,
        reqType: body.reqType === 'shall' || body.reqType === 'must' || body.reqType === 'will' || body.reqType === 'should' || body.reqType === 'other' ? body.reqType : 'other',
        owner: text(body.owner),
        status: status.value ?? 'open',
        origin: 'user',
      }).returning();
      return created('compliance_rows', compliance);
    }
    case 'outline': {
      if (!text(body.title)) return fail(400, MISSING);
      const status = input(OUTLINE_STATUS, body.status);
      if (!status.ok) return status;
      const pageLimit = count(body.pageLimit);
      if (pageLimit === false) return fail(400, 'Page limit must be a whole number, 0 or more');
      const parentId = text(body.parentId);
      // Lock before the parent check, so a parent deleted meanwhile is seen (400), not a
      // foreign-key failure at the insert. New items go at the end of their siblings.
      await lockOutline(db, bidId);
      if (parentId && !await onBid(db, orgId, bidId, 'outline_items', parentId)) return fail(400, MISSING);
      const [last] = await db.select({ position: max(schema.outlineItems.position) }).from(schema.outlineItems).where(and(
        eq(schema.outlineItems.bidId, bidId),
        eq(schema.outlineItems.orgId, orgId),
        parentId ? eq(schema.outlineItems.parentId, parentId) : isNull(schema.outlineItems.parentId),
      ));
      const [outline] = await db.insert(schema.outlineItems).values({
        orgId,
        bidId,
        title: text(body.title)!,
        number: text(body.number),
        parentId,
        pageLimit: pageLimit ?? null,
        writer: text(body.writer),
        status: status.value ?? 'not_started',
        position: last?.position == null ? 0 : last.position + 1,
        origin: 'user',
      }).returning();
      return created('outline_items', outline);
    }
    case 'resumes': {
      if (body.kind === 'candidate' && text(body.name) && text(body.role)) {
        const [row] = await db.insert(schema.candidates).values({
          orgId,
          bidId,
          name: text(body.name)!,
          role: text(body.role)!,
        }).returning();
        return created('candidates', row);
      }
      if (body.kind === 'match' && text(body.candidateId) && text(body.requirementId)) {
        if (
          !await onBid(db, orgId, bidId, 'candidates', body.candidateId)
          || !await onBid(db, orgId, bidId, 'personnel_requirements', body.requirementId)
        ) {
          return fail(400, MISSING);
        }
        const result = input(MATCH_RESULT, body.result);
        if (!result.ok) return result;
        const [row] = await db.insert(schema.resumeMatches).values({
          orgId,
          candidateId: text(body.candidateId)!,
          requirementId: text(body.requirementId)!,
          result: result.value ?? 'unknown',
        }).returning();
        return created('resume_matches', row);
      }
      if (!text(body.role) || !text(body.requirement)) return fail(400, MISSING);
      const [requirement] = await db.insert(schema.personnelRequirements).values({
        orgId,
        bidId,
        role: text(body.role)!,
        requirement: text(body.requirement)!,
        kind: body.kind === 'degree' || body.kind === 'years' || body.kind === 'certification' || body.kind === 'clearance' || body.kind === 'skill' || body.kind === 'other' ? body.kind : 'other',
        origin: 'user',
      }).returning();
      return created('personnel_requirements', requirement);
    }
    case 'reviews': {
      if ((body.kind === 'finding' || body.kind === 'assignment') && !await onBid(db, orgId, bidId, 'reviews', body.reviewId)) {
        return fail(400, MISSING);
      }
      if (body.kind === 'finding' && text(body.reviewId) && text(body.text)) {
        const disposition = input(DISPOSITION, body.disposition);
        if (!disposition.ok) return disposition;
        const kind = body.findingKind === 'strength' || body.findingKind === 'weakness' || body.findingKind === 'deficiency' || body.findingKind === 'risk' || body.findingKind === 'comment' ? body.findingKind : 'comment';
        const [row] = await db.insert(schema.reviewFindings).values({
          orgId,
          reviewId: text(body.reviewId)!,
          kind,
          text: text(body.text)!,
          evalFactor: text(body.evalFactor),
          origin: 'user',
          disposition: disposition.value ?? 'open',
          authorUserId: userId,
        }).returning();
        return created('review_findings', row);
      }
      if (body.kind === 'assignment' && text(body.reviewId) && text(body.reviewerName)) {
        const [row] = await db.insert(schema.reviewAssignments).values({
          orgId,
          reviewId: text(body.reviewId)!,
          reviewerName: text(body.reviewerName)!,
          sections: text(body.sections),
        }).returning();
        return created('review_assignments', row);
      }
      if (body.type !== 'pink' && body.type !== 'red' && body.type !== 'green' && body.type !== 'gold' && body.type !== 'other') {
        return fail(400, MISSING);
      }
      const status = input(REVIEW_STATUS, body.status);
      if (!status.ok) return status;
      const [review] = await db.insert(schema.reviews).values({
        orgId,
        bidId,
        type: body.type,
        scheduledAt: when(body.scheduledAt),
        status: status.value ?? 'planned',
      }).returning();
      return created('reviews', review);
    }
    case 'production': {
      if (!text(body.category) || !text(body.rule)) return fail(400, MISSING);
      const category = input(PRODUCTION_CATEGORY, body.category);
      if (!category.ok) return category;
      const [production] = await db.insert(schema.productionItems).values({
        orgId,
        bidId,
        category: category.value!,
        rule: text(body.rule)!,
        owner: text(body.owner),
        origin: 'user',
      }).returning();
      return created('production_items', production);
    }
    case 'orals': {
      if (!text(body.category) || !text(body.item)) return fail(400, MISSING);
      const category = input(ORALS_CATEGORY, body.category);
      if (!category.ok) return category;
      const minutes = count(body.minutes);
      if (minutes === false) return fail(400, 'Minutes must be a whole number, 0 or more');
      const [oral] = await db.insert(schema.oralsItems).values({
        orgId,
        bidId,
        category: category.value!,
        item: text(body.item)!,
        owner: text(body.owner),
        minutes: minutes ?? null,
        origin: 'user',
      }).returning();
      return created('orals_items', oral);
    }
    case 'lessons': {
      if (!text(body.question)) return fail(400, MISSING);
      const [lesson] = await db.insert(schema.lessons).values({
        orgId,
        bidId,
        question: text(body.question)!,
        answer: text(body.answer) ?? '',
        author: text(body.author),
      }).returning();
      return created('lessons', lesson);
    }
    default: {
      const unreachable: never = tab;
      return unreachable;
    }
  }
}

/**
 * Applies `fields` to one row and records each change in the row history. Fields a table does
 * not take are ignored; a typed field with a value outside its list is refused (400) and
 * nothing is written. 404 when the row is not on this bid in this organization.
 */
async function patchRow(
  db: Db,
  orgId: string,
  userId: string,
  bidId: string,
  table: RowTable,
  rowId: string,
  fields: Record<string, unknown>,
): Promise<Result<true>> {
  // Read first: a row of another bid or organization is 404 whatever the fields say.
  const current = await readRow(db, orgId, bidId, table, rowId);
  if (!current) {
    return fail(404, 'Row not found');
  }
  const record = current as Record<string, unknown>;
  /** Records `field` when it was sent and differs from the stored value. */
  const note = async (field: string, value: unknown) => {
    if (value !== undefined && String(record[field] ?? '') !== String(value ?? '')) {
      await history(db, orgId, userId, table, rowId, field, record[field], value);
    }
  };
  switch (table) {
    case 'bid_facts':
      await note('value', text(fields.value) ?? record.value);
      await note('confirmed', fields.confirmed === undefined ? undefined : flag(fields.confirmed));
      await db.update(schema.bidFacts).set({
        value: fields.value === undefined ? String(record.value) : (text(fields.value) ?? ''),
        confirmed: fields.confirmed === undefined ? Boolean(record.confirmed) : flag(fields.confirmed),
        updatedAt: new Date(),
      }).where(and(eq(schema.bidFacts.id, rowId), eq(schema.bidFacts.orgId, orgId)));
      return ok(true);
    case 'kickoff_items':
      await db.update(schema.kickoffItems).set({
        done: fields.done === undefined ? Boolean(record.done) : flag(fields.done),
        owner: fields.owner === undefined ? text(record.owner) : text(fields.owner),
        note: fields.note === undefined ? text(record.note) : text(fields.note),
        updatedAt: new Date(),
      }).where(and(eq(schema.kickoffItems.id, rowId), eq(schema.kickoffItems.orgId, orgId)));
      return ok(true);
    case 'schedule_activities':
      if (record.locked === true && fields.startDate) {
        return ok(true);
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
      return ok(true);
    case 'compliance_rows': {
      const status = input(ROW_STATUS, fields.status);
      if (!status.ok) return status;
      await note('requirementText', fields.requirementText === undefined ? undefined : text(fields.requirementText) ?? record.requirementText);
      await note('owner', fields.owner === undefined ? undefined : text(fields.owner));
      await note('status', status.value);
      await note('responseSection', fields.responseSection === undefined ? undefined : text(fields.responseSection));
      await db.update(schema.complianceRows).set({
        requirementText: fields.requirementText === undefined ? String(record.requirementText) : (text(fields.requirementText) ?? String(record.requirementText)),
        owner: fields.owner === undefined ? text(record.owner) : text(fields.owner),
        status: status.value ?? (record.status as (typeof ROW_STATUSES)[number]),
        responseSection: fields.responseSection === undefined ? text(record.responseSection) : text(fields.responseSection),
        updatedAt: new Date(),
      }).where(and(eq(schema.complianceRows.id, rowId), eq(schema.complianceRows.orgId, orgId)));
      return ok(true);
    }
    case 'outline_items': {
      const status = input(OUTLINE_STATUS, fields.status);
      if (!status.ok) return status;
      const pageLimit = count(fields.pageLimit);
      if (pageLimit === false) return fail(400, 'Page limit must be a whole number, 0 or more');
      await note('title', fields.title === undefined ? undefined : text(fields.title) ?? record.title);
      await note('writer', fields.writer === undefined ? undefined : text(fields.writer));
      await note('status', status.value);
      await note('pageLimit', pageLimit);
      await db.update(schema.outlineItems).set({
        title: fields.title === undefined ? String(record.title) : (text(fields.title) ?? String(record.title)),
        writer: fields.writer === undefined ? text(record.writer) : text(fields.writer),
        status: status.value ?? (record.status as (typeof OUTLINE_STATUSES)[number]),
        pageLimit: pageLimit === undefined ? (record.pageLimit as number | null) : pageLimit,
        dueDate: fields.dueDate === undefined ? (record.dueDate as Date | null) : when(fields.dueDate),
        updatedAt: new Date(),
      }).where(and(eq(schema.outlineItems.id, rowId), eq(schema.outlineItems.orgId, orgId)));
      return ok(true);
    }
    case 'personnel_requirements':
      await db.update(schema.personnelRequirements).set({
        role: fields.role === undefined ? String(record.role) : (text(fields.role) ?? String(record.role)),
        requirement: fields.requirement === undefined ? String(record.requirement) : (text(fields.requirement) ?? String(record.requirement)),
        updatedAt: new Date(),
      }).where(and(eq(schema.personnelRequirements.id, rowId), eq(schema.personnelRequirements.orgId, orgId)));
      return ok(true);
    case 'candidates':
      await db.update(schema.candidates).set({
        name: fields.name === undefined ? String(record.name) : (text(fields.name) ?? String(record.name)),
        role: fields.role === undefined ? String(record.role) : (text(fields.role) ?? String(record.role)),
        updatedAt: new Date(),
      }).where(and(eq(schema.candidates.id, rowId), eq(schema.candidates.orgId, orgId)));
      return ok(true);
    case 'resume_matches': {
      // Setting a result is a reviewer override. {reviewerOverride: false} undoes it: the AI's
      // own result comes back, or 'unknown' when there is none.
      const result = input(MATCH_RESULT, fields.result);
      if (!result.ok) return result;
      const match = current as typeof schema.resumeMatches.$inferSelect;
      let nextResult = match.result;
      let nextOverride = match.reviewerOverride;
      if (result.value !== undefined) {
        nextResult = result.value;
        nextOverride = true;
      } else if (fields.reviewerOverride !== undefined) {
        nextOverride = flag(fields.reviewerOverride);
        if (!nextOverride) {
          nextResult = match.aiResult ?? 'unknown';
        }
      }
      await note('result', nextResult);
      await note('reviewerOverride', nextOverride);
      await db.update(schema.resumeMatches).set({
        result: nextResult,
        reviewerOverride: nextOverride,
        updatedAt: new Date(),
      }).where(and(eq(schema.resumeMatches.id, rowId), eq(schema.resumeMatches.orgId, orgId)));
      return ok(true);
    }
    case 'reviews': {
      const status = input(REVIEW_STATUS, fields.status);
      if (!status.ok) return status;
      await note('status', status.value);
      await db.update(schema.reviews).set({
        status: status.value ?? (record.status as (typeof REVIEW_STATUSES)[number]),
        scheduledAt: fields.scheduledAt === undefined ? (record.scheduledAt as Date | null) : when(fields.scheduledAt),
        updatedAt: new Date(),
      }).where(and(eq(schema.reviews.id, rowId), eq(schema.reviews.orgId, orgId)));
      return ok(true);
    }
    case 'review_assignments':
      await db.update(schema.reviewAssignments).set({
        reviewerName: fields.reviewerName === undefined ? String(record.reviewerName) : (text(fields.reviewerName) ?? String(record.reviewerName)),
        sections: fields.sections === undefined ? text(record.sections) : text(fields.sections),
        updatedAt: new Date(),
      }).where(and(eq(schema.reviewAssignments.id, rowId), eq(schema.reviewAssignments.orgId, orgId)));
      return ok(true);
    case 'review_findings': {
      const disposition = input(DISPOSITION, fields.disposition);
      if (!disposition.ok) return disposition;
      await note('disposition', disposition.value);
      await note('text', fields.text === undefined ? undefined : text(fields.text) ?? record.text);
      await db.update(schema.reviewFindings).set({
        disposition: disposition.value ?? (record.disposition as (typeof DISPOSITIONS)[number]),
        text: fields.text === undefined ? String(record.text) : (text(fields.text) ?? String(record.text)),
        updatedAt: new Date(),
      }).where(and(eq(schema.reviewFindings.id, rowId), eq(schema.reviewFindings.orgId, orgId)));
      return ok(true);
    }
    case 'production_items':
      await note('done', fields.done === undefined ? undefined : flag(fields.done));
      await note('rule', fields.rule === undefined ? undefined : text(fields.rule) ?? record.rule);
      await note('owner', fields.owner === undefined ? undefined : text(fields.owner));
      await db.update(schema.productionItems).set({
        done: fields.done === undefined ? Boolean(record.done) : flag(fields.done),
        rule: fields.rule === undefined ? String(record.rule) : (text(fields.rule) ?? String(record.rule)),
        owner: fields.owner === undefined ? text(record.owner) : text(fields.owner),
        updatedAt: new Date(),
      }).where(and(eq(schema.productionItems.id, rowId), eq(schema.productionItems.orgId, orgId)));
      return ok(true);
    case 'orals_items': {
      const minutes = count(fields.minutes);
      if (minutes === false) return fail(400, 'Minutes must be a whole number, 0 or more');
      await note('done', fields.done === undefined ? undefined : flag(fields.done));
      await note('item', fields.item === undefined ? undefined : text(fields.item) ?? record.item);
      await note('owner', fields.owner === undefined ? undefined : text(fields.owner));
      await note('minutes', minutes);
      await db.update(schema.oralsItems).set({
        done: fields.done === undefined ? Boolean(record.done) : flag(fields.done),
        item: fields.item === undefined ? String(record.item) : (text(fields.item) ?? String(record.item)),
        owner: fields.owner === undefined ? text(record.owner) : text(fields.owner),
        minutes: minutes === undefined ? (record.minutes as number | null) : minutes,
        updatedAt: new Date(),
      }).where(and(eq(schema.oralsItems.id, rowId), eq(schema.oralsItems.orgId, orgId)));
      return ok(true);
    }
    case 'lessons':
      await db.update(schema.lessons).set({
        answer: fields.answer === undefined ? String(record.answer) : (text(fields.answer) ?? ''),
        author: fields.author === undefined ? text(record.author) : text(fields.author),
        updatedAt: new Date(),
      }).where(and(eq(schema.lessons.id, rowId), eq(schema.lessons.orgId, orgId)));
      return ok(true);
    default: {
      const unreachable: never = table;
      return unreachable;
    }
  }
}

import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  ACTIVITY_KINDS,
  REVIEW_COLORS,
  SCHEDULE_TEMPLATES,
  buildScheduleTemplate,
  findScheduleTemplate,
  fromIsoDate,
  inferActivityKind,
  isActivityKind,
  isAdjustMode,
  isIsoDate,
  isReviewColor,
  planScheduleAdjust,
  schema,
  toIsoDate,
  type ActivityKind,
  type ReviewColor,
} from '@pd/core';
import { requireAuth } from './context.js';
import { apiError, ERROR_MESSAGES, type ErrorCode } from './errors.js';
import { type Db, findBid, inOrg } from './scope.js';
import type { Result } from './tabs.js';

/*
 * The schedule (05 s3.2, PR4). Dates are calendar days: the api stores them as UTC midnight and
 * takes 'YYYY-MM-DD' (an ISO timestamp is read as its UTC day). Shift, scale, and templates use
 * the shared rules in packages/core schedule.ts with the bid's "Workdays only" setting
 * (bids.schedule_workdays_only), so the web preview and the server agree.
 *
 * Locking: seed and adjust take a per-bid advisory lock (outside the credit lock order in
 * credits.ts; no other path takes it), so two of them never interleave. Adjust moves a row only
 * while it is still unlocked (a conditional UPDATE), so a lock set meanwhile wins.
 */

type ActivityRow = typeof schema.scheduleActivities.$inferSelect;
type BidRow = typeof schema.bids.$inferSelect;

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(code: 400 | 404 | 409, error: string, errorCode?: ErrorCode): Result<T> {
  return { ok: false, code, error, errorCode };
}

const EARLIEST_YEAR = 1900;
const LATEST_YEAR = 2200;

/**
 * A schedule day from a client value: undefined when not sent, null when cleared (null or ''),
 * 'YYYY-MM-DD', or false when it is not a date (or outside 1900 to 2200, which also bounds the
 * day-by-day workday loops).
 */
export function readDay(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  let iso: string | null = null;
  if (isIsoDate(value)) {
    iso = value;
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    iso = Number.isNaN(date.getTime()) ? null : toIsoDate(date);
  }
  if (iso === null) return false;
  const year = Number(iso.slice(0, 4));
  return year >= EARLIEST_YEAR && year <= LATEST_YEAR ? iso : false;
}

function storedDay(date: Date | null): string | null {
  return date ? toIsoDate(date) : null;
}

const INVALID_DATE = 'Send dates as YYYY-MM-DD.';
const END_BEFORE_START = 'The end date is before the start date.';

async function lockSchedule(db: Db, bidId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`schedule:${bidId}`}, 0))`);
}

function activities(db: Db, orgId: string, bidId: string) {
  return db.select().from(schema.scheduleActivities)
    .where(and(eq(schema.scheduleActivities.bidId, bidId), eq(schema.scheduleActivities.orgId, orgId)))
    .orderBy(
      sql`${schema.scheduleActivities.startDate} asc nulls last`,
      asc(schema.scheduleActivities.createdAt),
      asc(schema.scheduleActivities.id),
    );
}

/** GET /api/bids/:id/tabs/schedule: the activities (by start date, undated last) and the bid's setting. */
export async function scheduleTab(db: Db, orgId: string, bid: BidRow) {
  return { activities: await activities(db, orgId, bid.id), workdaysOnly: bid.scheduleWorkdaysOnly };
}

// ---------------------------------------------------------------------------
// Kind and review color
// ---------------------------------------------------------------------------

const KIND_ERROR = `Kind: Choose one of: ${ACTIVITY_KINDS.join(', ')}`;
const COLOR_ERROR = `Review color: Choose one of: ${REVIEW_COLORS.join(', ')}`;
const COLOR_NEEDS_REVIEW = 'Only a review activity has a review color.';

/**
 * The kind and review color to store. `kind`/`reviewColor` are what the client sent (undefined:
 * not sent); `current` is the stored pair (null for a new row, which infers both from its label).
 * Changing the kind away from 'review' clears the color; a color on any other kind is refused.
 */
function kindAndColor(
  kind: unknown,
  reviewColor: unknown,
  current: { kind: ActivityKind; reviewColor: ReviewColor | null } | null,
  label: string,
): Result<{ kind: ActivityKind; reviewColor: ReviewColor | null }> {
  if (kind !== undefined && !isActivityKind(kind)) return fail(400, KIND_ERROR);
  if (reviewColor !== undefined && reviewColor !== null && !isReviewColor(reviewColor)) return fail(400, COLOR_ERROR);
  const inferred = current ?? (kind === undefined && isReviewColor(reviewColor)
    ? { kind: 'review' as const, reviewColor: null }
    : inferActivityKind(label));
  const nextKind = kind ?? inferred.kind;
  let nextColor: ReviewColor | null;
  if (reviewColor !== undefined) {
    nextColor = reviewColor;
  } else if (nextKind !== 'review') {
    nextColor = null;
  } else {
    // A review keeps its stored color; a new one takes the color its label names, if any.
    nextColor = inferred.kind === 'review' ? inferred.reviewColor : null;
  }
  if (nextColor !== null && nextKind !== 'review') return fail(400, COLOR_NEEDS_REVIEW);
  return ok({ kind: nextKind, reviewColor: nextColor });
}

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function flag(value: unknown): boolean {
  return value === true || value === 'true';
}

// ---------------------------------------------------------------------------
// Insert and patch (POST /tabs/schedule/rows, PATCH /rows/schedule_activities/:rowId)
// ---------------------------------------------------------------------------

/**
 * Adds a user activity. Body: label (required), startDate, endDate (defaults to startDate),
 * kind and reviewColor (inferred from the label when not sent), owner, locked.
 */
export async function insertActivity(
  db: Db,
  orgId: string,
  bidId: string,
  body: Record<string, unknown>,
): Promise<Result<ActivityRow>> {
  const label = text(body.label)?.trim();
  if (!label) return fail(400, 'That row is missing a required field');
  const start = readDay(body.startDate);
  const end = readDay(body.endDate);
  if (start === false || end === false) return fail(400, INVALID_DATE);
  const startDay = start ?? null;
  const endDay = end ?? startDay;
  if (startDay !== null && endDay !== null && endDay < startDay) return fail(400, END_BEFORE_START);
  const typed = kindAndColor(body.kind, body.reviewColor, null, label);
  if (!typed.ok) return typed;
  const [row] = await db.insert(schema.scheduleActivities).values({
    orgId,
    bidId,
    label,
    startDate: startDay === null ? null : fromIsoDate(startDay),
    endDate: endDay === null ? null : fromIsoDate(endDay),
    kind: typed.value.kind,
    reviewColor: typed.value.reviewColor,
    owner: text(body.owner),
    locked: flag(body.locked),
    origin: 'user',
  }).returning();
  return ok(row);
}

/**
 * Applies a patch to one activity. Fields: label, startDate, endDate, kind, reviewColor, owner,
 * status, locked. A date move on a row that is locked and stays locked is refused with 409
 * `activity_locked` (unlock it in the same patch, or first); sending the stored date again is
 * not a move.
 */
export async function patchActivity(
  db: Db,
  orgId: string,
  record: ActivityRow,
  fields: Record<string, unknown>,
): Promise<Result<true>> {
  const start = readDay(fields.startDate);
  const end = readDay(fields.endDate);
  if (start === false || end === false) return fail(400, INVALID_DATE);
  const storedStart = storedDay(record.startDate);
  const storedEnd = storedDay(record.endDate);
  const nextStart = start === undefined ? storedStart : start;
  const nextEnd = end === undefined ? storedEnd : end;
  const moves = nextStart !== storedStart || nextEnd !== storedEnd;
  const lockedAfter = fields.locked === undefined ? record.locked : flag(fields.locked);
  if (moves && record.locked && lockedAfter) {
    return fail(409, ERROR_MESSAGES.activity_locked, 'activity_locked');
  }
  if (nextStart !== null && nextEnd !== null && nextEnd < nextStart) return fail(400, END_BEFORE_START);
  const label = fields.label === undefined ? record.label : (text(fields.label)?.trim() || record.label);
  const typed = kindAndColor(fields.kind, fields.reviewColor, { kind: record.kind, reviewColor: record.reviewColor }, label);
  if (!typed.ok) return typed;
  await db.update(schema.scheduleActivities).set({
    label,
    startDate: nextStart === null ? null : (start === undefined ? record.startDate : fromIsoDate(nextStart)),
    endDate: nextEnd === null ? null : (end === undefined ? record.endDate : fromIsoDate(nextEnd)),
    kind: typed.value.kind,
    reviewColor: typed.value.reviewColor,
    locked: lockedAfter,
    owner: fields.owner === undefined ? record.owner : text(fields.owner),
    status: fields.status === undefined ? record.status : text(fields.status),
    updatedAt: new Date(),
  }).where(and(eq(schema.scheduleActivities.id, record.id), eq(schema.scheduleActivities.orgId, orgId)));
  return ok(true);
}

// ---------------------------------------------------------------------------
// Seed (POST /tabs/schedule/seed)
// ---------------------------------------------------------------------------

/** The template ids the legacy screen sends. */
const LEGACY_TEMPLATES: Record<string, string> = { standard: 'federal-standard', 'color-reviews': 'federal-fast' };

/**
 * Applies a template (packages/core SCHEDULE_TEMPLATES), counted back from the bid's due date
 * with the bid's setting. Body: `template` (default 'federal-standard'), `replace` (true: delete
 * the unlocked activities first, as the prototype's "Apply template" does; default false: add).
 * Rows are origin 'template'. 409 `due_date_required` when the bid has no due date.
 */
export async function seedSchedule(
  db: Db,
  orgId: string,
  bid: BidRow,
  body: Record<string, unknown>,
): Promise<Result<{ ok: true; template: string; added: number; replaced: number; activities: ActivityRow[] }>> {
  const requested = body.template === undefined || body.template === null ? 'federal-standard' : body.template;
  const template = findScheduleTemplate(typeof requested === 'string' ? LEGACY_TEMPLATES[requested] ?? requested : null);
  if (!template) {
    return fail(400, `Template: Choose one of: ${SCHEDULE_TEMPLATES.map((entry) => entry.id).join(', ')}`);
  }
  if (body.replace !== undefined && typeof body.replace !== 'boolean') {
    return fail(400, 'Send replace as true or false.');
  }
  if (!bid.dueDate) {
    return fail(409, ERROR_MESSAGES.due_date_required, 'due_date_required');
  }
  await lockSchedule(db, bid.id);
  let replaced = 0;
  if (body.replace === true) {
    replaced = (await db.delete(schema.scheduleActivities).where(and(
      eq(schema.scheduleActivities.bidId, bid.id),
      eq(schema.scheduleActivities.orgId, orgId),
      eq(schema.scheduleActivities.locked, false),
    )).returning({ id: schema.scheduleActivities.id })).length;
  }
  const built = buildScheduleTemplate(template, toIsoDate(bid.dueDate), { workdaysOnly: bid.scheduleWorkdaysOnly });
  await db.insert(schema.scheduleActivities).values(built.map((entry) => ({
    orgId,
    bidId: bid.id,
    label: entry.label,
    kind: entry.kind,
    reviewColor: entry.reviewColor,
    startDate: fromIsoDate(entry.start),
    endDate: fromIsoDate(entry.end),
    origin: 'template' as const,
  })));
  return ok({ ok: true, template: template.id, added: built.length, replaced, activities: await activities(db, orgId, bid.id) });
}

// ---------------------------------------------------------------------------
// Adjust (POST /api/bids/:id/schedule/adjust)
// ---------------------------------------------------------------------------

export async function registerSchedule(app: FastifyInstance): Promise<void> {
  /**
   * Moves the unlocked activities after a due-date change (the date-change prompt, 09 s5.11).
   * Body: mode ('shift' | 'scale' | 'keep'), previousDue and nextDue ('YYYY-MM-DD'; required
   * for shift and scale), workdaysOnly (optional: overrides the bid's setting for this call).
   * Scale stretches from the bid's start date and shifts instead without one (`mode` says
   * which was done). The bid's due date is not changed here.
   */
  app.post('/api/bids/:id/schedule/adjust', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const id = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { mode?: unknown; previousDue?: unknown; nextDue?: unknown; workdaysOnly?: unknown };
    if (!isAdjustMode(body.mode)) {
      return reply.code(400).send({ error: 'Choose shift, scale, or keep' });
    }
    const mode = body.mode;
    if (body.workdaysOnly !== undefined && typeof body.workdaysOnly !== 'boolean') {
      return reply.code(400).send({ error: 'Send workdaysOnly as true or false.' });
    }
    const previousDue = readDay(body.previousDue);
    const nextDue = readDay(body.nextDue);
    const datesSent = typeof previousDue === 'string' && typeof nextDue === 'string';
    if (previousDue === false || nextDue === false || (mode !== 'keep' && !datesSent)) {
      return reply.code(400).send(apiError('invalid_date', 'Send previousDue and nextDue as YYYY-MM-DD dates.'));
    }
    const workdaysOverride = body.workdaysOnly;
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      const workdaysOnly = workdaysOverride ?? bid.scheduleWorkdaysOnly;
      await lockSchedule(db, bid.id);
      const rows = await activities(db, orgId, bid.id);
      const plan = planScheduleAdjust(rows.map((row) => ({
        id: row.id,
        start: storedDay(row.startDate),
        end: storedDay(row.endDate),
        locked: row.locked,
      })), {
        mode,
        // keep without dates: nothing moves whatever these are.
        previousDue: datesSent ? previousDue : '2000-01-01',
        nextDue: datesSent ? nextDue : '2000-01-01',
        anchor: storedDay(bid.startDate),
        workdaysOnly,
      });
      const moved = [];
      for (const move of plan.moves) {
        const [row] = await db.update(schema.scheduleActivities).set({
          startDate: fromIsoDate(move.start),
          endDate: fromIsoDate(move.end),
          updatedAt: new Date(),
        }).where(and(
          eq(schema.scheduleActivities.id, move.id),
          eq(schema.scheduleActivities.orgId, orgId),
          eq(schema.scheduleActivities.locked, false),
        )).returning({ id: schema.scheduleActivities.id });
        if (row) moved.push(move);
      }
      return {
        ok: true as const,
        requestedMode: plan.requestedMode,
        mode: plan.mode,
        workdaysOnly,
        unit: plan.unit,
        delta: plan.delta,
        moved: moved.length,
        moves: moved,
      };
    });
  });
}

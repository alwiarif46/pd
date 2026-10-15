import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
  isUuid,
  lockBidSchedule,
  planScheduleAdjust,
  readDateChange,
  schema,
  toIsoDate,
  type ActivityKind,
  type AdjustPlan,
  type ReviewColor,
} from '@pd/core';
import { pendingDateChange, tabProposals } from './amendment-tabs.js';
import { requireAuth } from './context.js';
import { lockBid } from './credits.js';
import { apiError, ERROR_MESSAGES, type ErrorCode } from './errors.js';
import { type Db, findBid, inOrg } from './scope.js';
import type { Result } from './tabs.js';

/*
 * The schedule (05 s3.2, PR4). Dates are calendar days: the api stores them as UTC midnight and
 * takes 'YYYY-MM-DD' (an ISO timestamp is read as its UTC day). Shift, scale, and templates use
 * the shared rules in packages/core schedule.ts with the bid's "Workdays only" setting
 * (bids.schedule_workdays_only), so the web preview and the server agree.
 *
 * Locking: seed, adjust, and the worker's amendment tabs write (step 8) take the bid's schedule
 * lock (packages/core lockBidSchedule, an advisory lock taken before any row lock, outside the
 * credit lock order in credits.ts), so none of them interleave. Adjust moves a row only while it
 * is still unlocked (a conditional UPDATE), so a lock set meanwhile wins; the locked submission
 * that is the due date itself is the one exception. Adjust with an amendmentId then locks the bid
 * and the amendment (credits.ts order) to apply and resolve the amendment's date change.
 *
 * Amendments (PR5): rows an amendment proposes (supersede_status 'proposed') are not activities
 * until the user inserts them: the tab lists them under `proposals`, and adjust never moves them.
 * Superseded and withdrawn rows stay listed (crossed out in the UI) but adjust never moves them
 * either.
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

/** A 'YYYY-MM-DD' day in the years 1900 to 2200. */
function inWindow(value: unknown): value is string {
  if (!isIsoDate(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= EARLIEST_YEAR && year <= LATEST_YEAR;
}

/**
 * A schedule day from a client value: undefined when not sent, null when cleared (null or ''),
 * 'YYYY-MM-DD' in the years 1900 to 2200, or false for anything else. Timestamps are refused: a
 * client east of UTC sending local midnight as toISOString() would land a day early.
 */
export function readDay(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return inWindow(value) ? value : false;
}

function storedDay(date: Date | null): string | null {
  return date ? toIsoDate(date) : null;
}

const INVALID_DATE = 'Send dates as YYYY-MM-DD.';
const OUT_OF_WINDOW = 'That change would move activities outside the years 1900 to 2200.';
const END_BEFORE_START = 'The end date is before the start date.';

async function lockSchedule(db: Db, bidId: string): Promise<void> {
  await lockBidSchedule(db, bidId);
}

/** The bid's activities, without the rows an amendment only proposed. */
function activities(db: Db, orgId: string, bidId: string) {
  return db.select().from(schema.scheduleActivities)
    .where(and(
      eq(schema.scheduleActivities.bidId, bidId),
      eq(schema.scheduleActivities.orgId, orgId),
      sql`${schema.scheduleActivities.supersedeStatus} is distinct from 'proposed'`,
    ))
    .orderBy(
      sql`${schema.scheduleActivities.startDate} asc nulls last`,
      asc(schema.scheduleActivities.createdAt),
      asc(schema.scheduleActivities.id),
    );
}

/**
 * GET /api/bids/:id/tabs/schedule: the activities (by start date, undated last), the bid's
 * setting, the open amendment proposals (each inserted by confirming its link), and the pending
 * date change an amendment made (null when none), which the date-change prompt answers.
 */
export async function scheduleTab(db: Db, orgId: string, bid: BidRow) {
  return {
    activities: await activities(db, orgId, bid.id),
    workdaysOnly: bid.scheduleWorkdaysOnly,
    proposals: await tabProposals(db, orgId, bid.id, 'schedule_activities'),
    pendingDateChange: await pendingDateChange(db, orgId, bid),
  };
}

/** Rows adjust may move: not superseded, withdrawn, or proposed by an amendment. */
function inForce(row: ActivityRow): boolean {
  return row.supersedeStatus === null || row.supersedeStatus === 'active';
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
 * the unlocked activities of origin 'template' or 'user' first, keeping AI rows and locked rows;
 * default false: add, and 409 `schedule_template_exists` when unlocked template rows are already
 * there, so a retry or second press never adds a second template).
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
  if (body.replace !== true) {
    // A double click, a retry, or a second press must not add a second template.
    const [existing] = await db.select({ id: schema.scheduleActivities.id }).from(schema.scheduleActivities).where(and(
      eq(schema.scheduleActivities.bidId, bid.id),
      eq(schema.scheduleActivities.orgId, orgId),
      eq(schema.scheduleActivities.locked, false),
      eq(schema.scheduleActivities.origin, 'template'),
    )).limit(1);
    if (existing) {
      return fail(409, ERROR_MESSAGES.schedule_template_exists, 'schedule_template_exists');
    }
  }
  let replaced = 0;
  if (body.replace === true) {
    replaced = (await db.delete(schema.scheduleActivities).where(and(
      eq(schema.scheduleActivities.bidId, bid.id),
      eq(schema.scheduleActivities.orgId, orgId),
      eq(schema.scheduleActivities.locked, false),
      inArray(schema.scheduleActivities.origin, ['template', 'user']),
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
   * which was done). Locked rows stay, except that in every mode (keep too) a locked 'submission'
   * starting on previousDue is the due date itself and moves to nextDue (`followsDue` in its
   * move). Superseded, withdrawn, and proposed rows never move. The bid's due date is not changed
   * here, unless:
   *
   * amendmentId (optional): the answer to that amendment's date change (the schedule tab's
   * pendingDateChange). nextDue is then the amendment's and previousDue the bid's due date in force
   * (the amendment's previousDue when the bid has none; any sent are ignored), the bid's due date
   * is set to nextDue (the worker never changes it), and the change, and any
   * lower-numbered amendment's change still open, are resolved. 404 when the amendment is not on
   * this bid, has no date change, or its document was deleted; 409 `date_change_resolved` when it
   * was already answered or the bid's due date already is nextDue (the prompt must not set the due
   * date before it answers); 400
   * `invalid_date` for shift or scale when the bid had no due date to move from (keep applies).
   */
  app.post('/api/bids/:id/schedule/adjust', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const id = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { mode?: unknown; previousDue?: unknown; nextDue?: unknown; workdaysOnly?: unknown; amendmentId?: unknown };
    if (!isAdjustMode(body.mode)) {
      return reply.code(400).send({ error: 'Choose shift, scale, or keep' });
    }
    const mode = body.mode;
    if (body.workdaysOnly !== undefined && typeof body.workdaysOnly !== 'boolean') {
      return reply.code(400).send({ error: 'Send workdaysOnly as true or false.' });
    }
    const amendmentId = body.amendmentId;
    if (amendmentId !== undefined && amendmentId !== null && !isUuid(amendmentId)) {
      return reply.code(404).send({ error: 'Amendment not found' });
    }
    const answering = typeof amendmentId === 'string';
    const sentPrevious = readDay(body.previousDue);
    const sentNext = readDay(body.nextDue);
    const sentDates = typeof sentPrevious === 'string' && typeof sentNext === 'string';
    if (!answering && (sentPrevious === false || sentNext === false || (mode !== 'keep' && !sentDates))) {
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
      let previousDue = sentDates ? sentPrevious as string : null;
      let nextDue = sentDates ? sentNext as string : null;
      let amendmentNo: number | null = null;
      if (answering) {
        // Lock order (credits.ts): bid, then amendment. Read again under the locks.
        const [lockedBid] = await lockBid(db, orgId, bid.id);
        const [amendment] = await db.select().from(schema.amendments).where(and(
          eq(schema.amendments.id, amendmentId as string),
          eq(schema.amendments.bidId, bid.id),
          eq(schema.amendments.orgId, orgId),
        )).for('update');
        const [source] = amendment ? await db.select({ liveStatus: schema.documents.liveStatus }).from(schema.documents)
          .where(and(eq(schema.documents.id, amendment.documentId), eq(schema.documents.orgId, orgId))) : [];
        const change = amendment ? readDateChange(amendment.datesChanged) : null;
        // A deleted amendment's change is not offered (pendingDateChange), so it is not answered.
        if (!amendment || !change || !source || source.liveStatus === 'deleted') {
          return respond(404, { error: 'This amendment has no date change' });
        }
        if (change.resolvedAt !== null) {
          return respond(409, apiError('date_change_resolved'));
        }
        // The schedule moves from the due date in force now: the one the amendment saw may have
        // moved since (another amendment's change answered, or Bid settings).
        const currentDue = lockedBid?.dueDate ? toIsoDate(lockedBid.dueDate) : change.previousDue;
        // The due date is already the new one (set some other way): moving from it would move
        // nothing and still close the prompt, so the answer is refused and nothing changes. The
        // prompt answers with the amendmentId alone; it never sets the due date first.
        if (currentDue === change.nextDue) {
          return respond(409, apiError('date_change_resolved'));
        }
        if (mode !== 'keep' && currentDue === null) {
          return respond(400, apiError('invalid_date', 'The bid had no due date to move from. Keep the dates instead.'));
        }
        previousDue = currentDue;
        nextDue = change.nextDue;
        amendmentNo = amendment.amendmentNo;
      }
      const datesSent = previousDue !== null && nextDue !== null;
      const rows = (await activities(db, orgId, bid.id)).filter(inForce);
      let plan: AdjustPlan;
      try {
        plan = planScheduleAdjust(rows.map((row) => ({
          id: row.id,
          start: storedDay(row.startDate),
          end: storedDay(row.endDate),
          locked: row.locked,
          kind: row.kind,
        })), {
          mode,
          // keep without dates: nothing moves whatever these are.
          previousDue: datesSent ? previousDue! : '2000-01-01',
          nextDue: datesSent ? nextDue! : '2000-01-01',
          anchor: storedDay(bid.startDate),
          workdaysOnly,
        });
      } catch (error) {
        // A scale whose stretch would carry an activity centuries away (planScheduleAdjust).
        if (error instanceof RangeError) return respond(400, apiError('invalid_date', OUT_OF_WINDOW));
        throw error;
      }
      if (plan.moves.some((move) => !inWindow(move.start) || !inWindow(move.end))) {
        return respond(400, apiError('invalid_date', OUT_OF_WINDOW));
      }
      const moved = [];
      for (const move of plan.moves) {
        const [row] = await db.update(schema.scheduleActivities).set({
          startDate: fromIsoDate(move.start),
          endDate: fromIsoDate(move.end),
          updatedAt: new Date(),
        }).where(and(
          eq(schema.scheduleActivities.id, move.id),
          eq(schema.scheduleActivities.orgId, orgId),
          // The due date itself moves although locked; any other row only while still unlocked.
          move.followsDue ? undefined : eq(schema.scheduleActivities.locked, false),
        )).returning({ id: schema.scheduleActivities.id });
        if (row) moved.push(move);
      }
      if (answering && nextDue !== null) {
        // The prompt applies the amendment's due date (the worker never does), and the change is
        // answered, with any lower-numbered amendment's change it outdates.
        const now = new Date();
        await db.update(schema.bids).set({ dueDate: fromIsoDate(nextDue), updatedAt: now })
          .where(and(eq(schema.bids.id, bid.id), eq(schema.bids.orgId, orgId)));
        const resolved = { resolvedAt: now.toISOString(), resolvedMode: plan.mode };
        await db.update(schema.amendments).set({
          datesChanged: sql`${schema.amendments.datesChanged} || ${JSON.stringify(resolved)}::jsonb`,
          updatedAt: now,
        }).where(and(
          eq(schema.amendments.bidId, bid.id),
          eq(schema.amendments.orgId, orgId),
          sql`${schema.amendments.datesChanged} is not null`,
          sql`${schema.amendments.datesChanged}->>'resolvedAt' is null`,
          amendmentNo === null
            ? eq(schema.amendments.id, amendmentId as string)
            : sql`(${schema.amendments.id} = ${amendmentId} or ${schema.amendments.amendmentNo} < ${amendmentNo})`,
        ));
      }
      return {
        ...(answering ? { amendmentId: amendmentId as string, dueDate: nextDue } : {}),
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

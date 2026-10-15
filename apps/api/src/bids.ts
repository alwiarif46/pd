import { rm } from 'node:fs/promises';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  BID_STATUSES,
  bidDefaultLiveUntil,
  bidFilesLiveUntil,
  isBidStatus,
  isUuid,
  keyOverridesLeft,
  normalizeSolicitationKey,
  type Plan,
  resolveOrgPath,
  schema,
  withOrg,
} from '@pd/core';
import { requireAuth } from './context.js';
import { hasLiveSolicitation, releaseBidCredit, shareOrg } from './credits.js';
import { orgPlan, readKeyOverrideLimit } from './documents.js';
import { apiError } from './errors.js';
import { enqueueClassify } from './queue.js';
import { type Db, findBid, inOrg, type QueuedJob, queueAfterCommit } from './scope.js';

const dataDir = process.env.DATA_DIR || '/data/files';
const PENDING = 'PENDING';

/** The stored key for a solicitation number: normalized, or PENDING when there is none yet. */
function keyFor(solicitationNumber: string): string {
  return normalizeSolicitationKey(solicitationNumber) || PENDING;
}

/** Row tables with a bid_id, and the child tables reached through them, for row_history cleanup. */
const BID_ROW_TABLES = [
  'bid_facts', 'kickoff_items', 'schedule_activities', 'compliance_rows', 'outline_items',
  'personnel_requirements', 'candidates', 'reviews', 'production_items', 'orals_items', 'lessons',
] as const;

function parseDate(value: string | null): Date | null | 'invalid' {
  if (value === null) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'invalid' : date;
}

type BidRow = typeof schema.bids.$inferSelect;

/**
 * Bid rows as the api sends them (5.2, 5.11): the row plus `defaultLiveUntil` (03 s39 without
 * an extension), `filesLiveUntil` (with the owner's extension, paid plans), and
 * `keyOverridesLeft` (app_settings `key_overrides_per_bid`). Deleted files do not count as uploads.
 */
async function bidDtos(db: Db, orgId: string, bids: BidRow[]) {
  if (bids.length === 0) {
    return [];
  }
  const plan: Plan = await orgPlan(db, orgId);
  const limit = await readKeyOverrideLimit(db);
  const uploads = await db.select({
    bidId: schema.documents.bidId,
    // Mapped with the column, so the aggregate is read as a Date the way the column is.
    latestUploadAt: sql<Date | null>`max(${schema.documents.createdAt})`.mapWith(schema.documents.createdAt),
    latestNonResumeUploadAt: sql<Date | null>`max(${schema.documents.createdAt}) filter (where ${schema.documents.kind} <> 'resume')`
      .mapWith(schema.documents.createdAt),
  }).from(schema.documents).where(and(
    eq(schema.documents.orgId, orgId),
    inArray(schema.documents.bidId, bids.map((bid) => bid.id)),
    sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
  )).groupBy(schema.documents.bidId);
  return bids.map((bid) => {
    const found = uploads.find((row) => row.bidId === bid.id);
    const input = {
      plan,
      latestUploadAt: found?.latestUploadAt ?? null,
      latestNonResumeUploadAt: found?.latestNonResumeUploadAt ?? null,
      dueDate: bid.dueDate,
    };
    return {
      ...bid,
      defaultLiveUntil: bidDefaultLiveUntil(input),
      filesLiveUntil: bidFilesLiveUntil({ ...input, retentionExtendedUntil: bid.retentionExtendedUntil }),
      keyOverridesLeft: keyOverridesLeft(limit, bid.keyOverridesUsed),
    };
  });
}

/**
 * A classify job for each amendment the key check held because the bid key was PENDING (04 s3.1
 * step 1), so the worker's key check rechecks it against the new key. Deleted files are skipped.
 *
 * PATCH calls this in its own transaction AFTER the key change has committed, never under the bid
 * lock: a key check that read PENDING held the bid lock until it committed its hold, so that hold
 * is visible here; a key check that runs after the change reads the new key under the bid lock and
 * needs no recheck. Holding no bid lock, the job inserts here wait on nothing in a cycle.
 */
async function recheckPendingAmendments(db: Db, orgId: string, bidId: string): Promise<QueuedJob[]> {
  const held = await db.select({
    documentId: schema.documents.id,
    storagePath: schema.documents.storagePath,
  }).from(schema.amendments).innerJoin(schema.documents, eq(schema.documents.id, schema.amendments.documentId)).where(and(
    eq(schema.amendments.bidId, bidId),
    eq(schema.amendments.orgId, orgId),
    eq(schema.amendments.status, 'held'),
    eq(schema.documents.orgId, orgId),
    eq(schema.documents.keyStatus, 'bid_key_pending'),
    sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
  ));
  const queued: QueuedJob[] = [];
  for (const amendment of held) {
    const [job] = await db.insert(schema.jobs).values({
      orgId,
      bidId,
      documentId: amendment.documentId,
      type: 'classify',
      status: 'pending',
    }).returning({ id: schema.jobs.id });
    queued.push({
      jobId: job.id,
      enqueue: () => enqueueClassify({
        orgId,
        bidId,
        documentId: amendment.documentId,
        jobId: job.id,
        storagePath: amendment.storagePath ?? '',
        kind: 'amendment',
      }),
    });
  }
  return queued;
}

async function bidDto(db: Db, orgId: string, bid: BidRow) {
  const [dto] = await bidDtos(db, orgId, [bid]);
  return dto;
}

export async function registerBids(app: FastifyInstance): Promise<void> {
  app.get('/api/bids', { preHandler: requireAuth }, async (request) => {
    const orgId = request.auth!.orgId!;
    return withOrg(orgId, async (db) => bidDtos(db, orgId, await db.select().from(schema.bids).where(eq(schema.bids.orgId, orgId))));
  });

  app.post('/api/bids', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const body = request.body as { name?: string; bidType?: 'federal' | 'sled'; solicitationNumber?: string };
    const name = body.name?.trim() ?? '';
    if (!name || (body.bidType !== 'federal' && body.bidType !== 'sled')) {
      return reply.code(400).send({ error: 'Name and bid type are required' });
    }
    const solicitationNumber = body.solicitationNumber?.trim() || PENDING;
    return inOrg(reply, orgId, async (db, respond) => {
      const [bid] = await db.insert(schema.bids).values({
        orgId,
        name,
        bidType: body.bidType!,
        solicitationNumber,
        solicitationKey: keyFor(solicitationNumber),
        status: 'planning',
      }).returning();
      return respond(201, await bidDto(db, orgId, bid));
    });
  });

  app.get('/api/bids/:id', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const id = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      return bidDto(db, orgId, bid);
    });
  });

  app.patch('/api/bids/:id', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    const orgId = auth.orgId!;
    const id = (request.params as { id: string }).id;
    const body = request.body as {
      name?: string;
      agency?: string | null;
      bidType?: 'federal' | 'sled';
      solicitationNumber?: string;
      startDate?: string | null;
      dueDate?: string | null;
      dueTime?: string | null;
      timeZone?: string | null;
      oralsEnabled?: boolean;
      retentionExtendedUntil?: string | null;
      status?: unknown;
      /** The schedule's "Workdays only" setting (packages/core schedule.ts). */
      scheduleWorkdaysOnly?: unknown;
    };
    if (body.status !== undefined && !isBidStatus(body.status)) {
      return reply.code(400).send({ error: `Status must be one of: ${BID_STATUSES.join(', ')}.` });
    }
    if (body.scheduleWorkdaysOnly !== undefined && typeof body.scheduleWorkdaysOnly !== 'boolean') {
      return reply.code(400).send({ error: 'Send scheduleWorkdaysOnly as true or false.' });
    }
    const scheduleWorkdaysOnly = body.scheduleWorkdaysOnly;
    const status = body.status;
    const extendsRetention = body.retentionExtendedUntil !== undefined;
    let retention: Date | null | undefined;
    if (extendsRetention) {
      const parsed = parseDate(body.retentionExtendedUntil ?? null);
      // An extension ends in the future; null clears it.
      if (parsed === 'invalid' || (parsed !== null && parsed.getTime() <= Date.now())) {
        return reply.code(400).send(apiError('invalid_date', 'The live-until date must be a valid date in the future.'));
      }
      retention = parsed;
    }
    if (!isUuid(id)) {
      return reply.code(404).send({ error: 'Bid not found' });
    }
    // Set when the key moves off PENDING; the held amendments are rechecked after COMMIT.
    let keySet = false;
    const result = await inOrg(reply, orgId, async (db, respond) => {
      // Lock order (credits.ts): organizations -> bids. An audit row written below takes FOR KEY
      // SHARE on the organization for its foreign key; taking it first means an upload start
      // holding the organization row never waits on this bid while this request waits on it.
      await shareOrg(db, orgId);
      // Locked until COMMIT: an upload start that sets the key or reserves a credit for this bid
      // either finishes first (and this sees its result) or waits for this update.
      const [bid] = await db.select().from(schema.bids).where(and(
        eq(schema.bids.id, id),
        eq(schema.bids.orgId, orgId),
      )).for('update');
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      // Only the owner, on a paid plan, can extend how long files stay live (06 s3).
      if (extendsRetention) {
        if (auth.role !== 'owner') {
          return respond(403, apiError('owner_only', 'Only the organization owner can extend how long files stay live.'));
        }
        const [org] = await db.select({ plan: schema.organizations.plan }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
        if ((org?.plan ?? 'free') === 'free') {
          return respond(402, apiError('plan_required'));
        }
      }
      const name = body.name?.trim();
      const solicitationNumber = body.solicitationNumber?.trim();
      let solicitationKey = bid.solicitationKey;
      if (solicitationNumber) {
        const nextKey = keyFor(solicitationNumber);
        // A bid that holds a credit is tied to its solicitation (06 s4): the number may be
        // corrected, but not changed to a different solicitation.
        // Rows written before keys were normalized hold the raw number, so compare normalized.
        const currentKey = keyFor(bid.solicitationKey);
        // A released credit (processing failed) still ties the bid to its solicitation while
        // that file is on the bid: a retry reserves again and processes the same file.
        const holdsCredit = bid.creditStatus === 'reserved' || bid.creditStatus === 'consumed'
          || (bid.creditStatus === 'released' && await hasLiveSolicitation(db, orgId, id));
        if (holdsCredit && currentKey !== PENDING && nextKey !== currentKey) {
          return respond(409, apiError('key_locked'));
        }
        solicitationKey = nextKey;
      }
      await db.update(schema.bids).set({
        name: name || bid.name,
        agency: body.agency === undefined ? bid.agency : body.agency,
        bidType: body.bidType === 'federal' || body.bidType === 'sled' ? body.bidType : bid.bidType,
        solicitationNumber: solicitationNumber || bid.solicitationNumber,
        solicitationKey,
        startDate: body.startDate === undefined ? bid.startDate : (body.startDate ? new Date(body.startDate) : null),
        dueDate: body.dueDate === undefined ? bid.dueDate : (body.dueDate ? new Date(body.dueDate) : null),
        dueTime: body.dueTime === undefined ? bid.dueTime : body.dueTime,
        timeZone: body.timeZone === undefined ? bid.timeZone : body.timeZone,
        oralsEnabled: body.oralsEnabled === undefined ? bid.oralsEnabled : body.oralsEnabled,
        scheduleWorkdaysOnly: scheduleWorkdaysOnly ?? bid.scheduleWorkdaysOnly,
        retentionExtendedUntil: retention === undefined ? bid.retentionExtendedUntil : retention,
        status: status === undefined ? bid.status : status,
        updatedAt: new Date(),
      }).where(and(eq(schema.bids.id, id), eq(schema.bids.orgId, orgId)));
      if (extendsRetention) {
        await db.insert(schema.auditLog).values({
          orgId,
          userId: auth.userId,
          action: 'extend_retention',
          targetType: 'bid',
          targetId: id,
          detail: { retentionExtendedUntil: retention ? retention.toISOString() : null },
        });
      }
      if (keyFor(bid.solicitationKey) === PENDING && solicitationKey !== PENDING) {
        keySet = true;
        await db.insert(schema.auditLog).values({
          orgId,
          userId: auth.userId,
          action: 'set_solicitation_key',
          targetType: 'bid',
          targetId: id,
          detail: { previousKey: PENDING, solicitationKey },
        });
      }
      const updated = await findBid(db, orgId, id);
      return updated ? bidDto(db, orgId, updated) : null;
    });
    if (keySet) {
      const rechecks = await withOrg(orgId, (db) => recheckPendingAmendments(db, orgId, id));
      await queueAfterCommit(orgId, { code: 200, body: null, queue: rechecks });
    }
    return result;
  });

  /**
   * Deletes the bid and everything under it (cascades from migration 0003), plus the row
   * history of its rows, which has no foreign key. A reserved credit is released; a consumed
   * one is not returned (06 s4). Server files go after COMMIT.
   */
  app.delete('/api/bids/:id', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    const orgId = auth.orgId!;
    const id = (request.params as { id: string }).id;
    const files: string[] = [];
    const result = await inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      // Lock order (credits.ts): documents, then upload sessions, then the bid. The worker takes
      // a document before the bid, and upload complete holds its session before the bid; the
      // bid's DELETE cascades into both tables, so their rows are locked here first.
      await db.select({ id: schema.documents.id }).from(schema.documents).where(and(
        eq(schema.documents.bidId, id),
        eq(schema.documents.orgId, orgId),
      )).for('update');
      await db.select({ id: schema.uploadSessions.id }).from(schema.uploadSessions).where(and(
        eq(schema.uploadSessions.bidId, id),
        eq(schema.uploadSessions.orgId, orgId),
      )).for('update');
      // The audit row inserted at the end takes FOR KEY SHARE on the organization: take it before
      // the bid (credits.ts shareOrg), but after the sessions. Upload complete holds its session,
      // then waits on the organization FOR UPDATE (the one exception in credits.ts); sharing the
      // organization before waiting on that session would close a cycle with it.
      await shareOrg(db, orgId);
      await releaseBidCredit(db, orgId, id);
      const documents = await db.select({
        storagePath: schema.documents.storagePath,
        viewerPath: schema.documents.viewerPath,
      }).from(schema.documents).where(and(eq(schema.documents.bidId, id), eq(schema.documents.orgId, orgId)));
      const sessions = await db.select({ id: schema.uploadSessions.id }).from(schema.uploadSessions).where(and(
        eq(schema.uploadSessions.bidId, id),
        eq(schema.uploadSessions.orgId, orgId),
      ));
      for (const document of documents) {
        for (const path of [document.storagePath, document.viewerPath]) {
          const absolute = path ? resolveOrgPath(dataDir, orgId, path) : null;
          if (absolute) {
            files.push(absolute);
          }
        }
      }
      const exported = await db.select({ storagePath: schema.exports.storagePath }).from(schema.exports).where(and(
        eq(schema.exports.bidId, id),
        eq(schema.exports.orgId, orgId),
      ));
      for (const file of exported) {
        const absolute = resolveOrgPath(dataDir, orgId, file.storagePath);
        if (absolute) {
          files.push(absolute);
        }
      }
      // Archive copies live off the server. Their rows outlive the bid (migration 0004 sets
      // archive_objects.document_id to null instead of cascading) and are marked to expire now,
      // so the purge job deletes the copies (07 s2).
      await db.execute(sql`update archive_objects set expires_at = now(), updated_at = now()
        where org_id = ${orgId} and purged_at is null
          and document_id in (select id from documents where bid_id = ${id} and org_id = ${orgId})`);
      for (const session of sessions) {
        const absolute = resolveOrgPath(dataDir, orgId, `chunks/${session.id}`);
        if (absolute) {
          files.push(absolute);
        }
      }
      for (const table of BID_ROW_TABLES) {
        await db.execute(sql`delete from row_history where org_id = ${orgId} and row_table = ${table}
          and row_id in (select id from ${sql.identifier(table)} where bid_id = ${id} and org_id = ${orgId})`);
      }
      await db.execute(sql`delete from row_history where org_id = ${orgId} and row_table = 'resume_matches'
        and row_id in (select m.id from resume_matches m join candidates c on c.id = m.candidate_id where c.bid_id = ${id} and c.org_id = ${orgId})`);
      for (const table of ['review_assignments', 'review_findings'] as const) {
        await db.execute(sql`delete from row_history where org_id = ${orgId} and row_table = ${table}
          and row_id in (select x.id from ${sql.identifier(table)} x join reviews r on r.id = x.review_id where r.bid_id = ${id} and r.org_id = ${orgId})`);
      }
      await db.delete(schema.bids).where(and(eq(schema.bids.id, id), eq(schema.bids.orgId, orgId)));
      await db.insert(schema.auditLog).values({
        orgId,
        userId: auth.userId,
        action: 'delete_bid',
        targetType: 'bid',
        targetId: id,
        detail: { creditStatus: bid.creditStatus },
      });
      return { ok: true };
    });
    await Promise.all(files.map((file) => rm(file, { recursive: true, force: true }).catch(() => undefined)));
    return result;
  });
}

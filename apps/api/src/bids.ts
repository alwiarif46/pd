import { rm } from 'node:fs/promises';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isUuid, normalizeSolicitationKey, resolveOrgPath, schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { releaseBidCredit } from './credits.js';
import { apiError } from './errors.js';
import { findBid, inOrg } from './scope.js';

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

export async function registerBids(app: FastifyInstance): Promise<void> {
  app.get('/api/bids', { preHandler: requireAuth }, async (request) => {
    const orgId = request.auth!.orgId!;
    return withOrg(orgId, async (db) => db.select().from(schema.bids).where(eq(schema.bids.orgId, orgId)));
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
        status: 'draft',
      }).returning();
      return respond(201, bid);
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
      return bid;
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
    };
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
    return inOrg(reply, orgId, async (db, respond) => {
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
        const holdsCredit = bid.creditStatus === 'reserved' || bid.creditStatus === 'consumed';
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
        retentionExtendedUntil: retention === undefined ? bid.retentionExtendedUntil : retention,
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
      const updated = await findBid(db, orgId, id);
      return updated;
    });
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

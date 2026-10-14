import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { periodAllowance, periodContaining, type Plan, schema } from '@pd/core';
import type { Db } from './scope.js';

/*
 * RFP credit bookkeeping (06 s3, s4). `rfp_credits` is the single source of truth.
 *
 * Concurrency rules:
 * - Creating a period row happens only while holding the organization row lock
 *   (`lockOrg`), so two requests never create two rows for one period.
 * - Counters change only through single conditional UPDATEs (`reserved = reserved + 1 WHERE
 *   used + reserved < allowed`, `reserved = reserved - 1 WHERE reserved > 0`), never by writing
 *   back values read earlier, so concurrent requests and the worker cannot lose an update.
 * - A bid's reservation changes state only through a conditional UPDATE on
 *   `bids.credit_status = 'reserved'`. Whoever wins that row settles the counter; everyone else
 *   sees no row and does nothing, so a reservation is released or consumed at most once.
 */

export type CreditRow = typeof schema.rfpCredits.$inferSelect;
type OrgRow = typeof schema.organizations.$inferSelect;
type SessionRow = typeof schema.uploadSessions.$inferSelect;

/** Locks this organization's row until the transaction ends and returns it. */
export async function lockOrg(db: Db, orgId: string): Promise<OrgRow | null> {
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).for('update');
  return org ?? null;
}

/**
 * The period that holds `now`: the latest-starting row with period_start <= now < period_end.
 * Ties (which the org lock prevents) go to the row created first, so the answer is stable.
 */
export async function currentCreditPeriod(db: Db, orgId: string, now: Date): Promise<CreditRow | null> {
  const [row] = await db.select().from(schema.rfpCredits).where(and(
    eq(schema.rfpCredits.orgId, orgId),
    lte(schema.rfpCredits.periodStart, now),
    gt(schema.rfpCredits.periodEnd, now),
  )).orderBy(desc(schema.rfpCredits.periodStart), schema.rfpCredits.createdAt, schema.rfpCredits.id).limit(1);
  return row ?? null;
}

/**
 * The current period, created if missing. The caller must hold `lockOrg`.
 *
 * Bounds: a paid plan whose cached Stripe cycle (`cycle_start`, `cycle_end`) holds `now` uses
 * that cycle. Otherwise periods are whole months from `cycle_start` (or signup), clamped to the
 * month's last day, and the one holding `now` is used, so an expired period is never re-created.
 *
 * Free allowance: 2 only in the first month after signup, before `free_first_month_ends` if set,
 * and only if the organization has had no period row before; 1 otherwise.
 */
export async function ensureCreditPeriod(db: Db, org: OrgRow, now: Date): Promise<CreditRow> {
  const existing = await currentCreditPeriod(db, org.id, now);
  if (existing) {
    return existing;
  }
  const plan = (org.plan ?? 'free') as Plan;
  let start: Date;
  let end: Date;
  if (plan !== 'free' && org.cycleStart && org.cycleEnd && org.cycleStart <= now && now < org.cycleEnd) {
    start = org.cycleStart;
    end = org.cycleEnd;
  } else {
    const period = periodContaining(org.cycleStart ?? org.createdAt, now);
    start = period.start;
    end = period.end;
  }
  // Never overlap an earlier row: a period that ended inside this one moves the start up.
  const [previous] = await db.select({ periodEnd: schema.rfpCredits.periodEnd }).from(schema.rfpCredits).where(and(
    eq(schema.rfpCredits.orgId, org.id),
    lte(schema.rfpCredits.periodEnd, now),
  )).orderBy(desc(schema.rfpCredits.periodEnd)).limit(1);
  if (previous && previous.periodEnd > start) {
    start = previous.periodEnd;
  }
  const inSignupMonth = periodContaining(org.createdAt, now).index === 0
    && (!org.freeFirstMonthEnds || now < org.freeFirstMonthEnds);
  const allowed = periodAllowance(plan, {
    isFirstPeriod: inSignupMonth && !previous,
    returningToFree: false,
  });
  const [created] = await db.insert(schema.rfpCredits).values({
    orgId: org.id,
    periodStart: start,
    periodEnd: end,
    allowed,
  }).returning();
  return created;
}

/**
 * Reserves one credit of the current period for `bidId`. The caller must hold `lockOrg`.
 * Returns the credit id, or null when the period has no credit left.
 */
export async function reserveForBid(db: Db, org: OrgRow, bidId: string, now: Date): Promise<string | null> {
  const period = await ensureCreditPeriod(db, org, now);
  const [credit] = await db.update(schema.rfpCredits).set({
    reserved: sql`${schema.rfpCredits.reserved} + 1`,
    updatedAt: now,
  }).where(and(
    eq(schema.rfpCredits.id, period.id),
    eq(schema.rfpCredits.orgId, org.id),
    sql`${schema.rfpCredits.used} + ${schema.rfpCredits.reserved} < ${schema.rfpCredits.allowed}`,
  )).returning({ id: schema.rfpCredits.id });
  if (!credit) {
    return null;
  }
  await db.update(schema.bids).set({
    creditId: credit.id,
    creditStatus: 'reserved',
    updatedAt: now,
  }).where(and(eq(schema.bids.id, bidId), eq(schema.bids.orgId, org.id)));
  return credit.id;
}

/**
 * Releases the bid's reservation, if it still holds one. Safe to call concurrently with the
 * worker and with itself: only the caller that flips `credit_status` from 'reserved' decrements.
 */
export async function releaseBidCredit(db: Db, orgId: string, bidId: string, creditId?: string): Promise<boolean> {
  const conditions = [
    eq(schema.bids.id, bidId),
    eq(schema.bids.orgId, orgId),
    eq(schema.bids.creditStatus, 'reserved'),
  ];
  if (creditId) {
    conditions.push(eq(schema.bids.creditId, creditId));
  }
  const [bid] = await db.update(schema.bids).set({
    creditStatus: 'released',
    updatedAt: new Date(),
  }).where(and(...conditions)).returning({ creditId: schema.bids.creditId });
  if (!bid?.creditId) {
    return false;
  }
  await db.update(schema.rfpCredits).set({
    reserved: sql`${schema.rfpCredits.reserved} - 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.rfpCredits.id, bid.creditId),
    eq(schema.rfpCredits.orgId, orgId),
    gt(schema.rfpCredits.reserved, 0),
  ));
  return true;
}

/**
 * An upload session that reserved a credit was abandoned (expired or cancelled; the caller has
 * already moved it out of 'open'). The reservation goes back, unless a solicitation document
 * already reached the bid, in which case that document's processing now owns the reservation
 * and the worker settles it.
 */
export async function releaseSessionCredit(db: Db, orgId: string, session: SessionRow): Promise<boolean> {
  if (!session.creditId) {
    return false;
  }
  const [solicitation] = await db.select({ id: schema.documents.id }).from(schema.documents).where(and(
    eq(schema.documents.bidId, session.bidId),
    eq(schema.documents.orgId, orgId),
    eq(schema.documents.kind, 'solicitation'),
  )).limit(1);
  if (solicitation) {
    return false;
  }
  return releaseBidCredit(db, orgId, session.bidId, session.creditId);
}

/**
 * Moves this organization's open sessions past their expiry to 'expired' and releases what they
 * reserved. The conditional UPDATE claims each session once, so a concurrent complete (which
 * needs `expires_at > now`) or another sweep cannot act on the same session. Returns the ids.
 */
export async function expireAbandonedUploads(db: Db, orgId: string, now: Date): Promise<string[]> {
  const expired = await db.update(schema.uploadSessions).set({
    status: 'expired',
    updatedAt: now,
  }).where(and(
    eq(schema.uploadSessions.orgId, orgId),
    eq(schema.uploadSessions.status, 'open'),
    lte(schema.uploadSessions.expiresAt, now),
  )).returning();
  for (const session of expired) {
    await releaseSessionCredit(db, orgId, session);
  }
  return expired.map((session) => session.id);
}

/** Documents the user has not deleted (live_status may be null before the first scan). */
export function notDeleted() {
  return sql`${schema.documents.liveStatus} is distinct from 'deleted'`;
}

/** Bytes a bid holds or has promised: live documents plus sessions still open. */
export async function bidBytesInUse(db: Db, orgId: string, bidId: string, now: Date): Promise<number> {
  const [documents] = await db.select({
    total: sql<string>`coalesce(sum(${schema.documents.sizeBytes}), 0)`,
  }).from(schema.documents).where(and(
    eq(schema.documents.bidId, bidId),
    eq(schema.documents.orgId, orgId),
    notDeleted(),
  ));
  const [sessions] = await db.select({
    total: sql<string>`coalesce(sum(${schema.uploadSessions.declaredSize}), 0)`,
  }).from(schema.uploadSessions).where(and(
    eq(schema.uploadSessions.bidId, bidId),
    eq(schema.uploadSessions.orgId, orgId),
    eq(schema.uploadSessions.status, 'open'),
    gt(schema.uploadSessions.expiresAt, now),
  ));
  return Number(documents?.total ?? 0) + Number(sessions?.total ?? 0);
}

/** Removes upload chunk folders. Best effort, after COMMIT: a leftover folder holds no credit. */
export async function removeChunkDirs(dataDir: string, orgId: string, sessionIds: string[]): Promise<void> {
  await Promise.all(sessionIds.map((id) => rm(join(dataDir, orgId, 'chunks', id), { recursive: true, force: true }).catch(() => undefined)));
}

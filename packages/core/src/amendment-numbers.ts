import { and, eq, gt, max, ne, or, sql } from 'drizzle-orm';
import type { AppDatabase } from './db';
import * as schema from './db/schema';

/**
 * Amendment numbers (04 s3.1, 03 s2). A number is 1 to 999, digits only.
 *
 * A number N is **taken** on a bid when another amendment of the bid holds it and either its
 * document is not deleted, or its amendment wrote rows (status `needs_confirmation` or
 * `applied`): deleting an amendment frees its number only if it never wrote rows. Upload start
 * also counts open, unexpired upload sessions that typed N (`includeSessions`), so two uploads are
 * not both started with one number; upload complete, the worker and PATCH count documents only
 * (a session that loses the race is refused at complete). Gaps are allowed.
 *
 * Callers hold the bid row FOR UPDATE (upload start and complete, the worker's key check, PATCH of
 * the number), so the check and the write that follows cannot interleave with another writer of
 * the bid's numbers. The partial unique index documents_bid_amendment_no_uq is a backstop.
 */

export const AMENDMENT_NO_MIN = 1;
export const AMENDMENT_NO_MAX = 999;

/** True for a whole number from 1 to 999. */
export function isAmendmentNo(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= AMENDMENT_NO_MIN && value <= AMENDMENT_NO_MAX;
}

export interface NumberScope {
  orgId: string;
  bidId: string;
  /** The amendment document asking (its own number never counts against it). */
  documentId?: string;
  /** Count open upload sessions too (upload start only). */
  includeSessions?: boolean;
  now?: Date;
}

/** Amendment documents of the bid that hold their number (see the rule above). */
function holdingDocuments(scope: NumberScope) {
  const conditions = [
    eq(schema.documents.orgId, scope.orgId),
    eq(schema.documents.bidId, scope.bidId),
    eq(schema.documents.kind, 'amendment'),
    or(
      sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
      sql`exists (select 1 from ${schema.amendments} where ${schema.amendments.documentId} = ${schema.documents.id}
        and ${schema.amendments.orgId} = ${scope.orgId}
        and ${schema.amendments.status} in ('needs_confirmation', 'applied'))`,
    ),
  ];
  if (scope.documentId) {
    conditions.push(ne(schema.documents.id, scope.documentId));
  }
  return and(...conditions);
}

/** Open, unexpired amendment upload sessions of the bid that typed a number. */
function holdingSessions(scope: NumberScope) {
  return and(
    eq(schema.uploadSessions.orgId, scope.orgId),
    eq(schema.uploadSessions.bidId, scope.bidId),
    eq(schema.uploadSessions.kind, 'amendment'),
    eq(schema.uploadSessions.status, 'open'),
    gt(schema.uploadSessions.expiresAt, scope.now ?? new Date()),
  );
}

/** True when `amendmentNo` is taken on the bid (see the rule at the top of this file). */
export async function amendmentNoTaken(db: AppDatabase, scope: NumberScope, amendmentNo: number): Promise<boolean> {
  const [document] = await db.select({ id: schema.documents.id }).from(schema.documents)
    .where(and(holdingDocuments(scope), eq(schema.documents.amendmentNo, amendmentNo))).limit(1);
  if (document) {
    return true;
  }
  if (!scope.includeSessions) {
    return false;
  }
  const [session] = await db.select({ id: schema.uploadSessions.id }).from(schema.uploadSessions)
    .where(and(holdingSessions(scope), eq(schema.uploadSessions.amendmentNo, amendmentNo))).limit(1);
  return Boolean(session);
}

/**
 * The next number in sequence: the highest number the bid's amendment documents hold plus 1 (1
 * when none holds one), or null past 999.
 */
export async function nextAmendmentNo(db: AppDatabase, scope: NumberScope): Promise<number | null> {
  const [documents] = await db.select({ top: max(schema.documents.amendmentNo) }).from(schema.documents)
    .where(holdingDocuments(scope));
  const next = (documents?.top ?? 0) + 1;
  return next <= AMENDMENT_NO_MAX ? next : null;
}

/** Postgres unique_violation on the documents_bid_amendment_no_uq backstop. */
export function isAmendmentNoConflict(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const record = cause as { code?: unknown; constraint?: unknown } | null;
  return record?.code === '23505' && record.constraint === 'documents_bid_amendment_no_uq';
}

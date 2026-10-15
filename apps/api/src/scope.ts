import { and, eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { isUuid, schema, withOrg } from '@pd/core';
import { releaseUnsharedReservation } from './credits.js';

export type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

const DEFERRED: unique symbol = Symbol('deferred reply');

/** Records the reply to send once the transaction has committed. */
export type Respond = (code: number, body: unknown) => typeof DEFERRED;

/**
 * `withOrg` for route handlers. Inside `fn`, answer with `respond(code, body)` (or return a
 * value for a 200), never with `reply`: the reply is sent only after COMMIT, so a client
 * never acts on rows that are not visible yet, or hears success for a transaction that then
 * fails. ESLint forbids `reply` inside `withOrg`/`inOrg` callbacks (eslint.config.mjs).
 */
export async function inOrg<T>(
  reply: FastifyReply,
  orgId: string,
  fn: (db: Db, respond: Respond) => Promise<T>,
): Promise<Exclude<T, typeof DEFERRED> | FastifyReply> {
  const state: { deferred: { code: number; body: unknown } | null } = { deferred: null };
  const respond: Respond = (code, body) => {
    state.deferred = { code, body };
    return DEFERRED;
  };
  const value = await withOrg(orgId, (db) => fn(db, respond));
  if (state.deferred) {
    return reply.code(state.deferred.code).send(state.deferred.body);
  }
  return value as Exclude<T, typeof DEFERRED>;
}

/**
 * The bid, if it belongs to `orgId`. Row-level security already hides other
 * organizations' bids; the explicit `org_id` condition is defense in depth.
 * A malformed id is treated as not found, so callers answer 404 the same way.
 */
export async function findBid(db: Db, orgId: string, bidId: string) {
  if (!isUuid(bidId)) {
    return null;
  }
  const [bid] = await db.select().from(schema.bids).where(and(
    eq(schema.bids.id, bidId),
    eq(schema.bids.orgId, orgId),
  ));
  return bid ?? null;
}

/**
 * What a route decided inside its transaction. The reply goes out, and any queue work
 * runs, only after `withOrg` has committed: a worker never picks up a job whose rows are
 * not visible yet, and the client never hears 201 for a transaction that rolled back.
 */
export interface Outcome {
  code: number;
  body: unknown;
  /** Job rows created in the transaction, each with the call that queues it. */
  queue?: QueuedJob[];
}

export interface QueuedJob {
  jobId: string;
  enqueue: () => Promise<void>;
  /**
   * A solicitation whose request reserved the bid's credit for this job (an upload complete or a
   * retry). If the queue call fails, the job never runs and so never settles it: the reservation
   * goes back while it is still this file's alone (releaseUnsharedReservation).
   */
  release?: { bidId: string; documentId: string };
}

/**
 * Runs the queue calls of a committed outcome. Every call is tried; a job whose call fails is
 * marked failed so the user can retry it, and the first error then propagates (500).
 */
export async function queueAfterCommit(orgId: string, outcome: Outcome): Promise<void> {
  let failure: { error: unknown } | null = null;
  for (const { jobId, enqueue, release } of outcome.queue ?? []) {
    try {
      await enqueue();
    } catch (error) {
      failure ??= { error };
      await withOrg(orgId, async (db) => {
        await db.update(schema.jobs).set({
          status: 'failed',
          error: 'The step could not be queued. Retry it.',
          updatedAt: new Date(),
        }).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.orgId, orgId)));
        // Lock order bid, credit: a reservation already settled, or shared with another file of
        // the bid, is left alone; the retry of the failed job reserves again if it needs to.
        if (release) {
          await releaseUnsharedReservation(db, orgId, release.bidId, release.documentId);
        }
      });
    }
  }
  if (failure) {
    throw failure.error;
  }
}

export async function findDocument(db: Db, orgId: string, documentId: string) {
  if (!isUuid(documentId)) {
    return null;
  }
  const [document] = await db.select().from(schema.documents).where(and(
    eq(schema.documents.id, documentId),
    eq(schema.documents.orgId, orgId),
  ));
  return document ?? null;
}

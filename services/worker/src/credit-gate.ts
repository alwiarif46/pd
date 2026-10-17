import { and, eq } from 'drizzle-orm';
import { schema, withOrg } from '@pd/core';
import { shareOrg } from './key-check.js';
import type { JobPayload } from './redis.js';
import { failStepIn, HELD_FOR_CREDIT, SOLICITATION_CREDIT_RELEASED } from './rows.js';

type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

/** What the credit gate decided: go on, or stop (the document is gone, or the file is held). */
export type CreditGate = 'go' | 'deleted' | 'held';

/**
 * Whether a file of the solicitation set may be processed now (06 s4): true when the bid holds a
 * reserved or consumed credit. Otherwise a failed classify row tells the user why and gives them
 * a retry: HELD_FOR_CREDIT for an attachment or amendment (kickHeldDocuments reruns it when the
 * solicitation's matrix consumes the credit), SOLICITATION_CREDIT_RELEASED for a solicitation (its
 * retry reserves a credit again). A deleted document stops without a row.
 *
 * Locks, in the order of credits.ts: organization (key share, for the job insert), document, bid,
 * all held until the caller's transaction ends. Holding the bid while the row is written
 * serialises it with the matrix run that consumes the credit (which also locks the bid): either
 * that run's kick, after its COMMIT, sees the held row, or this gate sees the credit consumed.
 */
export async function creditGate(db: Db, payload: JobPayload): Promise<CreditGate> {
  await shareOrg(db, payload.orgId);
  const [document] = await db.select({ liveStatus: schema.documents.liveStatus }).from(schema.documents).where(and(
    eq(schema.documents.id, payload.documentId),
    eq(schema.documents.orgId, payload.orgId),
  )).for('update');
  if (!document || document.liveStatus === 'deleted') {
    return 'deleted';
  }
  const [bid] = await db.select({ creditStatus: schema.bids.creditStatus }).from(schema.bids).where(and(
    eq(schema.bids.id, payload.bidId),
    eq(schema.bids.orgId, payload.orgId),
  )).for('update');
  if (!bid) {
    return 'deleted';
  }
  return heldUnlessCredited(db, payload, bid.creditStatus);
}

/**
 * The second half of creditGate, for a caller that already holds the organization (key share),
 * the document and the bid: records the held row when the bid holds no credit.
 */
export async function heldUnlessCredited(db: Db, payload: JobPayload, creditStatus: string | null): Promise<CreditGate> {
  if (creditStatus === 'reserved' || creditStatus === 'consumed') {
    return 'go';
  }
  await failStepIn(db, payload, 'classify', payload.kind === 'solicitation' ? SOLICITATION_CREDIT_RELEASED : HELD_FOR_CREDIT);
  return 'held';
}

/**
 * creditGate in its own transaction, taking its locks only when they matter: a first unlocked
 * read lets the usual case (document live, credit held) go on without locking anything, so a
 * matrix run's pre-check does not queue ahead of other writers of the document. A deleted
 * document stops there. Only when the credit looks missing does it run creditGate under its
 * locks, which reads again and records the held row. Going on after the unlocked read is safe:
 * the matrix write checks the credit again under the bid lock before it writes anything.
 */
export async function checkCredit(payload: JobPayload): Promise<CreditGate> {
  return withOrg(payload.orgId, async (db) => {
    const [row] = await db.select({ liveStatus: schema.documents.liveStatus, creditStatus: schema.bids.creditStatus })
      .from(schema.documents)
      .innerJoin(schema.bids, eq(schema.bids.id, schema.documents.bidId))
      .where(and(
        eq(schema.documents.id, payload.documentId),
        eq(schema.documents.orgId, payload.orgId),
        eq(schema.bids.id, payload.bidId),
      ));
    if (!row || row.liveStatus === 'deleted') {
      return 'deleted';
    }
    if (row.creditStatus === 'reserved' || row.creditStatus === 'consumed') {
      return 'go';
    }
    return creditGate(db, payload);
  });
}

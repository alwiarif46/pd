import { and, eq } from 'drizzle-orm';
import { isUuid, schema, type withOrg } from '@pd/core';

export type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

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

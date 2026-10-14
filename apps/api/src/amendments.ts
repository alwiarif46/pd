import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isUuid, schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { findBid } from './scope.js';

export async function registerAmendments(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/amendment-links', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const bid = await findBid(db, orgId, bidId);
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const amendments = await db.select({ id: schema.amendments.id }).from(schema.amendments).where(and(
        eq(schema.amendments.bidId, bidId),
        eq(schema.amendments.orgId, orgId),
      ));
      if (amendments.length === 0) {
        return [];
      }
      return db.select().from(schema.amendmentLinks).where(and(
        inArray(schema.amendmentLinks.amendmentId, amendments.map((amendment) => amendment.id)),
        eq(schema.amendmentLinks.orgId, orgId),
      ));
    });
  });

  app.post('/api/amendment-links/:id/confirm', { preHandler: requireAuth }, async (request, reply) => {
    return decide(request, reply, 'confirmed');
  });

  app.post('/api/amendment-links/:id/reject', { preHandler: requireAuth }, async (request, reply) => {
    return decide(request, reply, 'rejected');
  });
}

async function decide(
  request: FastifyRequest,
  reply: FastifyReply,
  status: 'confirmed' | 'rejected',
) {
  const orgId = request.auth!.orgId!;
  const linkId = (request.params as { id: string }).id;
  if (!isUuid(linkId)) {
    return reply.code(404).send({ error: 'Amendment link not found' });
  }
  return withOrg(orgId, async (db) => {
    const [link] = await db.select().from(schema.amendmentLinks).where(and(
      eq(schema.amendmentLinks.id, linkId),
      eq(schema.amendmentLinks.orgId, orgId),
    ));
    if (!link) {
      return reply.code(404).send({ error: 'Amendment link not found' });
    }
    // The link's bid, through its amendment. The row it supersedes must be on that same bid.
    const [amendment] = await db.select().from(schema.amendments).where(and(
      eq(schema.amendments.id, link.amendmentId),
      eq(schema.amendments.orgId, orgId),
    ));
    if (!amendment) {
      return reply.code(404).send({ error: 'Amendment link not found' });
    }
    await db.update(schema.amendmentLinks).set({
      status,
      decidedBy: request.auth!.userId,
      updatedAt: new Date(),
    }).where(and(eq(schema.amendmentLinks.id, linkId), eq(schema.amendmentLinks.orgId, orgId)));
    if (status === 'confirmed' && link.oldRowId && (link.action === 'supersede' || link.action === 'withdraw')) {
      await db.update(schema.complianceRows).set({
        supersedeStatus: link.action === 'supersede' ? 'superseded' : 'withdrawn',
        supersededByRowId: link.action === 'supersede' ? link.newRowId : null,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.complianceRows.id, link.oldRowId),
        eq(schema.complianceRows.bidId, amendment.bidId),
        eq(schema.complianceRows.orgId, orgId),
      ));
    }
    return { ok: true };
  });
}

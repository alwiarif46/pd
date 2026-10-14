import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';

export async function registerAmendments(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/amendment-links', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return withOrg(orgId, async (db) => {
      const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, bidId));
      if (!bid) {
        return reply.code(404).send({ error: 'Bid not found' });
      }
      const amendments = await db.select().from(schema.amendments).where(eq(schema.amendments.bidId, bidId));
      const links = [];
      for (const amendment of amendments) {
        const rows = await db.select().from(schema.amendmentLinks).where(eq(schema.amendmentLinks.amendmentId, amendment.id));
        links.push(...rows);
      }
      return links;
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
  return withOrg(orgId, async (db) => {
    const [link] = await db.select().from(schema.amendmentLinks).where(eq(schema.amendmentLinks.id, linkId));
    if (!link) {
      return reply.code(404).send({ error: 'Amendment link not found' });
    }
    await db.update(schema.amendmentLinks).set({
      status,
      decidedBy: request.auth!.userId,
      updatedAt: new Date(),
    }).where(eq(schema.amendmentLinks.id, linkId));
    if (status === 'confirmed' && link.oldRowId && (link.action === 'supersede' || link.action === 'withdraw')) {
      await db.update(schema.complianceRows).set({
        supersedeStatus: link.action === 'supersede' ? 'superseded' : 'withdrawn',
        supersededByRowId: link.action === 'supersede' ? link.newRowId : null,
        updatedAt: new Date(),
      }).where(eq(schema.complianceRows.id, link.oldRowId));
    }
    return { ok: true };
  });
}

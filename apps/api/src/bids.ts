import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema, withOrg } from '@pd/core';
import { requireAuth } from './context.js';
import { findBid, inOrg } from './scope.js';

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
    const solicitationNumber = body.solicitationNumber?.trim() || 'PENDING';
    return inOrg(reply, orgId, async (db, respond) => {
      const [bid] = await db.insert(schema.bids).values({
        orgId,
        name,
        bidType: body.bidType!,
        solicitationNumber,
        solicitationKey: solicitationNumber,
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
    const orgId = request.auth!.orgId!;
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
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      const name = body.name?.trim();
      const solicitationNumber = body.solicitationNumber?.trim();
      await db.update(schema.bids).set({
        name: name || bid.name,
        agency: body.agency === undefined ? bid.agency : body.agency,
        bidType: body.bidType === 'federal' || body.bidType === 'sled' ? body.bidType : bid.bidType,
        solicitationNumber: solicitationNumber || bid.solicitationNumber,
        startDate: body.startDate === undefined ? bid.startDate : (body.startDate ? new Date(body.startDate) : null),
        dueDate: body.dueDate === undefined ? bid.dueDate : (body.dueDate ? new Date(body.dueDate) : null),
        dueTime: body.dueTime === undefined ? bid.dueTime : body.dueTime,
        timeZone: body.timeZone === undefined ? bid.timeZone : body.timeZone,
        oralsEnabled: body.oralsEnabled === undefined ? bid.oralsEnabled : body.oralsEnabled,
        retentionExtendedUntil: body.retentionExtendedUntil === undefined
          ? bid.retentionExtendedUntil
          : (body.retentionExtendedUntil ? new Date(body.retentionExtendedUntil) : null),
        updatedAt: new Date(),
      }).where(and(eq(schema.bids.id, id), eq(schema.bids.orgId, orgId)));
      const updated = await findBid(db, orgId, id);
      return updated;
    });
  });

  app.delete('/api/bids/:id', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const id = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, id);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      await db.delete(schema.bids).where(and(eq(schema.bids.id, id), eq(schema.bids.orgId, orgId)));
      return { ok: true };
    });
  });
}

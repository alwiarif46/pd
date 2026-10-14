import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isUuid, PLAN_LIMITS, type Plan, schema, userMemberships, withOrg } from '@pd/core';
import { requireAuth, requireUser } from './context.js';
import { inOrg } from './scope.js';
import { hashToken, isWorkEmail, logOutOfBand, newToken } from './security.js';

function seatLimit(plan: Plan): number {
  return PLAN_LIMITS[plan].maxUsers;
}

export async function registerOrg(app: FastifyInstance): Promise<void> {
  app.post('/api/org', { preHandler: requireUser }, async (request, reply) => {
    const auth = request.auth!;
    // Check the user's memberships, not auth.orgId: an X-Org-Id header naming an org the
    // user does not belong to leaves auth.orgId unset even when they belong to another.
    if ((await userMemberships(auth.userId)).length > 0) {
      return reply.code(409).send({ error: 'You already belong to an organization' });
    }
    const name = ((request.body as { name?: string }).name ?? '').trim();
    if (!name) {
      return reply.code(400).send({ error: 'Organization name is required' });
    }
    // The new organization's id is chosen here so its first membership is written under
    // row-level security with app.org_id already set to it.
    const orgId = randomUUID();
    const org = await withOrg(orgId, async (db) => {
      const [created] = await db.insert(schema.organizations).values({
        id: orgId,
        name,
        plan: 'free',
        planStatus: 'active',
      }).returning();
      await db.insert(schema.memberships).values({
        orgId,
        userId: auth.userId,
        role: 'owner',
      });
      return created;
    });
    return reply.code(201).send({ id: org.id, name: org.name, plan: org.plan });
  });

  app.get('/api/org', { preHandler: requireAuth }, async (request) => {
    const auth = request.auth!;
    return withOrg(auth.orgId!, async (db) => {
      const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, auth.orgId!));
      const credits = await db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.orgId, auth.orgId!));
      return { org: org ?? null, credits: credits[0] ?? null, role: auth.role };
    });
  });

  app.get('/api/about/processing', { preHandler: requireAuth }, async () => {
    const provider = process.env.AI_PROVIDER || 'deepinfra';
    const model = process.env.AI_MODEL || 'the configured model';
    return {
      provider,
      model,
      subprocessors: ['DeepInfra', 'Anthropic', 'Telnyx', 'Stripe'],
      privacyPath: '/#/privacy',
    };
  });

  app.patch('/api/org', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    if (auth.role !== 'owner') {
      return reply.code(403).send({ error: 'Only the owner can change the organization' });
    }
    const name = ((request.body as { name?: string }).name ?? '').trim();
    return withOrg(auth.orgId!, async (db) => {
      await db.update(schema.organizations).set({ name, updatedAt: new Date() }).where(eq(schema.organizations.id, auth.orgId!));
      return { ok: true };
    });
  });

  app.get('/api/org/members', { preHandler: requireAuth }, async (request) => {
    const auth = request.auth!;
    return withOrg(auth.orgId!, async (db) => {
      return db.select().from(schema.memberships).where(eq(schema.memberships.orgId, auth.orgId!));
    });
  });

  app.post('/api/org/invites', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    if (auth.role !== 'owner') {
      return reply.code(403).send({ error: 'Only the owner can invite' });
    }
    const email = ((request.body as { email?: string }).email ?? '').trim().toLowerCase();
    if (!isWorkEmail(email)) {
      return reply.code(400).send({ error: 'Use a work email address' });
    }
    return inOrg(reply, auth.orgId!, async (db, respond) => {
      const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, auth.orgId!));
      const members = await db.select().from(schema.memberships).where(eq(schema.memberships.orgId, auth.orgId!));
      const plan = (org?.plan ?? 'free') as Plan;
      if (members.length >= seatLimit(plan)) {
        return respond(402, { error: 'This plan has no seats left' });
      }
      const token = newToken();
      await db.insert(schema.invites).values({
        orgId: auth.orgId!,
        email,
        role: 'member',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      logOutOfBand('email', email, token);
      return respond(201, { ok: true });
    });
  });

  app.delete('/api/org/members/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    if (auth.role !== 'owner') {
      return reply.code(403).send({ error: 'Only the owner can remove a member' });
    }
    const userId = (request.params as { userId: string }).userId;
    if (userId === auth.userId) {
      return reply.code(400).send({ error: 'Transfer ownership before leaving' });
    }
    if (!isUuid(userId)) {
      return reply.code(404).send({ error: 'Member not found' });
    }
    return inOrg(reply, auth.orgId!, async (db, respond) => {
      const removed = await db.delete(schema.memberships).where(and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.orgId, auth.orgId!),
      )).returning({ id: schema.memberships.id });
      if (removed.length === 0) {
        return respond(404, { error: 'Member not found' });
      }
      return { ok: true };
    });
  });
}

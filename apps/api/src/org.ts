import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isUuid, mbCapForPlan, PLAN_LIMITS, type Plan, schema, userMemberships, withOrg } from '@pd/core';
import { billingAvailable, registerBilling } from './billing.js';
import { requireAuth, requireUser } from './context.js';
import { BODY_REQUIRED, readBody, text } from './body.js';
import { currentCreditPeriod, expireAbandonedUploads, removeChunkDirs } from './credits.js';
import { inOrg } from './scope.js';
import { hashToken, isWorkEmail, newToken, sendOutOfBand } from './security.js';

/** The organization fields GET /api/org returns (no Stripe customer or subscription id). */
const PUBLIC_ORG_COLUMNS = {
  id: schema.organizations.id,
  createdAt: schema.organizations.createdAt,
  updatedAt: schema.organizations.updatedAt,
  name: schema.organizations.name,
  emailDomain: schema.organizations.emailDomain,
  plan: schema.organizations.plan,
  planStatus: schema.organizations.planStatus,
  cycleStart: schema.organizations.cycleStart,
  cycleEnd: schema.organizations.cycleEnd,
  freeFirstMonthEnds: schema.organizations.freeFirstMonthEnds,
};

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
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const name = text(body, 'name').trim();
    if (!name) {
      return reply.code(400).send({ error: 'Organization name is required' });
    }
    // The new organization's id is chosen here so its first membership is written under
    // row-level security with app.org_id already set to it.
    const orgId = randomUUID();
    return inOrg(reply, orgId, async (db, respond) => {
      // Two concurrent creates for one user: serialize them on a per-user advisory lock held
      // until this transaction ends, then check memberships again with a fresh snapshot.
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org-create:${auth.userId}`}, 0))`);
      const existing = await db.execute(sql`select 1 from pd_system.user_memberships(${auth.userId})`);
      if (existing.rows.length > 0) {
        return respond(409, { error: 'You already belong to an organization' });
      }
      const [created] = await db.insert(schema.organizations).values({
        id: orgId,
        name,
        plan: 'free',
        planStatus: 'free',
      }).returning();
      await db.insert(schema.memberships).values({
        orgId,
        userId: auth.userId,
        role: 'owner',
      });
      return respond(201, { id: created.id, name: created.name, plan: created.plan });
    });
  });

  app.get('/api/org', { preHandler: requireAuth }, async (request) => {
    const auth = request.auth!;
    const orgId = auth.orgId!;
    const abandoned: string[] = [];
    const result = await withOrg(orgId, async (db) => {
      const now = new Date();
      // Abandoned uploads give their reserved credits back before the counts are shown.
      abandoned.push(...await expireAbandonedUploads(db, orgId, now));
      // Stripe ids stay on the server: members see this payload too, and the web never needs them.
      const [org] = await db.select(PUBLIC_ORG_COLUMNS).from(schema.organizations).where(eq(schema.organizations.id, orgId));
      // The period that holds now, or null before the first credit of this period is reserved.
      const credits = await currentCreditPeriod(db, orgId, now);
      const plan = (org?.plan ?? 'free') as Plan;
      return {
        org: org ?? null,
        credits,
        role: auth.role,
        seatLimit: seatLimit(plan),
        mbCap: mbCapForPlan(plan),
        billingAvailable: billingAvailable(),
      };
    });
    await removeChunkDirs(process.env.DATA_DIR || '/data/files', orgId, abandoned);
    return result;
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
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const name = text(body, 'name').trim();
    return withOrg(auth.orgId!, async (db) => {
      await db.update(schema.organizations).set({ name, updatedAt: new Date() }).where(eq(schema.organizations.id, auth.orgId!));
      return { ok: true };
    });
  });

  app.get('/api/org/members', { preHandler: requireAuth }, async (request) => {
    const auth = request.auth!;
    const orgId = auth.orgId!;
    return withOrg(orgId, async (db) => {
      // `users` has no row-level security; the join starts from this organization's memberships.
      const rows = await db.select({
        orgId: schema.memberships.orgId,
        userId: schema.memberships.userId,
        name: schema.users.name,
        email: schema.users.email,
        role: schema.memberships.role,
        joinedAt: schema.memberships.createdAt,
      }).from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.orgId, orgId))
        .orderBy(schema.memberships.createdAt, schema.memberships.id);
      return rows.map((row) => ({ ...row, isYou: row.userId === auth.userId }));
    });
  });

  app.post('/api/org/invites', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    if (auth.role !== 'owner') {
      return reply.code(403).send({ error: 'Only the owner can invite' });
    }
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const email = text(body, 'email').trim().toLowerCase();
    if (!isWorkEmail(email)) {
      return reply.code(400).send({ error: 'Use a work email address' });
    }
    // Delivered only after COMMIT, so the link never names an invite that rolled back.
    let issued = null as string | null;
    const result = await inOrg(reply, auth.orgId!, async (db, respond) => {
      const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, auth.orgId!));
      const members = await db.select().from(schema.memberships).where(eq(schema.memberships.orgId, auth.orgId!));
      const plan = (org?.plan ?? 'free') as Plan;
      if (members.length >= seatLimit(plan)) {
        return respond(402, { error: 'This plan has no seats left' });
      }
      const token = newToken();
      issued = token;
      await db.insert(schema.invites).values({
        orgId: auth.orgId!,
        email,
        role: 'member',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      return respond(201, { ok: true });
    });
    if (issued) {
      void sendOutOfBand({ channel: 'email', purpose: 'invite', to: email, secret: issued });
    }
    return result;
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

  await registerBilling(app);
}

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb, isUuid, newMemberHoldsSeat, schema, seatHolders, seatLimitFor } from '@pd/core';
import { requireUser } from './context.js';
import { readBody } from './body.js';
import { lockOrg } from './credits.js';
import { apiError } from './errors.js';
import { type Db, inOrg } from './scope.js';
import { hashToken } from './security.js';

const TOKEN = /^[0-9a-f]{64}$/;

/**
 * An invite code is `<orgId>.<token>` (org.ts POST /api/org/invites). The organization id lets
 * the lookup run under that organization's row-level security: a signed-in user who is not a
 * member yet has no `app.org_id` of their own. A wrong or foreign id only finds nothing.
 */
export function parseInviteCode(code: unknown): { orgId: string; token: string } | null {
  if (typeof code !== 'string') {
    return null;
  }
  const trimmed = code.trim();
  const dot = trimmed.indexOf('.');
  if (dot < 0) {
    return null;
  }
  const orgId = trimmed.slice(0, dot).toLowerCase();
  const token = trimmed.slice(dot + 1);
  return isUuid(orgId) && TOKEN.test(token) ? { orgId, token } : null;
}

export async function registerInvites(app: FastifyInstance): Promise<void> {
  /**
   * Accepts an invite for the signed-in user. Body `{ code }`. 200 `{ orgId, name, role,
   * alreadyMember }`; errors carry a code: invite_invalid (404, 400 without a body),
   * invite_email_mismatch (403), invite_used, invite_expired, already_in_org, seats_full (409).
   * The invite's email address is never sent back.
   */
  app.post('/api/invites/accept', { preHandler: requireUser }, async (request, reply) => {
    const { userId } = request.auth!;
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(apiError('invite_invalid'));
    }
    const parsed = parseInviteCode(body.code);
    if (!parsed) {
      return reply.code(404).send(apiError('invite_invalid'));
    }
    const { orgId, token } = parsed;
    // `users` has no row-level security (as GET /api/me).
    const [user] = await getDb().select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId));
    if (!user) {
      return reply.code(401).send({ error: 'Sign in required' });
    }
    const email = user.email.trim().toLowerCase();

    const tokenHash = hashToken(token);

    return inOrg(reply, orgId, async (db, respond) => {
      // First an unlocked read: a code that matches no invite of this organization (a guessed
      // token, or a foreign or unknown org id, hidden by row-level security) answers 404 without
      // taking any lock, so nobody can hold an organization's row with made-up codes.
      const [match] = await db.select({ id: schema.invites.id }).from(schema.invites).where(and(
        eq(schema.invites.orgId, orgId),
        eq(schema.invites.tokenHash, tokenHash),
      )).limit(1);
      if (!match) {
        return respond(404, apiError('invite_invalid'));
      }
      // Lock order: the per-user advisory lock, then the organization row, then the invite row
      // (credits.ts lists it). POST /api/org takes the same user lock (and only a new org row
      // nobody else sees); invite creation and billing take only the organization row. So a
      // create-org and an accept for one user, or two accepts by one user, run one after the
      // other, and nothing waits in a cycle.
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org-create:${userId}`}, 0))`);
      // A fresh statement after the lock: sees memberships committed while this one waited.
      const memberOf = await db.execute<{ org_id: string; role: 'owner' | 'member' }>(
        sql`select org_id, role from pd_system.user_memberships(${userId})`,
      );
      const here = memberOf.rows.find((row) => row.org_id === orgId);
      const elsewhere = memberOf.rows.some((row) => row.org_id !== orgId);

      // Row-level security hides another organization's row, so a foreign id is "not found".
      const org = await lockOrg(db, orgId);
      if (!org) {
        return respond(404, apiError('invite_invalid'));
      }
      const [invite] = await db.select().from(schema.invites).where(and(
        eq(schema.invites.orgId, orgId),
        eq(schema.invites.id, match.id),
      )).for('update').limit(1);
      // Only member invites are issued. Refuse any other role rather than skip the seat check.
      if (!invite || invite.role !== 'member') {
        return respond(404, apiError('invite_invalid'));
      }
      if (invite.email.trim().toLowerCase() !== email) {
        return respond(403, apiError('invite_email_mismatch'));
      }
      if (invite.acceptedAt) {
        // A double click, or a second tab: the same user already joined with this invite.
        if (here) {
          return { orgId, name: org.name, role: here.role, alreadyMember: true };
        }
        return respond(409, apiError('invite_used'));
      }
      const now = new Date();
      if (invite.expiresAt <= now) {
        return respond(409, apiError('invite_expired'));
      }
      if (here) {
        // Already a member some other way: use the invite up so it stops holding a seat.
        await markAccepted(db, invite.id, now);
        return { orgId, name: org.name, role: here.role, alreadyMember: true };
      }
      if (elsewhere) {
        // One organization per account (as POST /api/org). The invite stays pending.
        return respond(409, apiError('already_in_org'));
      }
      // Seats (06 s5), under the organization lock and read after it, so two accepts at once
      // cannot both take the last seat. Only memberships count: other pending invites were
      // admitted under the limit when created, and after a downgrade the first to accept wins.
      // A refused invite stays pending and works once a seat is free, until it expires.
      if (!newMemberHoldsSeat(await seatHolders(db, orgId), seatLimitFor(org.plan))) {
        return respond(409, apiError('seats_full'));
      }
      // Dated by the database clock after the locks. The column default (now()) is the
      // transaction start, which could date this member before one who joined while this waited;
      // seat order follows created_at. In UTC wall-clock time, as the api stores every timestamp
      // (0005; drizzle reads timestamp without time zone as UTC), whatever the session time zone.
      await db.insert(schema.memberships).values({
        orgId,
        userId,
        role: invite.role,
        createdAt: sql`(clock_timestamp() at time zone 'UTC')`,
      });
      await markAccepted(db, invite.id, now);
      return { orgId, name: org.name, role: invite.role, alreadyMember: false };
    });
  });
}

async function markAccepted(db: Db, inviteId: string, now: Date): Promise<void> {
  await db.update(schema.invites).set({ acceptedAt: now, updatedAt: now })
    .where(and(eq(schema.invites.id, inviteId), isNull(schema.invites.acceptedAt)));
}

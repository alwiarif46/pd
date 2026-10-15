import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb, schema, seatHolders, userMemberships, withOrg } from '@pd/core';
import { apiError } from './errors.js';
import { hashToken } from './security.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  orgId?: string;
  role?: 'owner' | 'member';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    reply.code(401).send({ error: 'Sign in required' });
    return;
  }
  // `sessions` has no org_id and no row-level security.
  const db = getDb();
  const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    reply.code(401).send({ error: 'Sign in required' });
    return;
  }
  // The organization is not known yet, so this goes through the pd_system lookup function,
  // not a tenant-table read (02 s4).
  const memberships = await userMemberships(session.userId);
  const requestedOrg = request.headers['x-org-id'];
  const orgId = typeof requestedOrg === 'string' ? requestedOrg : memberships[0]?.orgId;
  const membership = memberships.find((item) => item.orgId === orgId);
  request.auth = {
    userId: session.userId,
    sessionId: session.id,
    orgId: membership?.orgId,
    role: membership?.role,
  };
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply);
  if (reply.sent || !request.auth?.orgId || !request.auth.role) {
    if (!reply.sent) {
      reply.code(403).send({ error: 'No organization' });
    }
    return;
  }
  // Seats after a move to a smaller plan (06 s5): a member beyond the plan's seats keeps the
  // membership but has no access until the owner removes members or upgrades. Owners always
  // hold a seat, so they are never checked. One query, under row-level security.
  if (request.auth.role === 'member') {
    const { orgId, userId } = request.auth;
    const seats = await withOrg(orgId, (db) => seatHolders(db, orgId));
    if (seats.find((seat) => seat.userId === userId)?.seatLocked !== false) {
      reply.code(403).send(apiError('seat_locked'));
    }
  }
}

import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb, schema, userMemberships } from '@pd/core';
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
  }
}

import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '@pd/core';
import { requireUser } from './context.js';
import {
  hashPassword,
  hashToken,
  isUsPhone,
  isWorkEmail,
  logOutOfBand,
  newPhoneCode,
  newToken,
  passwordMatches,
  recordSmsSend,
} from './security.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/signup', async (request, reply) => {
    const body = request.body as { email?: string; name?: string; password?: string; phone?: string };
    const email = body.email?.trim().toLowerCase() ?? '';
    const phone = body.phone?.trim() ?? '';
    const password = body.password ?? '';
    if (!email.includes('@') || !isWorkEmail(email)) {
      return reply.code(400).send({ error: 'Use a work email address' });
    }
    if (password.length < 12) {
      return reply.code(400).send({ error: 'Password must be at least 12 characters' });
    }
    if (!isUsPhone(phone)) {
      return reply.code(400).send({ error: 'Use a +1 US phone number' });
    }
    const db = getDb();
    const [existingPhone] = await db.select().from(schema.users).where(eq(schema.users.phoneE164, phone));
    if (existingPhone) {
      return reply.code(409).send({ error: 'That phone number is already verified on an account' });
    }
    const ip = request.ip;
    const sinceHour = new Date(Date.now() - HOUR);
    const recentCodes = await db.select().from(schema.phoneCodes).where(and(
      eq(schema.phoneCodes.phoneE164, phone),
      gt(schema.phoneCodes.createdAt, sinceHour),
    ));
    if (recentCodes.length >= 3) {
      return reply.code(429).send({ error: 'Too many codes for this number. Try again later.' });
    }
    const cap = recordSmsSend(ip, email);
    if (!cap.ok) {
      return reply.code(429).send({ error: cap.reason });
    }
    const userId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      email,
      name: body.name ?? null,
      phoneE164: phone,
      passwordHash: await hashPassword(password),
    });
    const emailToken = newToken();
    const code = newPhoneCode();
    await db.insert(schema.authTokens).values({
      userId,
      purpose: 'verify_email',
      tokenHash: hashToken(emailToken),
      expiresAt: new Date(Date.now() + DAY),
    });
    await db.insert(schema.phoneCodes).values({
      phoneE164: phone,
      codeHash: hashToken(code),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    logOutOfBand('email', email, emailToken);
    logOutOfBand('sms', phone, code);
    return reply.code(201).send({ userId });
  });

  app.post('/api/auth/verify-email', async (request, reply) => {
    const token = (request.body as { token?: string }).token ?? '';
    const db = getDb();
    const [row] = await db.select().from(schema.authTokens).where(and(
      eq(schema.authTokens.tokenHash, hashToken(token)),
      eq(schema.authTokens.purpose, 'verify_email'),
    ));
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      return reply.code(400).send({ error: 'That email link is not valid' });
    }
    await db.update(schema.authTokens).set({ usedAt: new Date() }).where(eq(schema.authTokens.id, row.id));
    await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, row.userId));
    return { ok: true };
  });

  app.post('/api/auth/verify-phone', async (request, reply) => {
    const body = request.body as { phone?: string; code?: string };
    const phone = body.phone?.trim() ?? '';
    const db = getDb();
    const [row] = await db.select().from(schema.phoneCodes).where(eq(schema.phoneCodes.phoneE164, phone));
    if (!row || row.expiresAt < new Date()) {
      return reply.code(400).send({ error: 'That code is not valid' });
    }
    if (row.attempts >= 5) {
      return reply.code(429).send({ error: 'Too many attempts' });
    }
    if (row.codeHash !== hashToken(body.code ?? '')) {
      await db.update(schema.phoneCodes).set({ attempts: sql`${schema.phoneCodes.attempts} + 1` }).where(eq(schema.phoneCodes.id, row.id));
      return reply.code(400).send({ error: 'That code is not valid' });
    }
    await db.update(schema.users).set({ phoneVerifiedAt: new Date() }).where(eq(schema.users.phoneE164, phone));
    return { ok: true };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    const email = body.email?.trim().toLowerCase() ?? '';
    const db = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user || !(await passwordMatches(body.password ?? '', user.passwordHash))) {
      return reply.code(401).send({ error: 'Email or password is wrong' });
    }
    if (!user.emailVerifiedAt || !user.phoneVerifiedAt) {
      return reply.code(403).send({ error: 'Verify email and phone before signing in' });
    }
    const token = newToken();
    await db.insert(schema.sessions).values({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 14 * DAY),
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
    return { token };
  });

  app.post('/api/auth/logout', { preHandler: requireUser }, async (request) => {
    const db = getDb();
    await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, request.auth!.sessionId));
    return { ok: true };
  });

  app.post('/api/auth/reset', async (request, reply) => {
    const body = request.body as { email?: string; token?: string; password?: string };
    const db = getDb();
    if (body.token) {
      if ((body.password ?? '').length < 12) {
        return reply.code(400).send({ error: 'Password must be at least 12 characters' });
      }
      const [row] = await db.select().from(schema.authTokens).where(and(
        eq(schema.authTokens.tokenHash, hashToken(body.token)),
        eq(schema.authTokens.purpose, 'reset_password'),
      ));
      if (!row || row.usedAt || row.expiresAt < new Date()) {
        return reply.code(400).send({ error: 'That reset link is not valid' });
      }
      await db.update(schema.users).set({ passwordHash: await hashPassword(body.password ?? '') }).where(eq(schema.users.id, row.userId));
      await db.update(schema.authTokens).set({ usedAt: new Date() }).where(eq(schema.authTokens.id, row.id));
      return { ok: true };
    }
    const email = (body.email ?? '').trim().toLowerCase();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user) {
      return { ok: true };
    }
    const token = newToken();
    await db.insert(schema.authTokens).values({
      userId: user.id,
      purpose: 'reset_password',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + HOUR),
    });
    logOutOfBand('email', email, token);
    return reply.send({ ok: true });
  });

  app.get('/api/me', { preHandler: requireUser }, async (request) => {
    const db = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, request.auth!.userId));
    return {
      id: user?.id,
      email: user?.email,
      name: user?.name,
      phone: user?.phoneE164,
      orgId: request.auth!.orgId ?? null,
    };
  });

  app.patch('/api/me', { preHandler: requireUser }, async (request, reply) => {
    const body = request.body as { name?: string; password?: string };
    const db = getDb();
    if (body.password !== undefined && body.password.length < 12) {
      return reply.code(400).send({ error: 'Password must be at least 12 characters' });
    }
    const name = body.name?.trim();
    await db.update(schema.users).set({
      ...(name !== undefined ? { name } : {}),
      ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
    }).where(eq(schema.users.id, request.auth!.userId));
    return { ok: true };
  });
}

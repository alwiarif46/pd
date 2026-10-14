import { and, desc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb, schema } from '@pd/core';
import { requireUser } from './context.js';
import {
  hashesMatch,
  hashPassword,
  hashToken,
  isUsPhone,
  isWorkEmail,
  newPhoneCode,
  newToken,
  passwordMatches,
  recordEmailSend,
  recordSmsSend,
  sendOutOfBand,
} from './security.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 06 s1: a code is valid 10 minutes, allows 5 attempts, and a number gets 3 sends an hour. */
const CODE_TTL = 10 * MINUTE;
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 3;
/** The same hourly limit for verification emails per account. */
const EMAILS_PER_HOUR = 3;

/**
 * The resend routes answer no sooner than this, whether or not an account exists, so the
 * response time does not tell an unknown address from a known one. Delivery runs after the
 * reply is decided and is not awaited, so a slow provider does not show either.
 */
const RESEND_MIN_MS = 300;

const BODY_REQUIRED = { error: 'Send a JSON object in the request body' } as const;
const CODE_INVALID = { error: 'That code is not valid' } as const;
const EMAIL_TAKEN = { error: 'An account with this email already exists. Log in or reset your password.' } as const;
const PHONE_TAKEN = { error: 'That phone number is already verified on an account' } as const;

type Body = Record<string, unknown>;

/** The JSON object body, or null when the body is missing or not an object. */
function readBody(request: FastifyRequest): Body | null {
  const body: unknown = request.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Body) : null;
}

/** A string field, or '' when it is missing or not a string. */
function text(body: Body, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** The constraint a unique violation (23505) names, or null for any other error. */
function uniqueViolation(error: unknown): string | null {
  for (let current: unknown = error; current && typeof current === 'object'; current = (current as { cause?: unknown }).cause) {
    const candidate = current as { code?: unknown; constraint?: unknown };
    if (candidate.code === '23505') {
      return typeof candidate.constraint === 'string' ? candidate.constraint : '';
    }
  }
  return null;
}

async function atLeast<T>(ms: number, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await work();
  const left = ms - (Date.now() - started);
  if (left > 0) {
    await new Promise((resolve) => setTimeout(resolve, left));
  }
  return result;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/signup', async (request, reply) => {
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const email = text(body, 'email').trim().toLowerCase();
    const phone = text(body, 'phone').trim();
    const password = text(body, 'password');
    const name = text(body, 'name').trim() || null;
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
    const [existingEmail] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    if (existingEmail) {
      return reply.code(409).send(EMAIL_TAKEN);
    }
    const [existingPhone] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.phoneE164, phone));
    if (existingPhone) {
      return reply.code(409).send(PHONE_TAKEN);
    }
    const recentCodes = await db.select({ id: schema.phoneCodes.id }).from(schema.phoneCodes).where(and(
      eq(schema.phoneCodes.phoneE164, phone),
      gt(schema.phoneCodes.createdAt, new Date(Date.now() - HOUR)),
    ));
    if (recentCodes.length >= CODES_PER_HOUR) {
      return reply.code(429).send({ error: 'Too many codes for this number. Try again later.' });
    }
    const cap = recordSmsSend(request.ip, [`email:${email}`, `phone:${phone}`]);
    if (!cap.ok) {
      return reply.code(429).send({ error: cap.reason });
    }
    const passwordHash = await hashPassword(password);
    const emailToken = newToken();
    const code = newPhoneCode();
    let userId: string;
    try {
      userId = await db.transaction(async (tx) => {
        const [user] = await tx.insert(schema.users).values({ email, name, phoneE164: phone, passwordHash }).returning({ id: schema.users.id });
        await tx.insert(schema.authTokens).values({
          userId: user.id,
          purpose: 'verify_email',
          tokenHash: hashToken(emailToken),
          expiresAt: new Date(Date.now() + DAY),
        });
        await tx.insert(schema.phoneCodes).values({
          userId: user.id,
          phoneE164: phone,
          codeHash: hashToken(code),
          expiresAt: new Date(Date.now() + CODE_TTL),
        });
        return user.id;
      });
    } catch (error) {
      // Two signups racing past the checks above: the unique constraints decide.
      const constraint = uniqueViolation(error);
      if (constraint === null) {
        throw error;
      }
      return reply.code(409).send(constraint.includes('phone') ? PHONE_TAKEN : EMAIL_TAKEN);
    }
    void sendOutOfBand({ channel: 'email', purpose: 'verify_email', to: email, secret: emailToken });
    void sendOutOfBand({ channel: 'sms', purpose: 'verify_phone', to: phone, secret: code });
    return reply.code(201).send({ userId });
  });

  app.post('/api/auth/verify-email', async (request, reply) => {
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const token = text(body, 'token');
    const invalid = { error: 'That email link is not valid' };
    if (!token) {
      return reply.code(400).send(invalid);
    }
    const db = getDb();
    const verified = await db.transaction(async (tx) => {
      const [row] = await tx.update(schema.authTokens).set({ usedAt: new Date(), updatedAt: new Date() }).where(and(
        eq(schema.authTokens.tokenHash, hashToken(token)),
        eq(schema.authTokens.purpose, 'verify_email'),
        isNull(schema.authTokens.usedAt),
        gt(schema.authTokens.expiresAt, new Date()),
      )).returning({ userId: schema.authTokens.userId });
      if (!row) {
        return false;
      }
      await tx.update(schema.users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, row.userId));
      return true;
    });
    if (!verified) {
      return reply.code(400).send(invalid);
    }
    return { ok: true };
  });

  /**
   * Checks a phone code. This runs before the user can sign in (login needs a verified phone),
   * so the account is the one that owns the phone number (unique on users), and only that
   * account's latest code counts: unused, unexpired, and under its attempt limit.
   */
  app.post('/api/auth/verify-phone', async (request, reply) => {
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const phone = text(body, 'phone').trim();
    const code = text(body, 'code').trim();
    if (!isUsPhone(phone) || !code) {
      return reply.code(400).send(CODE_INVALID);
    }
    const db = getDb();
    const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.phoneE164, phone));
    if (!user) {
      return reply.code(400).send(CODE_INVALID);
    }
    const [latest] = await db.select().from(schema.phoneCodes)
      .where(eq(schema.phoneCodes.userId, user.id))
      .orderBy(desc(schema.phoneCodes.createdAt), desc(schema.phoneCodes.id))
      .limit(1);
    if (!latest || latest.usedAt || latest.expiresAt < new Date() || latest.phoneE164 !== phone) {
      return reply.code(400).send(CODE_INVALID);
    }
    // Count the attempt before comparing, atomically, so parallel guesses cannot pass the limit.
    const [counted] = await db.update(schema.phoneCodes)
      .set({ attempts: sql`${schema.phoneCodes.attempts} + 1`, updatedAt: new Date() })
      .where(and(
        eq(schema.phoneCodes.id, latest.id),
        isNull(schema.phoneCodes.usedAt),
        lt(schema.phoneCodes.attempts, CODE_ATTEMPTS),
      ))
      .returning({ id: schema.phoneCodes.id });
    if (!counted) {
      return reply.code(429).send({ error: 'Too many attempts. Ask for a new code.' });
    }
    if (!hashesMatch(latest.codeHash, hashToken(code))) {
      return reply.code(400).send(CODE_INVALID);
    }
    const verified = await db.transaction(async (tx) => {
      const [used] = await tx.update(schema.phoneCodes).set({ usedAt: new Date(), updatedAt: new Date() }).where(and(
        eq(schema.phoneCodes.id, latest.id),
        isNull(schema.phoneCodes.usedAt),
      )).returning({ id: schema.phoneCodes.id });
      if (!used) {
        return false;
      }
      await tx.update(schema.users).set({ phoneVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      return true;
    });
    if (!verified) {
      return reply.code(400).send(CODE_INVALID);
    }
    return { ok: true };
  });

  /**
   * Sends a new email verification link. The answer is the same whether or not the address
   * has an account, is already verified, or is over its hourly limit; only the request caps
   * per IP and per address (counted for every request) answer 429.
   */
  app.post('/api/auth/resend-email', async (request, reply) => {
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const email = text(body, 'email').trim().toLowerCase();
    if (!email.includes('@')) {
      return reply.code(400).send({ error: 'Enter your email address' });
    }
    const outcome = await atLeast(RESEND_MIN_MS, async () => {
      const cap = recordEmailSend(request.ip, [`email:${email}`]);
      if (!cap.ok) {
        return { code: 429, body: { error: cap.reason } } as const;
      }
      const db = getDb();
      const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
      if (!user || user.emailVerifiedAt) {
        return { code: 200, body: { ok: true } } as const;
      }
      const token = newToken();
      const issued = await db.transaction(async (tx) => {
        // Serialize resends for one account so the hourly count holds under parallel requests.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`resend-email:${user.id}`}, 0))`);
        const recent = await tx.select({ id: schema.authTokens.id }).from(schema.authTokens).where(and(
          eq(schema.authTokens.userId, user.id),
          eq(schema.authTokens.purpose, 'verify_email'),
          gt(schema.authTokens.createdAt, new Date(Date.now() - HOUR)),
        ));
        if (recent.length >= EMAILS_PER_HOUR) {
          return false;
        }
        // Only the newest link works.
        await tx.update(schema.authTokens).set({ expiresAt: new Date(), updatedAt: new Date() }).where(and(
          eq(schema.authTokens.userId, user.id),
          eq(schema.authTokens.purpose, 'verify_email'),
          isNull(schema.authTokens.usedAt),
          gt(schema.authTokens.expiresAt, new Date()),
        ));
        await tx.insert(schema.authTokens).values({
          userId: user.id,
          purpose: 'verify_email',
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + DAY),
        });
        return true;
      });
      if (issued) {
        void sendOutOfBand({ channel: 'email', purpose: 'verify_email', to: user.email, secret: token });
      }
      return { code: 200, body: { ok: true } } as const;
    });
    return reply.code(outcome.code).send(outcome.body);
  });

  /**
   * Sends a new phone code for the account with this email, to the phone number stored on that
   * account (the caller has no session yet and never names the number). The answer is the same
   * whether or not the email has an account, is already phone-verified, or its number is over
   * the hourly limit (3 codes an hour per number, counting the signup code); only the request
   * caps per IP and per email (counted for every request, shared with signup's SMS caps) answer
   * 429. A new code replaces the previous one.
   */
  app.post('/api/auth/resend-code', async (request, reply) => {
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const email = text(body, 'email').trim().toLowerCase();
    if (!email.includes('@')) {
      return reply.code(400).send({ error: 'Enter your email address' });
    }
    const outcome = await atLeast(RESEND_MIN_MS, async () => {
      const cap = recordSmsSend(request.ip, [`email:${email}`]);
      if (!cap.ok) {
        return { code: 429, body: { error: cap.reason } } as const;
      }
      const db = getDb();
      const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
      const phone = user?.phoneE164;
      if (!user || !phone || user.phoneVerifiedAt) {
        return { code: 200, body: { ok: true } } as const;
      }
      const code = newPhoneCode();
      const issued = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`resend-code:${phone}`}, 0))`);
        const recent = await tx.select({ id: schema.phoneCodes.id }).from(schema.phoneCodes).where(and(
          eq(schema.phoneCodes.phoneE164, phone),
          gt(schema.phoneCodes.createdAt, new Date(Date.now() - HOUR)),
        ));
        if (recent.length >= CODES_PER_HOUR) {
          return false;
        }
        await tx.insert(schema.phoneCodes).values({
          userId: user.id,
          phoneE164: phone,
          codeHash: hashToken(code),
          expiresAt: new Date(Date.now() + CODE_TTL),
        });
        return true;
      });
      if (issued) {
        void sendOutOfBand({ channel: 'sms', purpose: 'verify_phone', to: phone, secret: code });
      }
      return { code: 200, body: { ok: true } } as const;
    });
    return reply.code(outcome.code).send(outcome.body);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const email = text(body, 'email').trim().toLowerCase();
    const db = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user || !(await passwordMatches(text(body, 'password'), user.passwordHash))) {
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
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const db = getDb();
    const resetToken = text(body, 'token');
    if (resetToken) {
      const password = text(body, 'password');
      if (password.length < 12) {
        return reply.code(400).send({ error: 'Password must be at least 12 characters' });
      }
      const passwordHash = await hashPassword(password);
      const reset = await db.transaction(async (tx) => {
        const [row] = await tx.update(schema.authTokens).set({ usedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(schema.authTokens.tokenHash, hashToken(resetToken)),
          eq(schema.authTokens.purpose, 'reset_password'),
          isNull(schema.authTokens.usedAt),
          gt(schema.authTokens.expiresAt, new Date()),
        )).returning({ userId: schema.authTokens.userId });
        if (!row) {
          return false;
        }
        await tx.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, row.userId));
        // 07 s1: sessions are revoked on password change.
        await tx.update(schema.sessions).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(schema.sessions.userId, row.userId),
          isNull(schema.sessions.revokedAt),
        ));
        return true;
      });
      if (!reset) {
        return reply.code(400).send({ error: 'That reset link is not valid' });
      }
      return { ok: true };
    }
    const email = text(body, 'email').trim().toLowerCase();
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
    void sendOutOfBand({ channel: 'email', purpose: 'reset_password', to: user.email, secret: token });
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

  /**
   * Changes the name and/or the password. A new password needs `currentPassword`, and revokes
   * every other session of the user; the session making the change stays signed in.
   */
  app.patch('/api/me', { preHandler: requireUser }, async (request, reply) => {
    const body = readBody(request);
    if (!body) {
      return reply.code(400).send(BODY_REQUIRED);
    }
    const { userId, sessionId } = request.auth!;
    if (body.name !== undefined && typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'Name must be text' });
    }
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    let passwordHash: string | undefined;
    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 12) {
        return reply.code(400).send({ error: 'Password must be at least 12 characters' });
      }
      const currentPassword = text(body, 'currentPassword');
      if (!currentPassword) {
        return reply.code(400).send({ error: 'Enter your current password' });
      }
      const db = getDb();
      const [user] = await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, userId));
      if (!user || !(await passwordMatches(currentPassword, user.passwordHash))) {
        return reply.code(403).send({ error: 'Current password is wrong' });
      }
      passwordHash = await hashPassword(body.password);
    }
    if (name === undefined && passwordHash === undefined) {
      return { ok: true };
    }
    await getDb().transaction(async (tx) => {
      await tx.update(schema.users).set({
        ...(name !== undefined ? { name } : {}),
        ...(passwordHash !== undefined ? { passwordHash } : {}),
        updatedAt: new Date(),
      }).where(eq(schema.users.id, userId));
      if (passwordHash !== undefined) {
        // 07 s1: sessions are revoked on password change; this one stays.
        await tx.update(schema.sessions).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(schema.sessions.userId, userId),
          ne(schema.sessions.id, sessionId),
          isNull(schema.sessions.revokedAt),
        ));
      }
    });
    return { ok: true };
  });
}

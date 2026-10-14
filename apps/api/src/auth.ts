import { and, desc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '@pd/core';
import { BODY_REQUIRED, readBody, text } from './body.js';
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

const CODE_INVALID = { error: 'That code is not valid' } as const;
const EMAIL_TAKEN = { error: 'An account with this email already exists. Log in or reset your password.' } as const;
const PHONE_TAKEN = { error: 'That phone number is already verified on an account' } as const;
const WRONG_CREDENTIALS = { error: 'Email or password is wrong' } as const;

const PASSWORD_MIN = 12;
/** Bounds the scrypt input, so a huge password cannot tie up the server. */
const PASSWORD_MAX = 256;

/** The error for a new password that is too short or too long, or null when it is fine. */
function passwordProblem(password: string): { error: string } | null {
  if (password.length < PASSWORD_MIN) {
    return { error: `Password must be at least ${PASSWORD_MIN} characters` };
  }
  if (password.length > PASSWORD_MAX) {
    return { error: `Password must be at most ${PASSWORD_MAX} characters` };
  }
  return null;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/**
 * After a password change: revokes the user's sessions (all, or all but `keepSessionId`) and
 * expires every unused reset link, so neither an old session nor an old link outlives it.
 */
async function afterPasswordChange(tx: Tx, userId: string, keepSessionId?: string): Promise<void> {
  const now = new Date();
  await tx.update(schema.sessions).set({ revokedAt: now, updatedAt: now }).where(and(
    eq(schema.sessions.userId, userId),
    isNull(schema.sessions.revokedAt),
    ...(keepSessionId ? [ne(schema.sessions.id, keepSessionId)] : []),
  ));
  await tx.update(schema.authTokens).set({ expiresAt: now, updatedAt: now }).where(and(
    eq(schema.authTokens.userId, userId),
    eq(schema.authTokens.purpose, 'reset_password'),
    isNull(schema.authTokens.usedAt),
    gt(schema.authTokens.expiresAt, now),
  ));
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
    const weak = passwordProblem(password);
    if (weak) {
      return reply.code(400).send(weak);
    }
    if (!isUsPhone(phone)) {
      return reply.code(400).send({ error: 'Use a +1 US phone number' });
    }
    // Every well-formed attempt counts against the caps, including ones answered 409 below,
    // so the 409s cannot be used to probe for accounts without limit.
    const cap = recordSmsSend(request.ip, [`email:${email}`, `phone:${phone}`]);
    if (!cap.ok) {
      return reply.code(429).send({ error: cap.reason });
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
    const password = text(body, 'password');
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user || password.length > PASSWORD_MAX || !(await passwordMatches(password, user.passwordHash))) {
      return reply.code(401).send(WRONG_CREDENTIALS);
    }
    if (!user.emailVerifiedAt || !user.phoneVerifiedAt) {
      return reply.code(403).send({ error: 'Verify email and phone before signing in' });
    }
    const token = newToken();
    // A reset or password change may have committed since the hash above was read. Lock the
    // user row and create the session only if the hash is still the one the password matched:
    // a change that commits first is seen here, and one that commits later (it updates this
    // row first, so it waits for this lock) revokes the session this creates.
    const created = await db.transaction(async (tx) => {
      const [current] = await tx.select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, user.id))
        .for('update');
      if (!current || current.passwordHash !== user.passwordHash) {
        return false;
      }
      await tx.insert(schema.sessions).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 14 * DAY),
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      await tx.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
      return true;
    });
    if (!created) {
      return reply.code(401).send(WRONG_CREDENTIALS);
    }
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
      const invalid = { error: 'That reset link is not valid' };
      const password = text(body, 'password');
      const weak = passwordProblem(password);
      if (weak) {
        return reply.code(400).send(weak);
      }
      const live = and(
        eq(schema.authTokens.tokenHash, hashToken(resetToken)),
        eq(schema.authTokens.purpose, 'reset_password'),
        isNull(schema.authTokens.usedAt),
        gt(schema.authTokens.expiresAt, new Date()),
      );
      // Check the link before spending a password hash on it; the transaction checks again.
      const [candidate] = await db.select({ id: schema.authTokens.id }).from(schema.authTokens).where(live);
      if (!candidate) {
        return reply.code(400).send(invalid);
      }
      const passwordHash = await hashPassword(password);
      const reset = await db.transaction(async (tx) => {
        const [row] = await tx.update(schema.authTokens).set({ usedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(schema.authTokens.id, candidate.id),
          isNull(schema.authTokens.usedAt),
          gt(schema.authTokens.expiresAt, new Date()),
        )).returning({ userId: schema.authTokens.userId });
        if (!row) {
          return false;
        }
        await tx.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(eq(schema.users.id, row.userId));
        // 07 s1: sessions are revoked on password change; other reset links die with them.
        await afterPasswordChange(tx, row.userId);
        return true;
      });
      if (!reset) {
        return reply.code(400).send(invalid);
      }
      return { ok: true };
    }
    // Requesting a link answers the same, in about the same time, whether or not the account exists.
    const email = text(body, 'email').trim().toLowerCase();
    await atLeast(RESEND_MIN_MS, async () => {
      const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
      if (!user) {
        return;
      }
      const token = newToken();
      await db.insert(schema.authTokens).values({
        userId: user.id,
        purpose: 'reset_password',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + HOUR),
      });
      void sendOutOfBand({ channel: 'email', purpose: 'reset_password', to: user.email, secret: token });
    });
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
    const wrongCurrent = { error: 'Current password is wrong' };
    let change: { from: string; to: string } | undefined;
    if (body.password !== undefined) {
      const weak = passwordProblem(typeof body.password === 'string' ? body.password : '');
      if (weak || typeof body.password !== 'string') {
        return reply.code(400).send(weak ?? { error: 'Password must be text' });
      }
      const currentPassword = text(body, 'currentPassword');
      if (!currentPassword) {
        return reply.code(400).send({ error: 'Enter your current password' });
      }
      const db = getDb();
      const [user] = await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, userId));
      if (!user || currentPassword.length > PASSWORD_MAX || !(await passwordMatches(currentPassword, user.passwordHash))) {
        return reply.code(403).send(wrongCurrent);
      }
      change = { from: user.passwordHash, to: await hashPassword(body.password) };
    }
    if (name === undefined && change === undefined) {
      return { ok: true };
    }
    const saved = await getDb().transaction(async (tx) => {
      // The password changes only if it is still the one `currentPassword` matched.
      const [updated] = await tx.update(schema.users).set({
        ...(name !== undefined ? { name } : {}),
        ...(change !== undefined ? { passwordHash: change.to } : {}),
        updatedAt: new Date(),
      }).where(and(
        eq(schema.users.id, userId),
        ...(change !== undefined ? [eq(schema.users.passwordHash, change.from)] : []),
      )).returning({ id: schema.users.id });
      if (!updated) {
        return false;
      }
      if (change !== undefined) {
        // 07 s1: sessions are revoked on password change; this one stays.
        await afterPasswordChange(tx, userId, sessionId);
      }
      return true;
    });
    if (!saved) {
      return reply.code(403).send(wrongCurrent);
    }
    return { ok: true };
  });
}

import { randomInt, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getDb, getPool, schema } from '@pd/core';
import { type OutOfBandMessage, resetSendCaps, sendOutOfBand, setOutOfBandSink } from '../src/security.js';

const unavailable = inject('dbUnavailable');

const sent: OutOfBandMessage[] = [];

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@acme-test.com`;
}

function uniquePhone(): string {
  return `+1555${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
}

function lastSecret(channel: OutOfBandMessage['channel'], to: string): string {
  const message = sent.filter((item) => item.channel === channel && item.to === to).at(-1);
  if (!message) {
    throw new Error(`No ${channel} message to ${to}`);
  }
  return message.secret;
}

function countTo(channel: OutOfBandMessage['channel'], to: string): number {
  return sent.filter((item) => item.channel === channel && item.to === to).length;
}

describe.skipIf(Boolean(unavailable))('auth routes', () => {
  let app: FastifyInstance;
  let ip = '';

  /** A JSON POST/PATCH from this test's IP. `payload: undefined` sends no body at all. */
  function call(method: 'POST' | 'PATCH' | 'GET', url: string, payload?: unknown, token?: string) {
    return app.inject({
      method,
      url,
      remoteAddress: ip,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function signUp(email = uniqueEmail('u'), phone = uniquePhone(), password = 'correct horse battery') {
    const response = await call('POST', '/api/auth/signup', { email, phone, password, name: 'Pat' });
    expect(response.statusCode, response.body).toBe(201);
    return { email, phone, password, userId: response.json<{ userId: string }>().userId };
  }

  /** A signed-up, email- and phone-verified user with one session. */
  async function verifiedUser() {
    const user = await signUp();
    expect((await call('POST', '/api/auth/verify-email', { token: lastSecret('email', user.email) })).statusCode).toBe(200);
    expect((await call('POST', '/api/auth/verify-phone', { phone: user.phone, code: lastSecret('sms', user.phone) })).statusCode).toBe(200);
    const login = await call('POST', '/api/auth/login', { email: user.email, password: user.password });
    expect(login.statusCode, login.body).toBe(200);
    return { ...user, token: login.json<{ token: string }>().token };
  }

  beforeAll(async () => {
    delete process.env.PD_ALLOW_BYPASS_RLS;
    getPool({ connectionString: inject('appUrl'), max: 4 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  beforeEach(() => {
    sent.length = 0;
    resetSendCaps();
    ip = `10.0.${randomInt(0, 255)}.${randomInt(1, 255)}`;
    setOutOfBandSink((message) => {
      sent.push(message);
    });
  });

  afterEach(() => {
    setOutOfBandSink(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  describe('missing or malformed JSON bodies', () => {
    const routes: ['POST' | 'PATCH', string][] = [
      ['POST', '/api/auth/signup'],
      ['POST', '/api/auth/verify-email'],
      ['POST', '/api/auth/verify-phone'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/reset'],
      ['POST', '/api/auth/resend-email'],
      ['POST', '/api/auth/resend-code'],
    ];

    it.each(routes)('%s %s answers 400 with no body', async (method, url) => {
      const response = await call(method, url);
      expect(response.statusCode).toBe(400);
    });

    it.each(routes)('%s %s answers 400 for a JSON null or array body', async (method, url) => {
      for (const payload of ['null', '[]', '"text"']) {
        const response = await app.inject({ method, url, remoteAddress: ip, headers: { 'content-type': 'application/json' }, payload });
        expect(response.statusCode, `${payload}: ${response.body}`).toBe(400);
      }
    });

    it('treats a field of the wrong type as missing, not a 500', async () => {
      const response = await call('POST', '/api/auth/login', { email: 42, password: ['x'] });
      expect(response.statusCode).toBe(401);
      const signup = await call('POST', '/api/auth/signup', { email: { a: 1 }, phone: 5, password: 7 });
      expect(signup.statusCode).toBe(400);
    });

    it('PATCH /api/me answers 400 with no body', async () => {
      const user = await verifiedUser();
      expect((await call('PATCH', '/api/me', undefined, user.token)).statusCode).toBe(400);
    });
  });

  describe('POST /api/auth/signup', () => {
    it('answers 409 for an email that already has an account, in any case', async () => {
      const first = await signUp();
      const response = await call('POST', '/api/auth/signup', {
        email: first.email.toUpperCase(),
        phone: uniquePhone(),
        password: 'another long password',
      });
      expect(response.statusCode).toBe(409);
      expect(Object.keys(response.json())).toEqual(['error']);
      expect(response.json().error).not.toContain(first.userId);
      const rows = await getDb().select().from(schema.users).where(eq(schema.users.email, first.email));
      expect(rows).toHaveLength(1);
    });

    it('answers 409, not 500, when two signups for one email race', async () => {
      const email = uniqueEmail('race');
      const results = await Promise.all([
        call('POST', '/api/auth/signup', { email, phone: uniquePhone(), password: 'correct horse battery' }),
        call('POST', '/api/auth/signup', { email, phone: uniquePhone(), password: 'correct horse battery' }),
      ]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    });

    it('ties the phone code to the new account', async () => {
      const user = await signUp();
      const [code] = await getDb().select().from(schema.phoneCodes).where(eq(schema.phoneCodes.phoneE164, user.phone));
      expect(code.userId).toBe(user.userId);
    });
  });

  describe('POST /api/auth/verify-phone', () => {
    it('does not accept another account\'s code', async () => {
      const a = await signUp();
      const b = await signUp();
      const response = await call('POST', '/api/auth/verify-phone', { phone: b.phone, code: lastSecret('sms', a.phone) });
      // A's code matches B's only by a 1-in-a-million chance.
      if (lastSecret('sms', a.phone) !== lastSecret('sms', b.phone)) {
        expect(response.statusCode).toBe(400);
        const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, b.userId));
        expect(row.phoneVerifiedAt).toBeNull();
      }
    });

    it('accepts only the latest code, once', async () => {
      const user = await signUp();
      const first = lastSecret('sms', user.phone);
      expect((await call('POST', '/api/auth/resend-code', { email: user.email })).statusCode).toBe(200);
      const second = lastSecret('sms', user.phone);
      if (first !== second) {
        expect((await call('POST', '/api/auth/verify-phone', { phone: user.phone, code: first })).statusCode).toBe(400);
      }
      expect((await call('POST', '/api/auth/verify-phone', { phone: user.phone, code: second })).statusCode).toBe(200);
      expect((await call('POST', '/api/auth/verify-phone', { phone: user.phone, code: second })).statusCode).toBe(400);
      const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, user.userId));
      expect(row.phoneVerifiedAt).not.toBeNull();
    });

    it('rejects an expired code', async () => {
      const user = await signUp();
      await getDb().update(schema.phoneCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.phoneCodes.userId, user.userId));
      const response = await call('POST', '/api/auth/verify-phone', { phone: user.phone, code: lastSecret('sms', user.phone) });
      expect(response.statusCode).toBe(400);
    });

    it('stops after 5 attempts, even for the right code, including parallel guesses', async () => {
      const user = await signUp();
      const code = lastSecret('sms', user.phone);
      const wrong = code === '000000' ? '000001' : '000000';
      const guesses = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/auth/verify-phone', { phone: user.phone, code: wrong })));
      const codes = guesses.map((guess) => guess.statusCode).sort();
      expect(codes).toEqual([400, 400, 400, 400, 400, 429, 429, 429]);
      expect((await call('POST', '/api/auth/verify-phone', { phone: user.phone, code })).statusCode).toBe(429);
    });

    it('answers the same for a number with no account', async () => {
      const response = await call('POST', '/api/auth/verify-phone', { phone: uniquePhone(), code: '123456' });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'That code is not valid' });
    });
  });

  describe('POST /api/auth/resend-email', () => {
    it('answers the same for an unknown, unverified, or verified address', async () => {
      const unverified = await signUp();
      const verified = await verifiedUser();
      sent.length = 0;
      const responses = await Promise.all([
        call('POST', '/api/auth/resend-email', { email: uniqueEmail('nobody') }),
        call('POST', '/api/auth/resend-email', { email: unverified.email }),
        call('POST', '/api/auth/resend-email', { email: verified.email }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
      }
      expect(sent.map((message) => message.to)).toEqual([unverified.email]);
    });

    it('sends a new link that works, and the old link stops working', async () => {
      const user = await signUp();
      const oldToken = lastSecret('email', user.email);
      expect((await call('POST', '/api/auth/resend-email', { email: ` ${user.email.toUpperCase()} ` })).statusCode).toBe(200);
      const newToken = lastSecret('email', user.email);
      expect(newToken).not.toBe(oldToken);
      expect((await call('POST', '/api/auth/verify-email', { token: oldToken })).statusCode).toBe(400);
      expect((await call('POST', '/api/auth/verify-email', { token: newToken })).statusCode).toBe(200);
      expect((await call('POST', '/api/auth/verify-email', { token: newToken })).statusCode).toBe(400);
    });

    it('sends at most 3 links an hour per account, silently', async () => {
      const user = await signUp();
      for (let i = 0; i < 3; i += 1) {
        const response = await call('POST', '/api/auth/resend-email', { email: user.email });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
      }
      // The signup link plus two resends.
      expect(countTo('email', user.email)).toBe(3);
    });

    it('caps requests per address at 5 a day whether or not the account exists', async () => {
      for (const email of [uniqueEmail('nobody'), (await signUp()).email]) {
        resetSendCaps();
        const statuses: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          statuses.push((await call('POST', '/api/auth/resend-email', { email })).statusCode);
        }
        expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      }
    });

    it('caps requests per IP at 10 a day', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        statuses.push((await call('POST', '/api/auth/resend-email', { email: uniqueEmail('ip') })).statusCode);
      }
      expect(statuses.filter((status) => status === 429)).toHaveLength(1);
      expect(statuses.at(-1)).toBe(429);
    });

    it('takes about as long for an unknown address as for a known one', async () => {
      const user = await signUp();
      const started = Date.now();
      await call('POST', '/api/auth/resend-email', { email: uniqueEmail('nobody') });
      const unknownMs = Date.now() - started;
      expect(unknownMs).toBeGreaterThanOrEqual(290);
      const again = Date.now();
      await call('POST', '/api/auth/resend-email', { email: user.email });
      expect(Date.now() - again).toBeGreaterThanOrEqual(290);
    });
  });

  describe('POST /api/auth/resend-code', () => {
    it('answers the same for an unknown, unverified, or verified account', async () => {
      const unverified = await signUp();
      const verified = await verifiedUser();
      sent.length = 0;
      const responses = await Promise.all([
        call('POST', '/api/auth/resend-code', { email: uniqueEmail('nobody') }),
        call('POST', '/api/auth/resend-code', { email: unverified.email }),
        call('POST', '/api/auth/resend-code', { email: verified.email }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
      }
      expect(sent.map((message) => message.to)).toEqual([unverified.phone]);
    });

    it('sends to the phone on the account, never to a phone in the request', async () => {
      const user = await signUp();
      const other = uniquePhone();
      expect((await call('POST', '/api/auth/resend-code', { email: user.email, phone: other })).statusCode).toBe(200);
      expect(countTo('sms', other)).toBe(0);
      expect(countTo('sms', user.phone)).toBe(2);
      const [latest] = await getDb().select().from(schema.phoneCodes).where(eq(schema.phoneCodes.userId, user.userId)).orderBy(schema.phoneCodes.createdAt);
      expect(latest.userId).toBe(user.userId);
    });

    it('sends at most 3 codes an hour per number, counting the signup code, silently', async () => {
      const user = await signUp();
      for (let i = 0; i < 3; i += 1) {
        const response = await call('POST', '/api/auth/resend-code', { email: user.email });
        expect(response.json()).toEqual({ ok: true });
      }
      expect(countTo('sms', user.phone)).toBe(3);
    });

    it('caps requests per email at 5 a day whether or not the account exists', async () => {
      for (const email of [uniqueEmail('nobody'), uniqueEmail('nobody2')]) {
        resetSendCaps();
        const statuses: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          statuses.push((await call('POST', '/api/auth/resend-code', { email })).statusCode);
        }
        expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      }
    });

    it('shares the per-account SMS cap with signup', async () => {
      const user = await signUp();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await call('POST', '/api/auth/resend-code', { email: user.email })).statusCode);
      }
      // Signup used one of the 5 daily sends for this email.
      expect(statuses).toEqual([200, 200, 200, 200, 429]);
    });
  });

  describe('PATCH /api/me', () => {
    it('changes the name without the current password', async () => {
      const user = await verifiedUser();
      expect((await call('PATCH', '/api/me', { name: 'Annie' }, user.token)).statusCode).toBe(200);
      expect((await call('GET', '/api/me', undefined, user.token)).json().name).toBe('Annie');
    });

    it('needs the current password to change the password', async () => {
      const user = await verifiedUser();
      const missing = await call('PATCH', '/api/me', { password: 'a brand new password' }, user.token);
      expect(missing.statusCode).toBe(400);
      const wrong = await call('PATCH', '/api/me', { password: 'a brand new password', currentPassword: 'not my password' }, user.token);
      expect(wrong.statusCode).toBe(403);
      const login = await call('POST', '/api/auth/login', { email: user.email, password: 'a brand new password' });
      expect(login.statusCode).toBe(401);
    });

    it('changes the password and revokes the user\'s other sessions only', async () => {
      const user = await verifiedUser();
      const second = (await call('POST', '/api/auth/login', { email: user.email, password: user.password })).json<{ token: string }>().token;
      const bystander = await verifiedUser();
      const response = await call('PATCH', '/api/me', { password: 'a brand new password', currentPassword: user.password }, user.token);
      expect(response.statusCode).toBe(200);
      expect((await call('GET', '/api/me', undefined, user.token)).statusCode).toBe(200);
      expect((await call('GET', '/api/me', undefined, second)).statusCode).toBe(401);
      expect((await call('GET', '/api/me', undefined, bystander.token)).statusCode).toBe(200);
      expect((await call('POST', '/api/auth/login', { email: user.email, password: user.password })).statusCode).toBe(401);
      expect((await call('POST', '/api/auth/login', { email: user.email, password: 'a brand new password' })).statusCode).toBe(200);
    });
  });

  describe('POST /api/auth/reset', () => {
    it('revokes every session when the password is reset, and the link works once', async () => {
      const user = await verifiedUser();
      expect((await call('POST', '/api/auth/reset', { email: user.email })).statusCode).toBe(200);
      const token = lastSecret('email', user.email);
      const reset = await call('POST', '/api/auth/reset', { token, password: 'a brand new password' });
      expect(reset.statusCode).toBe(200);
      expect((await call('GET', '/api/me', undefined, user.token)).statusCode).toBe(401);
      expect((await call('POST', '/api/auth/reset', { token, password: 'another new password' })).statusCode).toBe(400);
    });
  });

  describe('reset request caps', () => {
    const resetsTo = (email: string) => sent.filter((item) => item.purpose === 'reset_password' && item.to === email).length;

    it('caps requests per address at 5 a day, the same for a known and an unknown address', async () => {
      const known = await signUp();
      const unknown = uniqueEmail('nobody');
      for (const email of [known.email, unknown]) {
        resetSendCaps();
        const statuses: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          ip = `10.1.${randomInt(0, 255)}.${randomInt(1, 255)}`;
          statuses.push((await call('POST', '/api/auth/reset', { email })).statusCode);
        }
        expect(statuses, email).toEqual([200, 200, 200, 200, 200, 429]);
      }
    });

    it('caps requests per IP at 10 a day, shared with the other email sends', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        statuses.push((await call('POST', '/api/auth/reset', { email: uniqueEmail('ipcap') })).statusCode);
      }
      expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('sends at most 3 reset links an hour per account, silently', async () => {
      const user = await signUp();
      for (let i = 0; i < 4; i += 1) {
        ip = `10.2.${randomInt(0, 255)}.${randomInt(1, 255)}`;
        const response = await call('POST', '/api/auth/reset', { email: user.email });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
      }
      expect(resetsTo(user.email)).toBe(3);
    });

    it('holds the hourly limit under parallel requests', async () => {
      const user = await signUp();
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => app.inject({
        method: 'POST',
        url: '/api/auth/reset',
        remoteAddress: `10.3.${i}.${randomInt(1, 255)}`,
        payload: { email: user.email },
      })));
      expect(results.map((result) => result.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect(resetsTo(user.email)).toBe(3);
    });
  });

  describe('password changes and racing logins', () => {
    it('a login that races a password reset does not leave a live session', async () => {
      const user = await verifiedUser();
      const sessionsBefore = await getDb().select().from(schema.sessions).where(eq(schema.sessions.userId, user.userId));
      // Stand in for a reset that has updated the hash but not committed yet.
      const holder = new pg.Client({ connectionString: inject('appUrl') });
      await holder.connect();
      await holder.query('begin');
      await holder.query('update users set password_hash = $1 where id = $2', ['changed:elsewhere', user.userId]);
      const pending = call('POST', '/api/auth/login', { email: user.email, password: user.password });
      const deadline = Date.now() + 10_000;
      let waiting = 0;
      while (waiting < 1 && Date.now() < deadline) {
        await holder.query('select pg_stat_clear_snapshot()');
        const result = await holder.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'",
        );
        waiting = result.rows[0].n;
      }
      await holder.query('commit');
      await holder.end();
      expect(waiting).toBe(1);
      const response = await pending;
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Email or password is wrong' });
      const sessionsAfter = await getDb().select().from(schema.sessions).where(eq(schema.sessions.userId, user.userId));
      expect(sessionsAfter).toHaveLength(sessionsBefore.length);
    });

    it('a reset expires the user\'s other outstanding reset links', async () => {
      const user = await verifiedUser();
      expect((await call('POST', '/api/auth/reset', { email: user.email })).statusCode).toBe(200);
      const first = lastSecret('email', user.email);
      expect((await call('POST', '/api/auth/reset', { email: user.email })).statusCode).toBe(200);
      const second = lastSecret('email', user.email);
      expect((await call('POST', '/api/auth/reset', { token: second, password: 'a brand new password' })).statusCode).toBe(200);
      expect((await call('POST', '/api/auth/reset', { token: first, password: 'another new password' })).statusCode).toBe(400);
      expect((await call('POST', '/api/auth/login', { email: user.email, password: 'a brand new password' })).statusCode).toBe(200);
    });

    it('a password change expires every outstanding reset link', async () => {
      const user = await verifiedUser();
      await call('POST', '/api/auth/reset', { email: user.email });
      const first = lastSecret('email', user.email);
      await call('POST', '/api/auth/reset', { email: user.email });
      const second = lastSecret('email', user.email);
      const change = await call('PATCH', '/api/me', { password: 'a brand new password', currentPassword: user.password }, user.token);
      expect(change.statusCode).toBe(200);
      for (const token of [first, second]) {
        expect((await call('POST', '/api/auth/reset', { token, password: 'an attacker password' })).statusCode).toBe(400);
      }
    });

    it('a password change fails if the password changed after it was checked', async () => {
      const user = await verifiedUser();
      // Two changes from the same session with the same current password: only one wins.
      const results = await Promise.all([
        call('PATCH', '/api/me', { password: 'first new password', currentPassword: user.password }, user.token),
        call('PATCH', '/api/me', { password: 'second new password', currentPassword: user.password }, user.token),
      ]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([200, 403]);
    });

    it('caps password length at 256 on signup, reset and PATCH /api/me', async () => {
      const long = 'x'.repeat(257);
      expect((await call('POST', '/api/auth/signup', { email: uniqueEmail('long'), phone: uniquePhone(), password: long })).statusCode).toBe(400);
      const user = await verifiedUser();
      await call('POST', '/api/auth/reset', { email: user.email });
      const token = lastSecret('email', user.email);
      expect((await call('POST', '/api/auth/reset', { token, password: long })).statusCode).toBe(400);
      expect((await call('PATCH', '/api/me', { password: long, currentPassword: user.password }, user.token)).statusCode).toBe(400);
      // The link was not used up by the refused attempt.
      expect((await call('POST', '/api/auth/reset', { token, password: 'x'.repeat(256) })).statusCode).toBe(200);
    });

    it('a reset request takes the same minimum time whether or not the account exists', async () => {
      const user = await verifiedUser();
      for (const email of [uniqueEmail('nobody'), user.email]) {
        const started = Date.now();
        const response = await call('POST', '/api/auth/reset', { email });
        expect(response.json()).toEqual({ ok: true });
        expect(Date.now() - started).toBeGreaterThanOrEqual(290);
      }
    });
  });

  describe('signup caps', () => {
    it('counts signups answered 409 against the per-account cap', async () => {
      const user = await signUp();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await call('POST', '/api/auth/signup', { email: user.email, phone: uniquePhone(), password: 'correct horse battery' })).statusCode);
      }
      // The first signup used one of the 5 daily sends for this email.
      expect(statuses).toEqual([409, 409, 409, 409, 429]);
    });

    it('counts signups answered 409 against the per-IP cap', async () => {
      const user = await signUp();
      const password = 'correct horse battery';
      const statuses: number[] = [];
      // Four probes of the taken email and four of the taken phone (under the per-account caps)...
      for (let i = 0; i < 4; i += 1) {
        statuses.push((await call('POST', '/api/auth/signup', { email: user.email, phone: uniquePhone(), password })).statusCode);
        statuses.push((await call('POST', '/api/auth/signup', { email: uniqueEmail('probe'), phone: user.phone, password })).statusCode);
      }
      expect(statuses.every((status) => status === 409)).toBe(true);
      // ...plus the first signup and one more make 10 for this IP; the next is refused.
      expect((await call('POST', '/api/auth/signup', { email: uniqueEmail('new'), phone: uniquePhone(), password })).statusCode).toBe(201);
      expect((await call('POST', '/api/auth/signup', { email: uniqueEmail('new'), phone: uniquePhone(), password })).statusCode).toBe(429);
    });
  });

  describe('client IP behind a proxy', () => {
    async function capsHitAfter(trust: string | undefined, forwardedFor: (i: number) => string, remoteAddress = '127.0.0.1') {
      vi.stubEnv('PD_TRUST_PROXY', trust ?? '');
      const { buildApp } = await import('../src/app.js');
      const proxied = await buildApp({ logger: false });
      vi.unstubAllEnvs();
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 11; i += 1) {
          const response = await proxied.inject({
            method: 'POST',
            url: '/api/auth/resend-email',
            remoteAddress,
            headers: { 'x-forwarded-for': forwardedFor(i) },
            payload: { email: uniqueEmail('proxy') },
          });
          statuses.push(response.statusCode);
        }
        return statuses;
      } finally {
        await proxied.close();
      }
    }

    it('keys the per-IP cap on X-Forwarded-For when the proxy is trusted', async () => {
      // One client: capped on the 11th request.
      expect((await capsHitAfter('127.0.0.1', () => '203.0.113.5')).at(-1)).toBe(429);
      resetSendCaps();
      // Eleven clients behind the proxy: none capped.
      const statuses = await capsHitAfter('127.0.0.1', (i) => `203.0.113.${i + 10}`);
      expect(statuses.every((status) => status === 200)).toBe(true);
    });

    // Production: the host's nginx reaches the api through the port published on 127.0.0.1, so
    // the api sees the compose network's gateway (pinned to 172.31.250.1 in docker-compose.yml)
    // and nginx's X-Forwarded-For carries the visitor's address from CF-Connecting-IP.
    it('counts per-IP caps by the client address nginx forwards from the compose gateway', async () => {
      const gateway = '172.31.250.1';
      expect((await capsHitAfter(gateway, () => '198.51.100.7', gateway)).at(-1)).toBe(429);
      resetSendCaps();
      const statuses = await capsHitAfter(gateway, (i) => `198.51.100.${i + 20}`, gateway);
      expect(statuses.every((status) => status === 200)).toBe(true);
    });

    it('ignores X-Forwarded-For from any other container on the network', async () => {
      const statuses = await capsHitAfter('172.31.250.1', (i) => `198.51.100.${i + 40}`, '172.31.250.9');
      expect(statuses.at(-1)).toBe(429);
    });

    it('ignores X-Forwarded-For when no proxy is trusted', async () => {
      const statuses = await capsHitAfter(undefined, (i) => `203.0.113.${i + 10}`);
      expect(statuses.at(-1)).toBe(429);
    });

    it('refuses PD_TRUST_PROXY values that trust everyone', async () => {
      const { trustProxyFromEnv } = await import('../src/app.js');
      expect(trustProxyFromEnv(undefined)).toBe(false);
      expect(trustProxyFromEnv(' ')).toBe(false);
      expect(trustProxyFromEnv('10.0.0.0/8, ::1,loopback')).toEqual(['10.0.0.0/8', '::1', 'loopback']);
      for (const bad of ['true', '*', '1', '10.0.0.0/33', 'nginx']) {
        expect(() => trustProxyFromEnv(bad), bad).toThrow(/PD_TRUST_PROXY/);
      }
    });
  });

  describe('organization routes without a body', () => {
    it('answer 400, not 500', async () => {
      const user = await verifiedUser();
      expect((await call('POST', '/api/org', undefined, user.token)).statusCode).toBe(400);
      expect((await call('POST', '/api/org', { name: 'Acme' }, user.token)).statusCode).toBe(201);
      expect((await call('PATCH', '/api/org', undefined, user.token)).statusCode).toBe(400);
      expect((await call('POST', '/api/org/invites', undefined, user.token)).statusCode).toBe(400);
    });
  });

  describe('one bare email address at every entry point', () => {
    const NOT_BARE = ['Work Co <me@gmail.com>', 'ceo@victim.com <me@evil.com>', 'a@acme-test.com,c@acme-test.com', 'Kim@acme-test.com'];

    it.each(NOT_BARE)('signup refuses %j and sends nothing', async (email) => {
      const response = await call('POST', '/api/auth/signup', { email, phone: uniquePhone(), password: 'correct horse battery' });
      expect(response.statusCode).toBe(400);
      expect(sent).toHaveLength(0);
      const rows = await getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email.trim().toLowerCase()));
      expect(rows).toHaveLength(0);
    });

    it.each(NOT_BARE)('resend-email, resend-code and reset refuse %j and send nothing', async (email) => {
      for (const url of ['/api/auth/resend-email', '/api/auth/resend-code', '/api/auth/reset']) {
        const response = await call('POST', url, { email });
        expect(response.statusCode, url).toBe(400);
      }
      expect(sent).toHaveLength(0);
    });

    it('refuses a display-name form of an existing account\'s address on reset', async () => {
      const user = await signUp();
      sent.length = 0;
      expect((await call('POST', '/api/auth/reset', { email: `Pat <${user.email}>` })).statusCode).toBe(400);
      expect(sent).toHaveLength(0);
    });
  });

  describe('PD_SKIP_PHONE_VERIFY_EMAILS (tester phone skip)', () => {
    type Send = (url: string, payload: Record<string, unknown>) => Promise<LightMyRequestResponse>;

    /** An app built with this skip list, whose log lines are collected. */
    async function skipApp(list: string) {
      vi.stubEnv('PD_SKIP_PHONE_VERIFY_EMAILS', list);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const logs: string[] = [];
      const { buildApp } = await import('../src/app.js');
      const built = await buildApp({ logger: { level: 'info', stream: { write: (line: string) => { logs.push(line); } } } });
      vi.unstubAllEnvs();
      const send: Send = (url, payload) => built.inject({ method: 'POST', url, remoteAddress: ip, payload });
      return { app: built, logs, send };
    }

    async function verifyEmailOf(email: string, send: Send) {
      const response = await send('/api/auth/verify-email', { token: lastSecret('email', email) });
      expect(response.statusCode).toBe(200);
      return response.json<{ ok: true; phoneRequired: boolean }>();
    }

    it('tells the web client the phone step is skipped when verifying an allow-listed email', async () => {
      const email = uniqueEmail('flagged');
      const { app: skip, send } = await skipApp(email);
      try {
        expect((await send('/api/auth/signup', { email, phone: uniquePhone(), password: 'correct horse battery' })).statusCode).toBe(201);
        expect(await verifyEmailOf(email, send)).toEqual({ ok: true, phoneRequired: false });
      } finally {
        await skip.close();
      }
    });

    it('tells the web client the phone step is still needed for an email not on the list', async () => {
      const email = uniqueEmail('unflagged');
      const { app: skip, send } = await skipApp(`someone-else@${email.split('@')[1]}`);
      try {
        expect((await send('/api/auth/signup', { email, phone: uniquePhone(), password: 'correct horse battery' })).statusCode).toBe(201);
        expect(await verifyEmailOf(email, send)).toEqual({ ok: true, phoneRequired: true });
      } finally {
        await skip.close();
      }
    });

    it('lets an allow-listed email sign in after email verification only, and sends no SMS', async () => {
      const email = uniqueEmail('tester');
      const phone = uniquePhone();
      const { app: skip, logs, send } = await skipApp(`other@acme-test.com, ${email}`);
      try {
        const signup = await send('/api/auth/signup', { email, phone, password: 'correct horse battery' });
        expect(signup.statusCode, signup.body).toBe(201);
        expect(countTo('sms', phone)).toBe(0);
        expect(await getDb().select().from(schema.phoneCodes).where(eq(schema.phoneCodes.phoneE164, phone))).toHaveLength(0);
        // Email is still required.
        expect((await send('/api/auth/login', { email, password: 'correct horse battery' })).statusCode).toBe(403);
        await verifyEmailOf(email, send);
        const login = await send('/api/auth/login', { email, password: 'correct horse battery' });
        expect(login.statusCode, login.body).toBe(200);
        const me = await skip.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${login.json<{ token: string }>().token}` } });
        expect(me.statusCode).toBe(200);
        // The phone stays unverified in the data: the skip is decided per login from the list.
        const [user] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
        expect(user.phoneVerifiedAt).toBeNull();
        // The skip is logged with the user id and never the email or phone.
        const skipped = logs.filter((line) => line.includes('auth.phone_verify_skipped'));
        expect(skipped.some((line) => line.includes('"step":"signup"'))).toBe(true);
        expect(skipped.some((line) => line.includes('"step":"login"'))).toBe(true);
        expect(skipped.every((line) => line.includes(user.id))).toBe(true);
        expect(logs.join('\n')).not.toContain(email);
        expect(logs.join('\n')).not.toContain(phone);
      } finally {
        await skip.close();
      }
    });

    it('matches regardless of case in the list or the sign-up', async () => {
      const email = uniqueEmail('casey');
      const { app: skip, send } = await skipApp(`  ${email.toUpperCase()}  `);
      try {
        expect((await send('/api/auth/signup', { email: email.replace('casey', 'CaSeY'), phone: uniquePhone(), password: 'correct horse battery' })).statusCode).toBe(201);
        await verifyEmailOf(email, send);
        expect((await send('/api/auth/login', { email: email.toUpperCase(), password: 'correct horse battery' })).statusCode).toBe(200);
      } finally {
        await skip.close();
      }
    });

    it('does not skip for an email that is not on the list', async () => {
      const email = uniqueEmail('outsider');
      const phone = uniquePhone();
      const domain = email.split('@')[1];
      const { app: skip, logs, send } = await skipApp(`tester-${email}, someone@${domain}`);
      try {
        expect((await send('/api/auth/signup', { email, phone, password: 'correct horse battery' })).statusCode).toBe(201);
        expect(countTo('sms', phone)).toBe(1);
        await verifyEmailOf(email, send);
        expect((await send('/api/auth/login', { email, password: 'correct horse battery' })).statusCode).toBe(403);
        expect(logs.join('\n')).not.toContain('auth.phone_verify_skipped');
      } finally {
        await skip.close();
      }
    });

    it('is off by default', async () => {
      const user = await signUp();
      expect(countTo('sms', user.phone)).toBe(1);
      const verified = await call('POST', '/api/auth/verify-email', { token: lastSecret('email', user.email) });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toEqual({ ok: true, phoneRequired: true });
      expect((await call('POST', '/api/auth/login', { email: user.email, password: user.password })).statusCode).toBe(403);
    });

    it('answers phoneRequired: false when the phone was verified before the email', async () => {
      const user = await signUp();
      expect((await call('POST', '/api/auth/verify-phone', { phone: user.phone, code: lastSecret('sms', user.phone) })).statusCode).toBe(200);
      const verified = await call('POST', '/api/auth/verify-email', { token: lastSecret('email', user.email) });
      expect(verified.json()).toEqual({ ok: true, phoneRequired: false });
    });

    it('applies to an existing unverified account added to the list later', async () => {
      const user = await signUp();
      expect(countTo('sms', user.phone)).toBe(1);
      expect((await call('POST', '/api/auth/verify-email', { token: lastSecret('email', user.email) })).statusCode).toBe(200);
      expect((await call('POST', '/api/auth/login', { email: user.email, password: user.password })).statusCode).toBe(403);
      const { app: skip, send } = await skipApp(user.email);
      try {
        expect((await send('/api/auth/login', { email: user.email, password: user.password })).statusCode).toBe(200);
      } finally {
        await skip.close();
      }
    });

    it('sends no SMS on resend-code for an allow-listed email, and answers as usual', async () => {
      const user = await signUp();
      const { app: skip, send } = await skipApp(user.email);
      try {
        const response = await send('/api/auth/resend-code', { email: user.email });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        expect(countTo('sms', user.phone)).toBe(1);
      } finally {
        await skip.close();
      }
    });

    it('leaves password reset unchanged for an allow-listed account', async () => {
      const email = uniqueEmail('resetter');
      const { app: skip, send } = await skipApp(email);
      try {
        expect((await send('/api/auth/signup', { email, phone: uniquePhone(), password: 'correct horse battery' })).statusCode).toBe(201);
        await verifyEmailOf(email, send);
        expect((await send('/api/auth/reset', { email })).statusCode).toBe(200);
        const token = sent.filter((item) => item.purpose === 'reset_password' && item.to === email).at(-1)!.secret;
        expect((await send('/api/auth/reset', { token, password: 'a brand new password' })).statusCode).toBe(200);
        expect((await send('/api/auth/login', { email, password: 'correct horse battery' })).statusCode).toBe(401);
        expect((await send('/api/auth/login', { email, password: 'a brand new password' })).statusCode).toBe(200);
      } finally {
        await skip.close();
      }
    });

    it('refuses to start with an entry that is not an exact email', async () => {
      const { buildApp } = await import('../src/app.js');
      for (const bad of ['*@acme-test.com', '@acme-test.com', 'acme-test.com', 'pat@acme-test.com,*']) {
        vi.stubEnv('PD_SKIP_PHONE_VERIFY_EMAILS', bad);
        await expect(buildApp({ logger: false }), bad).rejects.toThrow(/PD_SKIP_PHONE_VERIFY_EMAILS/);
        vi.unstubAllEnvs();
      }
    });

    it('warns once at startup with the count, never the emails', async () => {
      vi.stubEnv('PD_SKIP_PHONE_VERIFY_EMAILS', 'a@acme-test.com,b@acme-test.com,c@acme-test.com');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { buildApp } = await import('../src/app.js');
      const built = await buildApp({ logger: false });
      vi.unstubAllEnvs();
      await built.close();
      const lines = warn.mock.calls.map((args) => args.map(String).join(' ')).filter((line) => line.includes('PD_SKIP_PHONE_VERIFY_EMAILS'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('3');
      expect(lines[0]).not.toContain('acme-test.com');
    });
  });

  describe('startup', () => {
    it('refuses to start in production with no email/SMS delivery installed', async () => {
      setOutOfBandSink(null);
      vi.stubEnv('NODE_ENV', 'production');
      const { buildApp } = await import('../src/app.js');
      await expect(buildApp({ logger: false })).rejects.toThrow(/delivery/);
      vi.unstubAllEnvs();
    });
  });

  describe('secrets in logs', () => {
    const message: OutOfBandMessage = { channel: 'sms', purpose: 'verify_phone', to: '+15550001111', secret: '424242' };

    function captureConsole() {
      const lines: string[] = [];
      for (const method of ['log', 'warn', 'error', 'info'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(' '));
        });
      }
      return lines;
    }

    it('prints neither the secret nor the destination without a sink', async () => {
      setOutOfBandSink(null);
      vi.stubEnv('PD_DEV_PRINT_SECRETS', '');
      const lines = captureConsole();
      await sendOutOfBand(message);
      expect(lines.join('\n')).not.toContain('424242');
      expect(lines.join('\n')).not.toContain('5550001111');
      vi.unstubAllEnvs();
    });

    it('ignores PD_DEV_PRINT_SECRETS outside NODE_ENV=development', async () => {
      setOutOfBandSink(null);
      vi.stubEnv('PD_DEV_PRINT_SECRETS', '1');
      vi.stubEnv('NODE_ENV', 'production');
      const lines = captureConsole();
      await sendOutOfBand(message);
      expect(lines.join('\n')).not.toContain('424242');
      vi.unstubAllEnvs();
    });

    it('prints only with NODE_ENV=development and PD_DEV_PRINT_SECRETS=1', async () => {
      setOutOfBandSink(null);
      vi.stubEnv('PD_DEV_PRINT_SECRETS', '1');
      vi.stubEnv('NODE_ENV', 'development');
      const lines = captureConsole();
      await sendOutOfBand(message);
      expect(lines.join('\n')).toContain('424242');
      vi.unstubAllEnvs();
    });

    it('does not log the secret when the sink throws', async () => {
      setOutOfBandSink(() => {
        throw new Error('provider down 424242');
      });
      const lines = captureConsole();
      await expect(sendOutOfBand(message)).resolves.toBeUndefined();
      expect(lines.join('\n')).not.toContain('424242');
    });

    it('signup prints no code or token to the console', async () => {
      setOutOfBandSink(null);
      vi.stubEnv('PD_DEV_PRINT_SECRETS', '');
      const lines = captureConsole();
      const email = uniqueEmail('quiet');
      const phone = uniquePhone();
      const response = await call('POST', '/api/auth/signup', { email, phone, password: 'correct horse battery' });
      expect(response.statusCode).toBe(201);
      expect(lines.join('\n')).not.toContain(email);
      expect(lines.join('\n')).not.toContain(phone);
      vi.unstubAllEnvs();
    });
  });
});

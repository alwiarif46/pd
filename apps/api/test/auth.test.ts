import { randomInt, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
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

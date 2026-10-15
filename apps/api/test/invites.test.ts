/**
 * POST /api/invites/accept. The invite code is `<orgId>.<token>`: the route looks the token up
 * under that organization's row-level security, so a code never reaches another organization's
 * invites. The seat is checked again under the organization lock (06 s5), and a user who already
 * belongs to an organization cannot join a second one.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { type OutOfBandMessage, setOutOfBandSink } from '../src/security.js';
import { as, createUser } from './helpers.js';
import { fulfilled, raceInOrder, type Reply } from './races.js';

const unavailable = inject('dbUnavailable');

type User = Awaited<ReturnType<typeof createUser>>;
type Plan = 'free' | 'starter';

describe.skipIf(Boolean(unavailable))('invite accept', () => {
  let app: FastifyInstance;
  const sent: OutOfBandMessage[] = [];

  beforeAll(async () => {
    getPool({ connectionString: inject('appUrl'), max: 6 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  beforeEach(() => {
    sent.length = 0;
    setOutOfBandSink((message) => {
      sent.push(message);
    });
  });

  afterEach(() => {
    setOutOfBandSink(null);
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const setPlan = (orgId: string, plan: Plan) => withOrg(orgId, (db) => db.update(schema.organizations)
    .set({ plan, planStatus: plan === 'free' ? 'free' : 'active' }).where(eq(schema.organizations.id, orgId)));

  /** An organization on `plan` with an owner and `members` members joined a minute apart. */
  async function newOrg(label: string, plan: Plan, members = 0) {
    const owner = await createUser(`${label}-owner`);
    const created = await as(app, owner.token)('POST', '/api/org', { name: `Org ${label}` });
    expect(created.statusCode).toBe(201);
    const orgId = created.json<{ id: string }>().id;
    await setPlan(orgId, plan);
    for (let index = 0; index < members; index += 1) {
      await addMember(orgId, (await createUser(`${label}-m${index}`)).userId);
    }
    return { orgId, owner, name: `Org ${label}` };
  }

  /** A membership written directly as pd_app, after every existing one. */
  async function addMember(orgId: string, userId: string) {
    await withOrg(orgId, async (db) => {
      await db.insert(schema.memberships).values({ orgId, userId, role: 'member', createdAt: new Date(Date.now() + 1000) });
    });
  }

  /** The owner invites `email`; returns the code that was delivered. */
  async function invite(owner: User, email: string): Promise<string> {
    const before = sent.length;
    const response = await as(app, owner.token)('POST', '/api/org/invites', { email });
    expect(response.statusCode, response.body).toBe(201);
    const message = sent.slice(before).find((item) => item.purpose === 'invite' && item.to === email);
    expect(message).toBeDefined();
    return message!.secret;
  }

  const accept = (user: User, code: unknown) => as(app, user.token)('POST', '/api/invites/accept', { code });
  const codeOf = (response: Reply) => response.json<{ code: string }>().code;

  const membershipsOf = async (userId: string) => {
    const result = await getPool().query<{ n: number }>('select count(*)::int as n from pd_system.user_memberships($1)', [userId]);
    return result.rows[0].n;
  };
  const memberCount = (orgId: string) => withOrg(orgId, async (db) => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.memberships).where(eq(schema.memberships.orgId, orgId));
    return row.n;
  });
  const inviteRow = (orgId: string, email: string) => withOrg(orgId, async (db) => {
    const [row] = await db.select().from(schema.invites).where(and(eq(schema.invites.orgId, orgId), eq(schema.invites.email, email)));
    return row;
  });

  it('issues the code as <orgId>.<token>', async () => {
    const { orgId, owner } = await newOrg('inv-format', 'starter');
    const invitee = await createUser('inv-format-x');
    const code = await invite(owner, invitee.email);
    expect(code).toMatch(new RegExp(`^${orgId}\\.[0-9a-f]{64}$`));
  });

  it('accepts: the invitee becomes a seated member and the invite is used', async () => {
    const { orgId, owner, name } = await newOrg('inv-happy', 'starter');
    const invitee = await createUser('inv-happy-x');
    const code = await invite(owner, invitee.email);
    const response = await accept(invitee, code);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ orgId, name, role: 'member', alreadyMember: false });
    expect((await as(app, invitee.token)('GET', '/api/bids')).statusCode).toBe(200);
    expect((await inviteRow(orgId, invitee.email)).acceptedAt).not.toBeNull();
    const members = (await as(app, owner.token)('GET', '/api/org/members')).json<{ userId: string; seatLocked: boolean }[]>();
    expect(members.find((member) => member.userId === invitee.userId)).toMatchObject({ seatLocked: false });
  });

  it('needs a signed-in user', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/invites/accept', payload: { code: 'x' } });
    expect(response.statusCode).toBe(401);
  });

  it('refuses malformed codes before reaching the database', async () => {
    const user = await createUser('inv-malformed');
    const hex = 'a'.repeat(64);
    for (const code of ['abc', `notauuid.${hex}`, '00000000-0000-4000-8000-000000000000.short', '', 42, `${hex}`]) {
      const response = await accept(user, code);
      expect(response.statusCode, String(code)).toBe(404);
      expect(codeOf(response)).toBe('invite_invalid');
    }
    const noBody = await as(app, user.token)('POST', '/api/invites/accept');
    expect(noBody.statusCode).toBe(400);
    expect(codeOf(noBody)).toBe('invite_invalid');
  });

  it("is tenant-safe: org B's id with org A's token finds nothing", async () => {
    const a = await newOrg('inv-tenant-a', 'starter');
    const b = await newOrg('inv-tenant-b', 'starter');
    const invitee = await createUser('inv-tenant-x');
    const code = await invite(a.owner, invitee.email);
    const token = code.split('.')[1];
    const response = await accept(invitee, `${b.orgId}.${token}`);
    expect(response.statusCode).toBe(404);
    expect(codeOf(response)).toBe('invite_invalid');
    expect(await memberCount(a.orgId)).toBe(1);
    expect(await memberCount(b.orgId)).toBe(1);
    expect(await membershipsOf(invitee.userId)).toBe(0);
    expect((await inviteRow(a.orgId, invitee.email)).acceptedAt).toBeNull();
    // An org id that does not exist at all answers the same way.
    const unknown = await accept(invitee, `00000000-0000-4000-8000-000000000000.${token}`);
    expect(unknown.statusCode).toBe(404);
    expect(codeOf(unknown)).toBe('invite_invalid');
  });

  it('refuses a user whose email differs, without consuming the invite or naming the address', async () => {
    const { orgId, owner } = await newOrg('inv-email', 'starter');
    const intended = await createUser('inv-email-y');
    const other = await createUser('inv-email-x');
    const code = await invite(owner, intended.email);
    const refused = await accept(other, code);
    expect(refused.statusCode).toBe(403);
    expect(codeOf(refused)).toBe('invite_email_mismatch');
    expect(refused.body).not.toContain(intended.email);
    expect(await membershipsOf(other.userId)).toBe(0);
    expect((await inviteRow(orgId, intended.email)).acceptedAt).toBeNull();
    expect((await accept(intended, code)).statusCode).toBe(200);
  });

  it('refuses an expired invite', async () => {
    const { orgId, owner } = await newOrg('inv-expired', 'starter');
    const invitee = await createUser('inv-expired-x');
    const code = await invite(owner, invitee.email);
    await withOrg(orgId, (db) => db.update(schema.invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invites.orgId, orgId)));
    const response = await accept(invitee, code);
    expect(response.statusCode).toBe(409);
    expect(codeOf(response)).toBe('invite_expired');
    expect(await membershipsOf(invitee.userId)).toBe(0);
  });

  it('refuses an invite already used when the user is not a member', async () => {
    const { orgId, owner } = await newOrg('inv-used', 'starter');
    const invitee = await createUser('inv-used-x');
    const code = await invite(owner, invitee.email);
    await withOrg(orgId, (db) => db.update(schema.invites).set({ acceptedAt: new Date() }).where(eq(schema.invites.orgId, orgId)));
    const response = await accept(invitee, code);
    expect(response.statusCode).toBe(409);
    expect(codeOf(response)).toBe('invite_used');
    expect(await membershipsOf(invitee.userId)).toBe(0);
  });

  it('a second accept by the same user is idempotent', async () => {
    const { orgId, owner, name } = await newOrg('inv-twice', 'starter');
    const invitee = await createUser('inv-twice-x');
    const code = await invite(owner, invitee.email);
    expect((await accept(invitee, code)).json()).toMatchObject({ alreadyMember: false });
    const again = await accept(invitee, code);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ orgId, name, role: 'member', alreadyMember: true });
    expect(await membershipsOf(invitee.userId)).toBe(1);
  });

  it('two accepts at once by the same user make exactly one membership', async () => {
    const { orgId, owner } = await newOrg('inv-race-same', 'starter');
    const invitee = await createUser('inv-race-same-x');
    const code = await invite(owner, invitee.email);
    const { waiting, results } = await raceInOrder(orgId, 'select id from organizations where id = $1 for update', [orgId], [
      () => accept(invitee, code),
      () => accept(invitee, code),
    ]);
    expect(waiting).toBe(2);
    const replies = results.map((result) => fulfilled(result) as Reply);
    expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200]);
    expect(replies.map((reply) => reply.json<{ alreadyMember: boolean }>().alreadyMember).sort()).toEqual([false, true]);
    expect(await membershipsOf(invitee.userId)).toBe(1);
  });

  it('refuses when the plan has no free seat, keeps the invite pending, and accepts after an upgrade', async () => {
    const { orgId, owner } = await newOrg('inv-full', 'starter', 1);
    const invitee = await createUser('inv-full-x');
    const code = await invite(owner, invitee.email);
    await setPlan(orgId, 'free');
    const refused = await accept(invitee, code);
    expect(refused.statusCode).toBe(409);
    expect(codeOf(refused)).toBe('seats_full');
    expect(await membershipsOf(invitee.userId)).toBe(0);
    expect((await inviteRow(orgId, invitee.email)).acceptedAt).toBeNull();
    await setPlan(orgId, 'starter');
    const accepted = await accept(invitee, code);
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it('two invitees racing for the last seat: exactly one joins', async () => {
    const { orgId, owner } = await newOrg('inv-race-seat', 'starter', 2);
    const u1 = await createUser('inv-race-seat-1');
    const u2 = await createUser('inv-race-seat-2');
    const code1 = await invite(owner, u1.email);
    const code2 = await invite(owner, u2.email);
    // A fourth membership leaves one Starter seat (pending invites do not block an accept).
    await addMember(orgId, (await createUser('inv-race-seat-extra')).userId);
    const { waiting, results } = await raceInOrder(orgId, 'select id from organizations where id = $1 for update', [orgId], [
      () => accept(u1, code1),
      () => accept(u2, code2),
    ]);
    expect(waiting).toBe(2);
    const replies = results.map((result) => fulfilled(result) as Reply);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
    expect(codeOf(replies.find((reply) => reply.statusCode === 409)!)).toBe('seats_full');
    expect(await memberCount(orgId)).toBe(5);
    const members = (await as(app, owner.token)('GET', '/api/org/members')).json<{ seatLocked: boolean }[]>();
    expect(members).toHaveLength(5);
    expect(members.some((member) => member.seatLocked)).toBe(false);
  });

  it('refuses a user who already belongs to another organization, and keeps the invite pending', async () => {
    const a = await newOrg('inv-elsewhere-a', 'starter');
    const c = await newOrg('inv-elsewhere-c', 'starter');
    const code = await invite(a.owner, c.owner.email);
    const response = await accept(c.owner, code);
    expect(response.statusCode).toBe(409);
    expect(codeOf(response)).toBe('already_in_org');
    expect(await memberCount(a.orgId)).toBe(1);
    expect((await inviteRow(a.orgId, c.owner.email)).acceptedAt).toBeNull();
  });

  it('an organization create and an accept at once for one user: exactly one succeeds', async () => {
    for (const order of ['create-first', 'accept-first'] as const) {
      const { owner } = await newOrg(`inv-vs-create-${order}`, 'starter');
      const user = await createUser(`inv-vs-create-${order}-x`);
      const code = await invite(owner, user.email);
      const create = () => as(app, user.token)('POST', '/api/org', { name: 'Own org' });
      const join = () => accept(user, code);
      // Any org id works for the holder: the lock is the per-user advisory lock both routes take.
      const { waiting, results } = await raceInOrder(
        '00000000-0000-4000-8000-000000000000',
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`org-create:${user.userId}`],
        order === 'create-first' ? [create, join] : [join, create],
      );
      expect(waiting).toBe(2);
      const replies = results.map((result) => fulfilled(result) as Reply);
      const codes = replies.map((reply) => reply.statusCode);
      if (order === 'create-first') {
        expect(codes).toEqual([201, 409]);
        expect(codeOf(replies[1])).toBe('already_in_org');
      } else {
        expect(codes).toEqual([200, 409]);
      }
      expect(await membershipsOf(user.userId)).toBe(1);
    }
  });
});

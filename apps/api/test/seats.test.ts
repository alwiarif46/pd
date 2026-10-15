/**
 * Seats after a move to a smaller plan (06 s5): owners always hold a seat, then members in the
 * order they joined fill what the plan allows; the rest get 403 seat_locked on every org route
 * until the owner removes members or upgrades. Invites not yet accepted hold a seat too.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { as, createUser } from './helpers.js';

const unavailable = inject('dbUnavailable');

describe.skipIf(Boolean(unavailable))('seats', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    getPool({ connectionString: inject('appUrl'), max: 4 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /** An organization on `plan` with an owner and `members` members, each joined a minute apart. */
  async function newOrg(label: string, plan: 'free' | 'starter', members: number) {
    const owner = await createUser(`${label}-owner`);
    const created = await as(app, owner.token)('POST', '/api/org', { name: `Org ${label}` });
    expect(created.statusCode).toBe(201);
    const orgId = created.json<{ id: string }>().id;
    const users: Awaited<ReturnType<typeof createUser>>[] = [];
    for (let index = 0; index < members; index += 1) {
      users.push(await createUser(`${label}-m${index}`));
    }
    await withOrg(orgId, async (db) => {
      await db.update(schema.organizations).set({ plan, planStatus: plan === 'free' ? 'free' : 'active' }).where(eq(schema.organizations.id, orgId));
      const [ownerRow] = await db.select().from(schema.memberships).where(eq(schema.memberships.orgId, orgId));
      for (const [index, user] of users.entries()) {
        await db.insert(schema.memberships).values({
          orgId,
          userId: user.userId,
          role: 'member',
          createdAt: new Date(ownerRow.createdAt.getTime() + (index + 1) * 60_000),
        });
      }
    });
    const setPlan = (next: 'free' | 'starter') => withOrg(orgId, (db) => db.update(schema.organizations)
      .set({ plan: next, planStatus: next === 'free' ? 'free' : 'active' }).where(eq(schema.organizations.id, orgId)));
    return { orgId, owner, users, setPlan };
  }

  const bids = (token: string) => as(app, token)('GET', '/api/bids');

  it('after a move to free only the owner and the earliest member get in; removing a member or upgrading restores access', async () => {
    const { owner, users: [first, second, third], setPlan } = await newOrg('seats-free', 'starter', 3);
    for (const user of [owner, first, second, third]) {
      expect((await bids(user.token)).statusCode).toBe(200);
    }

    await setPlan('free');
    expect((await bids(owner.token)).statusCode).toBe(200);
    expect((await bids(first.token)).statusCode).toBe(200);
    for (const locked of [second, third]) {
      const refused = await bids(locked.token);
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ code: string }>().code).toBe('seat_locked');
      // Every org route, not only bids.
      expect((await as(app, locked.token)('GET', '/api/org')).statusCode).toBe(403);
    }
    const members = (await as(app, owner.token)('GET', '/api/org/members')).json<{ userId: string; seatLocked: boolean }[]>();
    expect(members.map((member) => [member.userId, member.seatLocked])).toEqual([
      [owner.userId, false],
      [first.userId, false],
      [second.userId, true],
      [third.userId, true],
    ]);

    // The owner removes the earliest member: the next one in join order takes the seat.
    expect((await as(app, owner.token)('DELETE', `/api/org/members/${first.userId}`)).statusCode).toBe(200);
    expect((await bids(second.token)).statusCode).toBe(200);
    expect((await bids(third.token)).statusCode).toBe(403);

    await setPlan('starter');
    expect((await bids(third.token)).statusCode).toBe(200);
  });

  it('an owner who joined after the members is never locked out, and takes a seat first', async () => {
    const { orgId, owner, users: [first, second], setPlan } = await newOrg('seats-late-owner', 'starter', 2);
    await withOrg(orgId, (db) => db.update(schema.memberships).set({ createdAt: new Date(Date.now() + 3_600_000) })
      .where(eq(schema.memberships.userId, owner.userId)));
    await setPlan('free');
    expect((await bids(owner.token)).statusCode).toBe(200);
    expect((await bids(first.token)).statusCode).toBe(200);
    expect((await bids(second.token)).statusCode).toBe(403);
  });

  it('pending, unexpired invites count toward the seat limit', async () => {
    const { orgId, owner } = await newOrg('seats-invites', 'starter', 2);
    const invite = (email: string) => as(app, owner.token)('POST', '/api/org/invites', { email });
    // Three members; two invites fill the five Starter seats.
    expect((await invite('a@acme-seats.com')).statusCode).toBe(201);
    expect((await invite('b@acme-seats.com')).statusCode).toBe(201);
    expect((await invite('c@acme-seats.com')).statusCode).toBe(402);
    // An expired invite frees its seat, and so does an accepted one (it became a membership).
    await withOrg(orgId, (db) => db.update(schema.invites).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invites.email, 'a@acme-seats.com')));
    expect((await invite('c@acme-seats.com')).statusCode).toBe(201);
    await withOrg(orgId, (db) => db.update(schema.invites).set({ acceptedAt: new Date() })
      .where(eq(schema.invites.email, 'b@acme-seats.com')));
    expect((await invite('d@acme-seats.com')).statusCode).toBe(201);
  });
});

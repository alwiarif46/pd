import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeDb, getDb, getPool, schema, withOrg } from '@pd/core';
import { as, createUser } from './helpers.js';

const unavailable = inject('dbUnavailable');

interface MemberDto {
  orgId: string;
  userId: string;
  name: string | null;
  email: string;
  role: 'owner' | 'member';
  joinedAt: string;
  isYou: boolean;
}

describe.skipIf(Boolean(unavailable))('GET /api/org/members and GET /api/org', () => {
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

  async function newOrg(label: string) {
    const owner = await createUser(`${label}-owner`);
    await getDb().update(schema.users).set({ name: `Owner ${label}` }).where(eq(schema.users.id, owner.userId));
    const call = as(app, owner.token);
    const created = await call('POST', '/api/org', { name: `Org ${label}` });
    expect(created.statusCode).toBe(201);
    const orgId = created.json<{ id: string }>().id;
    // Joined a second after the owner (as stored), so the order is certain.
    const member = await createUser(`${label}-member`);
    await withOrg(orgId, async (db) => {
      const [ownerRow] = await db.select().from(schema.memberships).where(eq(schema.memberships.orgId, orgId));
      await db.insert(schema.memberships).values({
        orgId,
        userId: member.userId,
        role: 'member',
        createdAt: new Date(ownerRow.createdAt.getTime() + 1000),
      });
    });
    return { orgId, owner, member, call, memberCall: as(app, member.token) };
  }

  it('returns names, emails, roles, join dates, and isYou, oldest member first', async () => {
    const org = await newOrg('members-a');
    const response = await org.call('GET', '/api/org/members');
    expect(response.statusCode).toBe(200);
    const members = response.json<MemberDto[]>();
    expect(members.map((member) => member.userId)).toEqual([org.owner.userId, org.member.userId]);
    expect(members[0]).toMatchObject({ name: 'Owner members-a', role: 'owner', isYou: true });
    expect(members[0].email).toMatch(/^members-a-owner-/);
    expect(members[1]).toMatchObject({ name: null, role: 'member', isYou: false });
    expect(members[1].email).toMatch(/^members-a-member-/);
    expect(Number.isNaN(Date.parse(members[0].joinedAt))).toBe(false);
    expect(Object.keys(members[0]).sort()).toEqual(['email', 'isYou', 'joinedAt', 'name', 'orgId', 'role', 'userId']);
    expect(members.every((member) => member.orgId === org.orgId)).toBe(true);

    const asMember = (await org.memberCall('GET', '/api/org/members')).json<MemberDto[]>();
    expect(asMember.map((member) => member.isYou)).toEqual([false, true]);
  });

  it('never lists another organization\'s members', async () => {
    const mine = await newOrg('members-mine');
    const theirs = await newOrg('members-theirs');
    const ids = (await mine.call('GET', '/api/org/members')).json<MemberDto[]>().map((member) => member.userId);
    expect(ids).not.toContain(theirs.owner.userId);
    expect(ids).not.toContain(theirs.member.userId);
    // Naming the other organization in X-Org-Id does not get its members either.
    const crossed = await app.inject({
      method: 'GET',
      url: '/api/org/members',
      headers: { authorization: `Bearer ${mine.owner.token}`, 'x-org-id': theirs.orgId },
    });
    expect(crossed.statusCode).toBe(403);
  });

  it('adds seatLimit, mbCap, billingAvailable, and plan_status free to GET /api/org', async () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const org = await newOrg('org-fields');
      const payload = (await org.call('GET', '/api/org')).json<{
        org: { planStatus: string; plan: string };
        seatLimit: number;
        mbCap: number;
        billingAvailable: boolean;
        role: string;
      }>();
      expect(payload).toMatchObject({
        org: { plan: 'free', planStatus: 'free' },
        seatLimit: 2,
        mbCap: 50,
        billingAvailable: false,
        role: 'owner',
      });
    } finally {
      if (saved !== undefined) {
        process.env.STRIPE_SECRET_KEY = saved;
      }
    }
  });
});

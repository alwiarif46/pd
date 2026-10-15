import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { as, createUser } from './helpers.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const unavailable = inject('dbUnavailable');
const DAY = 24 * 60 * 60 * 1000;

interface Org {
  orgId: string;
  token: string;
  call: ReturnType<typeof as>;
  bid: (solicitationNumber?: string) => Promise<string>;
}

describe.skipIf(Boolean(unavailable))('RFP credits and uploads', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-credits-'));
    getPool({ connectionString: inject('appUrl'), max: 6 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  async function newOrg(label: string, setup?: { plan?: 'free' | 'starter' | 'growth'; createdDaysAgo?: number }): Promise<Org> {
    const user = await createUser(label);
    const call = as(app, user.token);
    const created = await call('POST', '/api/org', { name: `Org ${label}` });
    expect(created.statusCode).toBe(201);
    const orgId = created.json<{ id: string }>().id;
    if (setup) {
      await withOrg(orgId, (db) => db.update(schema.organizations).set({
        plan: setup.plan ?? 'free',
        createdAt: new Date(Date.now() - (setup.createdDaysAgo ?? 0) * DAY),
      }).where(eq(schema.organizations.id, orgId)));
    }
    return {
      orgId,
      token: user.token,
      call,
      bid: async (solicitationNumber?: string) => {
        const response = await call('POST', '/api/bids', { name: `Bid ${randomBytes(3).toString('hex')}`, bidType: 'sled', solicitationNumber });
        expect(response.statusCode).toBe(201);
        return response.json<{ id: string }>().id;
      },
    };
  }

  function start(org: Org, bidId: string, extra: Record<string, unknown> = {}) {
    const bytes = randomBytes(16);
    return org.call('POST', `/api/bids/${bidId}/uploads`, {
      fileName: 'rfp.pdf',
      kind: 'solicitation',
      declaredSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      chunkCount: 1,
      ...extra,
    });
  }

  const credits = (orgId: string) => withOrg(orgId, (db) => db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.orgId, orgId)));
  const bidRow = (orgId: string, bidId: string) => withOrg(orgId, async (db) => {
    const [row] = await db.select().from(schema.bids).where(eq(schema.bids.id, bidId));
    return row;
  });

  it('GET /api/org returns the period that holds now, whatever order the rows were written in', async () => {
    const org = await newOrg('periods');
    const now = Date.now();
    await withOrg(org.orgId, async (db) => {
      await db.insert(schema.rfpCredits).values({ orgId: org.orgId, periodStart: new Date(now + 10 * DAY), periodEnd: new Date(now + 40 * DAY), allowed: 7 });
      await db.insert(schema.rfpCredits).values({ orgId: org.orgId, periodStart: new Date(now - 60 * DAY), periodEnd: new Date(now - 30 * DAY), allowed: 5 });
      await db.insert(schema.rfpCredits).values({ orgId: org.orgId, periodStart: new Date(now - 5 * DAY), periodEnd: new Date(now + 5 * DAY), allowed: 3 });
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await org.call('GET', '/api/org');
      expect(response.statusCode).toBe(200);
      expect(response.json<{ credits: { allowed: number } }>().credits.allowed).toBe(3);
    }
  });

  type Shown = { id: string | null; periodStart: string; periodEnd: string; allowed: number; used: number; reserved: number };

  it('GET /api/org shows the period an upload would open once the last one has ended, without writing it', async () => {
    const org = await newOrg('ended');
    const endedAt = new Date(Date.now() - 30 * DAY);
    await withOrg(org.orgId, (db) => db.insert(schema.rfpCredits).values({
      orgId: org.orgId, periodStart: new Date(Date.now() - 60 * DAY), periodEnd: endedAt, allowed: 2,
    }));
    const shown = (await org.call('GET', '/api/org')).json<{ credits: Shown }>().credits;
    expect(shown.id).toBeNull();
    // Not the first period: the free plan allows 1.
    expect(shown).toMatchObject({ allowed: 1, used: 0, reserved: 0 });
    expect(new Date(shown.periodStart).getTime()).toBeGreaterThanOrEqual(endedAt.getTime());
    expect(new Date(shown.periodEnd).getTime()).toBeGreaterThan(Date.now());
    expect(await credits(org.orgId)).toHaveLength(1);
  });

  it('GET /api/org shows a new organization its first-month allowance before any upload, and the upload opens that period', async () => {
    const org = await newOrg('projected');
    const shown = (await org.call('GET', '/api/org')).json<{ credits: Shown }>().credits;
    expect(shown).toMatchObject({ id: null, allowed: 2, used: 0, reserved: 0 });
    expect(new Date(shown.periodStart).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(shown.periodEnd).getTime()).toBeGreaterThan(Date.now());
    expect(await credits(org.orgId)).toHaveLength(0);

    expect((await start(org, await org.bid())).statusCode).toBe(201);
    const [row] = await credits(org.orgId);
    expect(row.allowed).toBe(shown.allowed);
    expect(row.periodStart.toISOString()).toBe(shown.periodStart);
    expect(row.periodEnd.toISOString()).toBe(shown.periodEnd);
    const after = (await org.call('GET', '/api/org')).json<{ credits: Shown }>().credits;
    expect(after).toMatchObject({ id: row.id, allowed: 2, reserved: 1 });
  });

  it('after a period expires, an upload opens the period that holds now, once', async () => {
    const org = await newOrg('expired', { plan: 'free', createdDaysAgo: 75 });
    await withOrg(org.orgId, (db) => db.insert(schema.rfpCredits).values({
      orgId: org.orgId, periodStart: new Date(Date.now() - 75 * DAY), periodEnd: new Date(Date.now() - 45 * DAY), allowed: 2, used: 2,
    }));
    expect((await start(org, await org.bid())).statusCode).toBe(201);
    expect((await start(org, await org.bid())).statusCode).toBe(402);
    const rows = await credits(org.orgId);
    expect(rows).toHaveLength(2);
    const current = rows.find((row) => row.periodEnd.getTime() > Date.now())!;
    expect(current.periodStart.getTime()).toBeLessThanOrEqual(Date.now());
    // Not the first month after signup: the free plan allows 1.
    expect(current.allowed).toBe(1);
    expect(current.reserved).toBe(1);
  });

  it('a new free organization gets 2 credits in its first month', async () => {
    const org = await newOrg('fresh');
    expect((await start(org, await org.bid())).statusCode).toBe(201);
    const [row] = await credits(org.orgId);
    expect(row.allowed).toBe(2);
  });

  it.each([['starter', 10], ['growth', 20]] as const)('the %s allowance comes from PLAN_LIMITS', async (plan, allowed) => {
    const org = await newOrg(`plan-${plan}`, { plan, createdDaysAgo: 3 });
    expect((await start(org, await org.bid())).statusCode).toBe(201);
    const [row] = await credits(org.orgId);
    expect(row.allowed).toBe(allowed);
  });

  it('out of credits answers 402 with a code and a readable message', async () => {
    const org = await newOrg('out', { plan: 'free', createdDaysAgo: 90 });
    expect((await start(org, await org.bid())).statusCode).toBe(201);
    const response = await start(org, await org.bid());
    expect(response.statusCode).toBe(402);
    const body = response.json<{ code: string; error: string }>();
    expect(body.code).toBe('out_of_credits');
    expect(body.error).not.toBe('out_of_credits');
    expect(body.error).toMatch(/no RFP credits left/);
  });

  it('refuses bad sizes with a code', async () => {
    const org = await newOrg('sizes');
    const bidId = await org.bid();
    for (const declaredSize of [-5, 0, 1.5, '10']) {
      const response = await start(org, bidId, { declaredSize });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('invalid_upload');
    }
  });

  it('checks for a duplicate file before the bid cap', async () => {
    const org = await newOrg('dup', { plan: 'free', createdDaysAgo: 1 });
    const bidId = await org.bid();
    const sha = 'd'.repeat(64);
    const big = 50 * 1024 * 1024;
    await withOrg(org.orgId, (db) => db.insert(schema.documents).values({
      orgId: org.orgId, bidId, fileName: 'full.pdf', mime: 'application/pdf', sizeBytes: big, sha256: sha, kind: 'attachment', liveStatus: 'live',
    }));
    const duplicate = await start(org, bidId, { sha256: sha, declaredSize: big, chunkCount: 3, kind: 'attachment' });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json<{ duplicate: boolean }>().duplicate).toBe(true);
    const other = await start(org, bidId, { declaredSize: 10, kind: 'attachment' });
    expect(other.statusCode).toBe(413);
    expect(other.json<{ code: string }>().code).toBe('bid_cap_exceeded');
  });

  it('refuses a solicitation whose number does not match the bid, and sets a pending key', async () => {
    const org = await newOrg('keys', { plan: 'starter', createdDaysAgo: 1 });
    const fixed = await org.bid('RFP-2026-01');
    const mismatch = await start(org, fixed, { solicitationNumber: 'RFP-2026-99' });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json<{ code: string }>().code).toBe('key_mismatch');
    expect((await start(org, fixed, { solicitationNumber: 'rfp 2026 01' })).statusCode).toBe(201);
    const pending = await org.bid();
    expect((await start(org, pending, { solicitationNumber: 'SLED-77' })).statusCode).toBe(201);
    expect((await bidRow(org.orgId, pending)).solicitationKey).toBe('SLED77');
    expect((await start(org, pending, { solicitationNumber: 'SLED-78' })).statusCode).toBe(409);
  });

  it('two concurrent solicitations on two bids with one credit left: one wins', async () => {
    const org = await newOrg('race', { plan: 'free', createdDaysAgo: 90 });
    const [b1, b2] = [await org.bid(), await org.bid()];
    const results = await Promise.all([start(org, b1), start(org, b2)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 402]);
    const [row] = await credits(org.orgId);
    expect(row.reserved).toBe(1);
    expect(row.allowed).toBe(1);
  });

  it('concurrent solicitation starts on one bid reserve one credit', async () => {
    const org = await newOrg('same-bid', { plan: 'starter', createdDaysAgo: 1 });
    const bidId = await org.bid();
    // A later solicitation must state its number (06 s4), so each start names the same one.
    const numbered = { solicitationNumber: 'SAME-1' };
    const results = await Promise.all([start(org, bidId, numbered), start(org, bidId, numbered), start(org, bidId, numbered)]);
    expect(results.every((result) => result.statusCode === 201)).toBe(true);
    const rows = await credits(org.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].reserved).toBe(1);
  });

  it('cancelling an upload releases its credit exactly once, even when cancelled twice at once', async () => {
    const org = await newOrg('cancel', { plan: 'free', createdDaysAgo: 90 });
    const bidId = await org.bid();
    const started = await start(org, bidId);
    const sessionId = started.json<{ id: string }>().id;
    const results = await Promise.all([org.call('DELETE', `/api/uploads/${sessionId}`), org.call('DELETE', `/api/uploads/${sessionId}`)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 404]);
    const [row] = await credits(org.orgId);
    expect(row.reserved).toBe(0);
    expect((await bidRow(org.orgId, bidId)).creditStatus).toBe('released');
    // The credit is free again for another bid.
    expect((await start(org, await org.bid())).statusCode).toBe(201);
  });

  it('an expired upload gives its credit back when the organization is next read', async () => {
    const org = await newOrg('expire', { plan: 'free', createdDaysAgo: 90 });
    const bidId = await org.bid();
    const sessionId = (await start(org, bidId)).json<{ id: string }>().id;
    await withOrg(org.orgId, (db) => db.update(schema.uploadSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.uploadSessions.id, sessionId)));
    const shown = await org.call('GET', '/api/org');
    expect(shown.json<{ credits: { reserved: number } }>().credits.reserved).toBe(0);
    const [session] = await withOrg(org.orgId, (db) => db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, sessionId)));
    expect(session.status).toBe('expired');
    // Completing it afterwards is refused, so no document arrives without a credit.
    expect((await org.call('POST', `/api/uploads/${sessionId}/complete`)).statusCode).toBe(404);
  });

  it('a solicitation completed after its bid lost the reservation reserves again, or is refused', async () => {
    const org = await newOrg('handover', { plan: 'free', createdDaysAgo: 90 });
    const bidId = await org.bid();
    const first = (await start(org, bidId)).json<{ id: string }>().id;
    const bytes = randomBytes(32);
    const second = await start(org, bidId, { declaredSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), solicitationNumber: 'RFP-1' });
    expect(second.json<{ creditReserved: boolean }>().creditReserved).toBe(false);
    const secondId = second.json<{ id: string }>().id;
    expect((await org.call('DELETE', `/api/uploads/${first}`)).statusCode).toBe(200);
    // Use the freed credit elsewhere, so none is left for the second session.
    expect((await start(org, await org.bid())).statusCode).toBe(201);
    const chunk = await app.inject({
      method: 'PUT',
      url: `/api/uploads/${secondId}/chunks/0`,
      headers: { authorization: `Bearer ${org.token}`, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(chunk.statusCode).toBe(200);
    const refused = await org.call('POST', `/api/uploads/${secondId}/complete`);
    expect(refused.statusCode).toBe(402);
    expect(refused.json<{ code: string }>().code).toBe('out_of_credits');
    const documents = await withOrg(org.orgId, (db) => db.select().from(schema.documents).where(and(eq(schema.documents.bidId, bidId))));
    expect(documents).toHaveLength(0);
  });

  it('a complete that fails the byte check reserves nothing; the next good complete reserves and records it', async () => {
    const org = await newOrg('late-reserve', { plan: 'starter', createdDaysAgo: 1 });
    const bidId = await org.bid();
    const first = (await start(org, bidId)).json<{ id: string }>().id;
    const bytes = randomBytes(32);
    const secondId = (await start(org, bidId, { declaredSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), solicitationNumber: 'RFP-1' })).json<{ id: string }>().id;
    expect((await org.call('DELETE', `/api/uploads/${first}`)).statusCode).toBe(200);
    const put = (payload: Buffer) => app.inject({
      method: 'PUT',
      url: `/api/uploads/${secondId}/chunks/0`,
      headers: { authorization: `Bearer ${org.token}`, 'content-type': 'application/octet-stream' },
      payload,
    });
    expect((await put(randomBytes(32))).statusCode).toBe(200);
    expect((await org.call('POST', `/api/uploads/${secondId}/complete`)).statusCode).toBe(400);
    expect((await credits(org.orgId))[0].reserved).toBe(0);
    expect((await bidRow(org.orgId, bidId)).creditStatus).toBe('released');

    expect((await put(bytes)).statusCode).toBe(200);
    expect((await org.call('POST', `/api/uploads/${secondId}/complete`)).statusCode).toBe(201);
    const [row] = await credits(org.orgId);
    expect(row.reserved).toBe(1);
    const [session] = await withOrg(org.orgId, (db) => db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, secondId)));
    expect(session.creditId).toBe(row.id);
    expect((await bidRow(org.orgId, bidId)).creditStatus).toBe('reserved');
  });

  it('a retry after a failed first solicitation releases its credit when abandoned', async () => {
    const org = await newOrg('retry', { plan: 'starter', createdDaysAgo: 1 });
    const bidId = await org.bid();
    // The first solicitation's processing failed and released its credit.
    await withOrg(org.orgId, async (db) => {
      await db.insert(schema.documents).values({
        orgId: org.orgId, bidId, fileName: 'old.pdf', mime: 'application/pdf', sizeBytes: 10,
        sha256: 'f'.repeat(64), kind: 'solicitation', liveStatus: 'live', createdAt: new Date(Date.now() - 60_000),
      });
      await db.update(schema.bids).set({ creditStatus: 'released' }).where(eq(schema.bids.id, bidId));
    });
    const retry = await start(org, bidId, { solicitationNumber: 'RFP-1' });
    expect(retry.json<{ creditReserved: boolean }>().creditReserved).toBe(true);
    const cancelled = await org.call('DELETE', `/api/uploads/${retry.json<{ id: string }>().id}`);
    expect(cancelled.json<{ creditReleased: boolean }>().creditReleased).toBe(true);
    expect((await credits(org.orgId))[0].reserved).toBe(0);
    expect((await bidRow(org.orgId, bidId)).creditStatus).toBe('released');
  });
});

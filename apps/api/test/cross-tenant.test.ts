/**
 * Plan 08, Phase 5: "User A requests every endpoint with user B's IDs and gets 404."
 * Runs through the HTTP routes with Fastify inject, connected as pd_app.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { as, createTenant, ROW_TABLES, seedBidRows, TABS, type Tenant } from './helpers.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const unavailable = inject('dbUnavailable');

/**
 * Run twice: as pd_app (row-level security and route checks together), and as the
 * superuser that owns the test database, which skips row-level security, so every 404
 * there has to come from the routes' own organization checks (defense in depth).
 */
const MODES = [
  { name: 'as pd_app', url: () => inject('appUrl'), bypass: false },
  { name: 'as a superuser, route checks only', url: () => inject('adminUrl'), bypass: true },
];

describe.skipIf(Boolean(unavailable))('startup role check', () => {
  afterAll(async () => {
    delete process.env.PD_ALLOW_BYPASS_RLS;
    await closeDb();
  });

  it('refuses to build the app as a role that skips row-level security', async () => {
    delete process.env.PD_ALLOW_BYPASS_RLS;
    getPool({ connectionString: inject('adminUrl'), max: 1 });
    const { buildApp } = await import('../src/app.js');
    await expect(buildApp({ logger: false })).rejects.toThrow(/skips row-level security/);
    process.env.PD_ALLOW_BYPASS_RLS = '1';
    const app = await buildApp({ logger: false });
    await app.close();
  });
});

describe.skipIf(Boolean(unavailable)).each(MODES)('cross-tenant access through the api $name', (mode) => {
  let app: FastifyInstance;
  let a: Tenant;
  let b: Tenant;
  let asA: ReturnType<typeof as>;
  let asB: ReturnType<typeof as>;

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-files-'));
    if (mode.bypass) {
      process.env.PD_ALLOW_BYPASS_RLS = '1';
    } else {
      delete process.env.PD_ALLOW_BYPASS_RLS;
    }
    getPool({ connectionString: mode.url(), max: 4 });
    const { rows } = await getPool().query<{ user: string }>('select current_user as user');
    if (mode.bypass) {
      expect(rows[0].user).not.toBe('pd_app');
    } else {
      expect(rows[0].user).toBe('pd_app');
    }
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    a = await createTenant(app, 'a');
    b = await createTenant(app, 'b');
    asA = as(app, a.token);
    asB = as(app, b.token);
  });

  afterAll(async () => {
    delete process.env.PD_ALLOW_BYPASS_RLS;
    await app?.close();
    await closeDb();
  });

  it('lets each owner read their own bid and rows (control)', async () => {
    expect((await asA('GET', `/api/bids/${a.bidId}`)).statusCode).toBe(200);
    expect((await asB('GET', `/api/bids/${b.bidId}`)).statusCode).toBe(200);
    for (const table of ROW_TABLES) {
      const response = await asA('GET', `/api/bids/${a.bidId}/rows/${table}/${a.rows[table]}`);
      expect(response.statusCode, table).toBe(200);
    }
    const list = await asA('GET', '/api/bids');
    expect(list.json<{ id: string }[]>().map((bid) => bid.id)).toEqual([a.bidId]);
  });

  it('returns 404 for the other organization bid', async () => {
    expect((await asA('GET', `/api/bids/${b.bidId}`)).statusCode).toBe(404);
    expect((await asA('PATCH', `/api/bids/${b.bidId}`, { name: 'taken' })).statusCode).toBe(404);
    expect((await asA('DELETE', `/api/bids/${b.bidId}`)).statusCode).toBe(404);
    for (const tab of TABS) {
      expect((await asA('GET', `/api/bids/${b.bidId}/tabs/${tab}`)).statusCode, tab).toBe(404);
      expect((await asA('POST', `/api/bids/${b.bidId}/tabs/${tab}/seed`, {})).statusCode, tab).toBe(404);
    }
    expect((await asA('POST', `/api/bids/${b.bidId}/tabs/compliance/rows`, { requirementText: 'x' })).statusCode).toBe(404);
    expect((await asA('POST', `/api/bids/${b.bidId}/schedule/adjust`, { mode: 'keep' })).statusCode).toBe(404);
  });

  it('returns 404 for every row table, through the other bid or through its own bid', async () => {
    for (const table of ROW_TABLES) {
      const rowId = b.rows[table];
      for (const bidId of [b.bidId, a.bidId]) {
        const url = `/api/bids/${bidId}/rows/${table}/${rowId}`;
        expect((await asA('GET', url)).statusCode, `GET ${table} via ${bidId}`).toBe(404);
        expect((await asA('PATCH', url, { fields: { status: 'taken', value: 'taken', done: true } })).statusCode, `PATCH ${table}`).toBe(404);
        expect((await asA('DELETE', url)).statusCode, `DELETE ${table}`).toBe(404);
      }
    }
  });

  it('returns 404 for compliance merge and split with the other organization ids', async () => {
    const ids = [b.rows.compliance_rows, b.compliance2];
    expect((await asA('POST', `/api/bids/${b.bidId}/compliance/merge`, { ids })).statusCode).toBe(404);
    expect((await asA('POST', `/api/bids/${a.bidId}/compliance/merge`, { ids })).statusCode).toBe(404);
    expect((await asA('POST', `/api/bids/${b.bidId}/compliance/split`, { rowId: b.rows.compliance_rows, at: 5 })).statusCode).toBe(404);
    expect((await asA('POST', `/api/bids/${a.bidId}/compliance/split`, { rowId: b.rows.compliance_rows, at: 5 })).statusCode).toBe(404);
  });

  it('refuses rows in its own bid that point at the other organization rows', async () => {
    const match = await asA('POST', `/api/bids/${a.bidId}/tabs/resumes/rows`, {
      kind: 'match',
      candidateId: b.rows.candidates,
      requirementId: b.rows.personnel_requirements,
    });
    expect(match.statusCode).toBe(400);
    const finding = await asA('POST', `/api/bids/${a.bidId}/tabs/reviews/rows`, { kind: 'finding', reviewId: b.rows.reviews, text: 'x' });
    expect(finding.statusCode).toBe(400);
    const outline = await asA('POST', `/api/bids/${a.bidId}/tabs/outline/rows`, { title: 'x', parentId: b.rows.outline_items });
    expect(outline.statusCode).toBe(400);
  });

  it('returns 404 for the other organization documents', async () => {
    expect((await asA('GET', `/api/bids/${b.bidId}/documents`)).statusCode).toBe(404);
    expect((await asA('GET', `/api/documents/${b.documentId}/view-token`)).statusCode).toBe(404);
    expect((await asA('GET', `/api/documents/${b.documentId}/pages?from=1&to=1`)).statusCode).toBe(404);
    expect((await asA('GET', `/api/documents/${b.documentId}/file`)).statusCode).toBe(404);
    expect((await asA('POST', `/api/documents/${b.documentId}/restore`)).statusCode).toBe(404);
    expect((await asA('POST', `/api/documents/${b.documentId}/confirm-marking`)).statusCode).toBe(404);
    expect((await asA('POST', `/api/documents/${b.documentId}/key-override`, { reason: 'x' })).statusCode).toBe(404);
    expect((await asA('DELETE', `/api/documents/${b.documentId}`)).statusCode).toBe(404);
  });

  it('returns 404 for the other organization jobs', async () => {
    expect((await asA('GET', `/api/bids/${b.bidId}/jobs`)).statusCode).toBe(404);
    expect((await asA('POST', `/api/jobs/${b.jobId}/retry`)).statusCode).toBe(404);
  });

  it('returns 404 for the other organization amendment links', async () => {
    expect((await asA('GET', `/api/bids/${b.bidId}/amendment-links`)).statusCode).toBe(404);
    expect((await asA('POST', `/api/amendment-links/${b.amendmentLinkId}/confirm`)).statusCode).toBe(404);
    expect((await asA('POST', `/api/amendment-links/${b.amendmentLinkId}/reject`)).statusCode).toBe(404);
  });

  it('returns 404 for the other organization uploads', async () => {
    expect((await asA('POST', `/api/bids/${b.bidId}/uploads`, {
      fileName: 'x.pdf', kind: 'attachment', declaredSize: 1, sha256: 'a'.repeat(64), chunkCount: 1,
    })).statusCode).toBe(404);
    expect((await asA('DELETE', `/api/uploads/${b.uploadSessionId}`)).statusCode).toBe(404);
    const chunk = await app.inject({
      method: 'PUT',
      url: `/api/uploads/${b.uploadSessionId}/chunks/0`,
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('abc'),
    });
    expect(chunk.statusCode).toBe(404);
    expect((await asA('POST', `/api/uploads/${b.uploadSessionId}/complete`)).statusCode).toBe(404);
  });

  it('returns 404 when removing the other organization members', async () => {
    expect((await asA('DELETE', `/api/org/members/${b.userId}`)).statusCode).toBe(404);
    expect((await asA('DELETE', `/api/org/members/${b.memberUserId}`)).statusCode).toBe(404);
    const members = await asA('GET', '/api/org/members');
    expect(members.json<{ orgId: string }[]>().every((member) => member.orgId === a.orgId)).toBe(true);
  });

  it('returns 404 for a row of another bid in the same organization', async () => {
    const created = await asA('POST', '/api/bids', { name: 'Bid a2', bidType: 'sled' });
    expect(created.statusCode).toBe(201);
    const bidA2 = created.json<{ id: string }>().id;
    const a2 = await withOrg(a.orgId, (db) => seedBidRows(db, a.orgId, bidA2, 'a2'));
    for (const table of ROW_TABLES) {
      const url = `/api/bids/${a.bidId}/rows/${table}/${a2.rows[table]}`;
      expect((await asA('GET', url)).statusCode, `GET ${table}`).toBe(404);
      expect((await asA('PATCH', url, { fields: { status: 'moved', value: 'moved', done: true } })).statusCode, `PATCH ${table}`).toBe(404);
      expect((await asA('DELETE', url)).statusCode, `DELETE ${table}`).toBe(404);
      expect((await asA('GET', `/api/bids/${bidA2}/rows/${table}/${a2.rows[table]}`)).statusCode, `control ${table}`).toBe(200);
    }
    const ids = [a2.rows.compliance_rows, a2.compliance2];
    expect((await asA('POST', `/api/bids/${a.bidId}/compliance/merge`, { ids })).statusCode).toBe(404);
    expect((await asA('POST', `/api/bids/${a.bidId}/compliance/merge`, { ids: [a.rows.compliance_rows, a2.compliance2] })).statusCode).toBe(404);
    expect((await asA('POST', `/api/bids/${a.bidId}/compliance/split`, { rowId: a2.rows.compliance_rows, at: 5 })).statusCode).toBe(404);
    const rows = await withOrg(a.orgId, (db) => db.select().from(schema.complianceRows).where(eq(schema.complianceRows.bidId, bidA2)));
    expect(rows.map((row) => row.requirementText).sort()).toEqual(['The offeror shall a2.', 'The offeror shall also a2.']);
  });

  it('keeps the one-organization rule whatever X-Org-Id says', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/org',
      headers: { authorization: `Bearer ${a.token}`, 'x-org-id': b.orgId },
      payload: { name: 'Second org' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('does not let a user pick an organization they do not belong to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/bids/${b.bidId}`,
      headers: { authorization: `Bearer ${a.token}`, 'x-org-id': b.orgId },
    });
    expect(response.statusCode).toBe(403);
  });

  it('left every one of the other organization records unchanged', async () => {
    await withOrg(b.orgId, async (db) => {
      const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, b.bidId));
      expect(bid.name).toBe('Bid b');
      expect(bid.keyOverridesUsed).toBe(0);
      const [row] = await db.select().from(schema.complianceRows).where(eq(schema.complianceRows.id, b.rows.compliance_rows));
      expect(row.requirementText).toBe('The offeror shall b.');
      expect(row.supersedeStatus).toBeNull();
      expect(await db.select().from(schema.complianceRows).where(eq(schema.complianceRows.bidId, b.bidId))).toHaveLength(2);
      const [link] = await db.select().from(schema.amendmentLinks).where(eq(schema.amendmentLinks.id, b.amendmentLinkId));
      expect(link.status).toBe('proposed');
      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, b.documentId));
      expect(document.markingStatus).toBe('blocked');
      expect(document.liveStatus).toBe('archived');
      expect(await db.select().from(schema.jobs).where(eq(schema.jobs.bidId, b.bidId))).toHaveLength(1);
      const members = await db.select().from(schema.memberships).where(eq(schema.memberships.orgId, b.orgId));
      expect(members.map((member) => member.userId).sort()).toEqual([b.userId, b.memberUserId].sort());
      const [upload] = await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, b.uploadSessionId));
      expect(upload.status).toBe('open');
      expect(upload.chunksReceived).toBe(0);
      expect(await db.select().from(schema.rowHistory).where(and(
        eq(schema.rowHistory.rowId, b.rows.compliance_rows),
        eq(schema.rowHistory.orgId, b.orgId),
      ))).toHaveLength(1);
    });
    for (const table of ROW_TABLES) {
      const response = await asB('GET', `/api/bids/${b.bidId}/rows/${table}/${b.rows[table]}`);
      expect(response.statusCode, table).toBe(200);
    }
  });

  it('answers 404, not 500, for malformed ids', async () => {
    expect((await asA('GET', '/api/bids/not-a-uuid')).statusCode).toBe(404);
    expect((await asA('GET', `/api/bids/${a.bidId}/rows/lessons/not-a-uuid`)).statusCode).toBe(404);
    expect((await asA('POST', '/api/jobs/not-a-uuid/retry')).statusCode).toBe(404);
    expect((await asA('DELETE', '/api/org/members/not-a-uuid')).statusCode).toBe(404);
  });
});

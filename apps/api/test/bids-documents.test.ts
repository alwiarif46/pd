import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { as, createTenant, createUser, seedBidRows, type Tenant } from './helpers.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const unavailable = inject('dbUnavailable');

describe.skipIf(Boolean(unavailable))('bids and documents', () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pd-api-bids-'));
    process.env.DATA_DIR = dataDir;
    getPool({ connectionString: inject('appUrl'), max: 6 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  const bidRow = (orgId: string, bidId: string) => withOrg(orgId, async (db) => {
    const [row] = await db.select().from(schema.bids).where(eq(schema.bids.id, bidId));
    return row;
  });

  async function setPlan(orgId: string, plan: 'free' | 'starter') {
    await withOrg(orgId, (db) => db.update(schema.organizations).set({ plan }).where(eq(schema.organizations.id, orgId)));
  }

  async function memberToken(tenant: Tenant): Promise<string> {
    const member = await createUser('member-session');
    await withOrg(tenant.orgId, (db) => db.insert(schema.memberships).values({ orgId: tenant.orgId, userId: member.userId, role: 'member' }));
    return member.token;
  }

  async function holdCredit(orgId: string, bidId: string, status: 'reserved' | 'consumed') {
    return withOrg(orgId, async (db) => {
      const [credit] = await db.insert(schema.rfpCredits).values({
        orgId,
        periodStart: new Date(Date.now() - 1000),
        periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        allowed: 5,
        used: status === 'consumed' ? 1 : 0,
        reserved: status === 'reserved' ? 1 : 0,
      }).returning();
      await db.update(schema.bids).set({ creditId: credit.id, creditStatus: status }).where(eq(schema.bids.id, bidId));
      return credit.id;
    });
  }

  describe('PATCH /api/bids/:id', () => {
    it('changing the solicitation number updates the normalized key', async () => {
      const tenant = await createTenant(app, 'key-update');
      const call = as(app, tenant.token);
      expect((await bidRow(tenant.orgId, tenant.bidId)).solicitationKey).toBe('SOLKEYUPDATE');
      const response = await call('PATCH', `/api/bids/${tenant.bidId}`, { solicitationNumber: 'w912-26-r-0001' });
      expect(response.statusCode).toBe(200);
      const bid = await bidRow(tenant.orgId, tenant.bidId);
      expect(bid.solicitationNumber).toBe('w912-26-r-0001');
      expect(bid.solicitationKey).toBe('W91226R0001');
    });

    it('a bid holding a credit can fix the number format but not switch solicitations', async () => {
      const tenant = await createTenant(app, 'key-lock');
      const call = as(app, tenant.token);
      await holdCredit(tenant.orgId, tenant.bidId, 'consumed');
      const switched = await call('PATCH', `/api/bids/${tenant.bidId}`, { solicitationNumber: 'OTHER-1' });
      expect(switched.statusCode).toBe(409);
      expect(switched.json<{ code: string }>().code).toBe('key_locked');
      const reformatted = await call('PATCH', `/api/bids/${tenant.bidId}`, { solicitationNumber: 'sol key lock' });
      expect(reformatted.statusCode).toBe(200);
      expect((await bidRow(tenant.orgId, tenant.bidId)).solicitationKey).toBe('SOLKEYLOCK');
    });

    it('compares against a legacy raw key in normalized form', async () => {
      const tenant = await createTenant(app, 'legacy-key');
      await holdCredit(tenant.orgId, tenant.bidId, 'consumed');
      await withOrg(tenant.orgId, (db) => db.update(schema.bids).set({ solicitationKey: 'rfp-2026/7' }).where(eq(schema.bids.id, tenant.bidId)));
      const call = as(app, tenant.token);
      expect((await call('PATCH', `/api/bids/${tenant.bidId}`, { solicitationNumber: 'RFP 2026 7' })).statusCode).toBe(200);
      expect((await bidRow(tenant.orgId, tenant.bidId)).solicitationKey).toBe('RFP20267');
      expect((await call('PATCH', `/api/bids/${tenant.bidId}`, { solicitationNumber: 'RFP 2026 8' })).statusCode).toBe(409);
    });

    it('a key change and a solicitation upload on a pending bid never both win', async () => {
      const tenant = await createTenant(app, 'key-race');
      const call = as(app, tenant.token);
      await setPlan(tenant.orgId, 'starter');
      for (let round = 0; round < 5; round += 1) {
        const bid = (await call('POST', '/api/bids', { name: `Race ${round}`, bidType: 'sled' })).json<{ id: string }>().id;
        const [patched, uploaded] = await Promise.all([
          call('PATCH', `/api/bids/${bid}`, { solicitationNumber: `PATCH-${round}` }),
          call('POST', `/api/bids/${bid}/uploads`, {
            fileName: 'rfp.pdf', kind: 'solicitation', declaredSize: 10, sha256: createHash('sha256').update(`r${round}`).digest('hex'),
            chunkCount: 1, solicitationNumber: `UPLOAD-${round}`,
          }),
        ]);
        const row = await bidRow(tenant.orgId, bid);
        if (uploaded.statusCode === 201) {
          // The upload ran first and fixed the key; the PATCH then saw a reserved credit.
          expect(patched.statusCode, patched.body).toBe(409);
          expect(row.solicitationKey).toBe(`UPLOAD${round}`);
          expect(row.creditStatus).toBe('reserved');
        } else {
          expect(patched.statusCode).toBe(200);
          expect(uploaded.statusCode).toBe(409);
          expect(row.solicitationKey).toBe(`PATCH${round}`);
          expect(row.creditStatus).toBeNull();
        }
      }
    });

    it('refuses a retention date in the past', async () => {
      const tenant = await createTenant(app, 'retention-past');
      await setPlan(tenant.orgId, 'starter');
      const response = await as(app, tenant.token)('PATCH', `/api/bids/${tenant.bidId}`, { retentionExtendedUntil: '2020-01-01T00:00:00.000Z' });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('invalid_date');
    });

    it('only the owner, on a paid plan, can extend retention, and it is audited', async () => {
      const tenant = await createTenant(app, 'retention');
      const until = '2027-06-30T00:00:00.000Z';
      const member = as(app, await memberToken(tenant));
      const byMember = await member('PATCH', `/api/bids/${tenant.bidId}`, { retentionExtendedUntil: until });
      expect(byMember.statusCode).toBe(403);
      expect(byMember.json<{ code: string }>().code).toBe('owner_only');
      // A member can still edit other fields.
      expect((await member('PATCH', `/api/bids/${tenant.bidId}`, { agency: 'GSA' })).statusCode).toBe(200);

      const owner = as(app, tenant.token);
      const onFree = await owner('PATCH', `/api/bids/${tenant.bidId}`, { retentionExtendedUntil: until });
      expect(onFree.statusCode).toBe(402);
      expect(onFree.json<{ code: string }>().code).toBe('plan_required');
      await setPlan(tenant.orgId, 'starter');
      const invalid = await owner('PATCH', `/api/bids/${tenant.bidId}`, { retentionExtendedUntil: 'not a date' });
      expect(invalid.statusCode).toBe(400);
      expect((await owner('PATCH', `/api/bids/${tenant.bidId}`, { retentionExtendedUntil: until })).statusCode).toBe(200);
      expect((await bidRow(tenant.orgId, tenant.bidId)).retentionExtendedUntil?.toISOString()).toBe(until);
      const audits = await withOrg(tenant.orgId, (db) => db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.action, 'extend_retention'),
        eq(schema.auditLog.targetId, tenant.bidId),
      )));
      expect(audits).toHaveLength(1);
      expect((await bidRow(tenant.orgId, tenant.bidId)).agency).toBe('GSA');
    });
  });

  describe('POST /api/documents/:id/key-override', () => {
    // A held amendment (key not found) or a matched one, on a bid whose solicitation holds a credit.
    async function amendment(tenant: Tenant, keyFound: boolean) {
      const [bid] = await withOrg(tenant.orgId, (db) => db.select().from(schema.bids).where(eq(schema.bids.id, tenant.bidId)));
      if (!bid.creditStatus) {
        await holdCredit(tenant.orgId, tenant.bidId, 'consumed');
      }
      return withOrg(tenant.orgId, async (db) => {
        const [document] = await db.insert(schema.documents).values({
          orgId: tenant.orgId, bidId: tenant.bidId, fileName: 'addendum.pdf', mime: 'application/pdf', sizeBytes: 5,
          sha256: randomUUID(), kind: 'amendment', liveStatus: 'live', keyStatus: keyFound ? 'match' : 'not_found',
        }).returning();
        const [row] = await db.insert(schema.amendments).values({
          orgId: tenant.orgId, bidId: tenant.bidId, documentId: document.id, amendmentNo: 2,
          solicitationKeyFound: keyFound, status: keyFound ? 'processing' : 'held',
        }).returning();
        return { documentId: document.id, amendmentId: row.id };
      });
    }

    it('accepts the amendment, records the reason, and spends one override once', async () => {
      const tenant = await createTenant(app, 'override');
      const call = as(app, tenant.token);
      const { documentId, amendmentId } = await amendment(tenant, false);
      const response = await call('POST', `/api/documents/${documentId}/key-override`, { reason: 'SLED addendum omits the number' });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ remaining: number }>().remaining).toBe(1);
      const [row] = await withOrg(tenant.orgId, (db) => db.select().from(schema.amendments).where(eq(schema.amendments.id, amendmentId)));
      expect(row.keyOverride).toBe(true);
      expect(row.overrideReason).toBe('SLED addendum omits the number');
      const again = await call('POST', `/api/documents/${documentId}/key-override`, { reason: 'again' });
      expect(again.statusCode).toBe(409);
      expect(again.json<{ code: string }>().code).toBe('override_not_needed');
      expect((await bidRow(tenant.orgId, tenant.bidId)).keyOverridesUsed).toBe(1);
    });

    it('refuses a matched amendment, a non-amendment, and a member', async () => {
      const tenant = await createTenant(app, 'override-no');
      const call = as(app, tenant.token);
      const matched = await amendment(tenant, true);
      const response = await call('POST', `/api/documents/${matched.documentId}/key-override`, { reason: 'x' });
      expect(response.json<{ code: string }>().code).toBe('override_not_needed');
      const solicitation = await call('POST', `/api/documents/${tenant.documentId}/key-override`, { reason: 'x' });
      expect(solicitation.json<{ code: string }>().code).toBe('not_an_amendment');
      const pending = await amendment(tenant, false);
      const member = as(app, await memberToken(tenant));
      expect((await member('POST', `/api/documents/${pending.documentId}/key-override`, { reason: 'x' })).statusCode).toBe(403);
      expect((await bidRow(tenant.orgId, tenant.bidId)).keyOverridesUsed).toBe(0);
    });

    it('concurrent overrides never pass the per-bid limit', async () => {
      const tenant = await createTenant(app, 'override-race');
      const call = as(app, tenant.token);
      const targets = [await amendment(tenant, false), await amendment(tenant, false), await amendment(tenant, false)];
      const results = await Promise.all([
        ...targets.map((target) => call('POST', `/api/documents/${target.documentId}/key-override`, { reason: 'race' })),
        call('POST', `/api/documents/${targets[0].documentId}/key-override`, { reason: 'race' }),
      ]);
      expect(results.filter((result) => result.statusCode === 200)).toHaveLength(2);
      expect((await bidRow(tenant.orgId, tenant.bidId)).keyOverridesUsed).toBe(2);
      const accepted = await withOrg(tenant.orgId, (db) => db.select().from(schema.amendments).where(and(
        inArray(schema.amendments.id, targets.map((target) => target.amendmentId)),
        eq(schema.amendments.keyOverride, true),
      )));
      expect(accepted).toHaveLength(2);
    });
  });

  describe('DELETE /api/bids/:id', () => {
    it('deletes a bid with rows in every child table, its row history, and its files, and releases a reserved credit', async () => {
      const tenant = await createTenant(app, 'del-bid');
      const creditId = await holdCredit(tenant.orgId, tenant.bidId, 'reserved');
      const docsDir = join(dataDir, tenant.orgId, 'docs');
      await mkdir(docsDir, { recursive: true });
      await writeFile(join(docsDir, 'rfp.pdf'), 'x');
      const exportsDir = join(dataDir, tenant.orgId, 'exports');
      await mkdir(exportsDir, { recursive: true });
      await writeFile(join(exportsDir, 'x.xlsx'), 'x');
      await withOrg(tenant.orgId, async (db) => {
        await db.update(schema.documents).set({ storagePath: 'docs/rfp.pdf' }).where(eq(schema.documents.id, tenant.documentId));
        await db.insert(schema.archiveObjects).values({ orgId: tenant.orgId, documentId: tenant.documentId, objectType: 'original', archiveKey: 'k', archivedAt: new Date() });
        await db.insert(schema.exports).values({ orgId: tenant.orgId, bidId: tenant.bidId, tab: 'compliance', format: 'xlsx', storagePath: 'exports/x.xlsx', createdBy: tenant.userId, expiresAt: new Date(Date.now() + 60_000) });
        await db.insert(schema.aiRuns).values({ orgId: tenant.orgId, bidId: tenant.bidId, task: 'compliance', provider: 'p', model: 'm', status: 'completed' });
        await db.insert(schema.outlineItems).values({ orgId: tenant.orgId, bidId: tenant.bidId, title: 'Child', parentId: tenant.rows.outline_items });
        await db.update(schema.complianceRows).set({ documentId: tenant.documentId }).where(eq(schema.complianceRows.id, tenant.rows.compliance_rows));
        for (const [table, rowId] of Object.entries(tenant.rows)) {
          await db.insert(schema.rowHistory).values({ orgId: tenant.orgId, rowTable: table, rowId, field: 'x', changedAt: new Date() });
        }
      });
      const response = await as(app, tenant.token)('DELETE', `/api/bids/${tenant.bidId}`);
      expect(response.statusCode).toBe(200);
      await withOrg(tenant.orgId, async (db) => {
        expect(await db.select().from(schema.bids).where(eq(schema.bids.id, tenant.bidId))).toHaveLength(0);
        expect(await db.select().from(schema.documents).where(eq(schema.documents.bidId, tenant.bidId))).toHaveLength(0);
        expect(await db.select().from(schema.pages).where(eq(schema.pages.documentId, tenant.documentId))).toHaveLength(0);
        expect(await db.select().from(schema.amendmentLinks).where(eq(schema.amendmentLinks.id, tenant.amendmentLinkId))).toHaveLength(0);
        expect(await db.select().from(schema.resumeMatches).where(eq(schema.resumeMatches.id, tenant.rows.resume_matches))).toHaveLength(0);
        expect(await db.select().from(schema.reviewFindings).where(eq(schema.reviewFindings.id, tenant.rows.review_findings))).toHaveLength(0);
        expect(await db.select().from(schema.rowHistory).where(inArray(schema.rowHistory.rowId, Object.values(tenant.rows)))).toHaveLength(0);
        // The pre-existing history row on the compliance row (from createTenant) is gone too.
        expect(await db.select().from(schema.rowHistory).where(eq(schema.rowHistory.id, tenant.rowHistoryId))).toHaveLength(0);
        const runs = await db.select().from(schema.aiRuns).where(eq(schema.aiRuns.orgId, tenant.orgId));
        expect(runs.every((run) => run.bidId === null)).toBe(true);
        const [credit] = await db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.id, creditId));
        expect(credit.reserved).toBe(0);
        expect(credit.used).toBe(0);
      });
      expect(await readdir(docsDir)).toEqual([]);
      expect(await readdir(exportsDir)).toEqual([]);
      // The archive row outlives the bid so the purge job can delete the off-server copy.
      const archived = await withOrg(tenant.orgId, (db) => db.select().from(schema.archiveObjects).where(eq(schema.archiveObjects.archiveKey, 'k')));
      expect(archived).toHaveLength(1);
      expect(archived[0].documentId).toBeNull();
      expect(archived[0].expiresAt).not.toBeNull();
    });

    it('does not return a consumed credit', async () => {
      const tenant = await createTenant(app, 'del-consumed');
      const creditId = await holdCredit(tenant.orgId, tenant.bidId, 'consumed');
      expect((await as(app, tenant.token)('DELETE', `/api/bids/${tenant.bidId}`)).statusCode).toBe(200);
      const [credit] = await withOrg(tenant.orgId, (db) => db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.id, creditId)));
      expect(credit.used).toBe(1);
      expect(credit.reserved).toBe(0);
    });
  });

  describe('DELETE /api/documents/:id', () => {
    it('removes the file and frees its MB, but keeps the page text and the rows it produced', async () => {
      const tenant = await createTenant(app, 'del-doc');
      const call = as(app, tenant.token);
      const bytes = 45 * 1024 * 1024;
      const sha = createHash('sha256').update('big').digest('hex');
      const docsDir = join(dataDir, tenant.orgId, 'docs');
      await mkdir(docsDir, { recursive: true });
      await writeFile(join(docsDir, 'big.pdf'), 'x');
      const documentId = await withOrg(tenant.orgId, async (db) => {
        const [document] = await db.insert(schema.documents).values({
          orgId: tenant.orgId, bidId: tenant.bidId, fileName: 'big.pdf', mime: 'application/pdf', sizeBytes: bytes,
          sha256: sha, kind: 'attachment', storagePath: 'docs/big.pdf', liveStatus: 'live',
        }).returning();
        await db.insert(schema.pages).values({ orgId: tenant.orgId, documentId: document.id, pageNo: 1, text: 'shall' });
        await db.insert(schema.jobs).values({ orgId: tenant.orgId, bidId: tenant.bidId, documentId: document.id, type: 'scan', status: 'completed' });
        await db.insert(schema.amendments).values({ orgId: tenant.orgId, bidId: tenant.bidId, documentId: document.id, amendmentNo: 3, solicitationKeyFound: true, status: 'applied' });
        await db.update(schema.complianceRows).set({ documentId: document.id, sourcePage: 1, sourceQuote: 'shall' }).where(eq(schema.complianceRows.id, tenant.rows.compliance_rows));
        return document.id;
      });
      const upload = (sha256: string) => call('POST', `/api/bids/${tenant.bidId}/uploads`, {
        fileName: 'next.pdf', kind: 'attachment', declaredSize: bytes, sha256, chunkCount: 3,
      });
      expect((await upload('e'.repeat(64))).statusCode).toBe(413);

      expect((await call('DELETE', `/api/documents/${documentId}`)).statusCode).toBe(200);
      expect((await call('DELETE', `/api/documents/${documentId}`)).statusCode).toBe(200);
      await withOrg(tenant.orgId, async (db) => {
        const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
        expect(document.liveStatus).toBe('deleted');
        expect(document.storagePath).toBeNull();
        expect(await db.select().from(schema.pages).where(eq(schema.pages.documentId, documentId))).toHaveLength(1);
        const [row] = await db.select().from(schema.complianceRows).where(eq(schema.complianceRows.id, tenant.rows.compliance_rows));
        expect(row.documentId).toBe(documentId);
        expect(row.sourceQuote).toBe('shall');
        const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'delete_document'), eq(schema.auditLog.targetId, documentId)));
        expect(audits).toHaveLength(1);
      });
      expect(await readdir(docsDir)).not.toContain('big.pdf');
      expect((await call('GET', `/api/documents/${documentId}/file`)).statusCode).toBe(410);
      expect((await call('GET', `/api/documents/${documentId}/pages?from=1&to=1`)).statusCode).toBe(200);
      // The MB is free again, and the same file is not a duplicate any more.
      expect((await upload('e'.repeat(64))).statusCode).toBe(201);
      const again = await upload(sha);
      expect(again.statusCode).toBe(413);
      expect(again.json<{ duplicate?: boolean }>().duplicate).toBeUndefined();
    });
  });

  describe('DELETE /api/documents/:id on a solicitation', () => {
    async function solicitation(tenant: Tenant): Promise<string> {
      return withOrg(tenant.orgId, async (db) => {
        const [row] = await db.insert(schema.documents).values({
          orgId: tenant.orgId, bidId: tenant.bidId, fileName: 's.pdf', mime: 'application/pdf', sizeBytes: 5,
          sha256: randomUUID(), kind: 'solicitation', liveStatus: 'live',
        }).returning();
        return row.id;
      });
    }
    const creditRow = (orgId: string, creditId: string) => withOrg(orgId, async (db) => {
      const [row] = await db.select().from(schema.rfpCredits).where(eq(schema.rfpCredits.id, creditId));
      return row;
    });

    it('releases the reserved credit when the last solicitation goes before its matrix settled', async () => {
      const tenant = await createTenant(app, 'del-sol');
      // createTenant's own solicitation is the other one; delete it first.
      const call = as(app, tenant.token);
      const creditId = await holdCredit(tenant.orgId, tenant.bidId, 'reserved');
      const extra = await solicitation(tenant);
      const first = await call('DELETE', `/api/documents/${tenant.documentId}`);
      expect(first.json<{ creditReleased: boolean }>().creditReleased).toBe(false);
      expect((await creditRow(tenant.orgId, creditId)).reserved).toBe(1);
      const last = await call('DELETE', `/api/documents/${extra}`);
      expect(last.json<{ creditReleased: boolean }>().creditReleased).toBe(true);
      expect((await creditRow(tenant.orgId, creditId)).reserved).toBe(0);
      expect((await bidRow(tenant.orgId, tenant.bidId)).creditStatus).toBe('released');
    });

    it('does not return a consumed credit', async () => {
      const tenant = await createTenant(app, 'del-sol-used');
      const creditId = await holdCredit(tenant.orgId, tenant.bidId, 'consumed');
      const response = await as(app, tenant.token)('DELETE', `/api/documents/${tenant.documentId}`);
      expect(response.json<{ creditReleased: boolean }>().creditReleased).toBe(false);
      const credit = await creditRow(tenant.orgId, creditId);
      expect(credit.used).toBe(1);
      expect((await bidRow(tenant.orgId, tenant.bidId)).creditStatus).toBe('consumed');
    });
  });

  describe('row deletes with child rows', () => {
    it('deleting a candidate, a requirement, a review, or a parent outline item does not fail on children', async () => {
      const tenant = await createTenant(app, 'row-del');
      const call = as(app, tenant.token);
      const extra = await withOrg(tenant.orgId, (db) => seedBidRows(db, tenant.orgId, tenant.bidId, 'extra'));
      const child = await withOrg(tenant.orgId, async (db) => {
        const [row] = await db.insert(schema.outlineItems).values({ orgId: tenant.orgId, bidId: tenant.bidId, title: 'Child', parentId: tenant.rows.outline_items }).returning();
        return row.id;
      });
      for (const [table, rowId] of [
        ['candidates', tenant.rows.candidates],
        ['personnel_requirements', extra.rows.personnel_requirements],
        ['reviews', tenant.rows.reviews],
        ['outline_items', tenant.rows.outline_items],
      ] as const) {
        const response = await call('DELETE', `/api/bids/${tenant.bidId}/rows/${table}/${rowId}`);
        expect(response.statusCode, `${table}: ${response.body}`).toBe(200);
      }
      await withOrg(tenant.orgId, async (db) => {
        expect(await db.select().from(schema.resumeMatches).where(inArray(schema.resumeMatches.id, [tenant.rows.resume_matches, extra.rows.resume_matches]))).toHaveLength(0);
        expect(await db.select().from(schema.reviewFindings).where(eq(schema.reviewFindings.id, tenant.rows.review_findings))).toHaveLength(0);
        const [promoted] = await db.select().from(schema.outlineItems).where(eq(schema.outlineItems.id, child));
        expect(promoted.parentId).toBeNull();
      });
    });
  });
});

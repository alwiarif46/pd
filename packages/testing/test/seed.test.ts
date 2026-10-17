import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getPool, normalizeSolicitationKey, schema, withOrg } from '@pd/core';
import { assertRlsIsolation, RlsLeakError } from '../src/cross-tenant';
import { TENANT_A, TENANT_B } from '../src/fixtures';
import { listSampleRfpFiles, sampleDocumentId } from '../src/sample-rfp';
import { seedAll } from '../src/seed';
import { runSeedCli } from '../src/seed-cli';
import { APP_ROLE_SKIP, BASE_URL, SKIP_DB, urlFor, useSeededDatabase } from './db-helper';

describe('tenant fixture keys', () => {
  it('match what PD computes from the solicitation number', () => {
    for (const t of [TENANT_A, TENANT_B]) {
      expect(t.bid.solicitationKey).toBe(normalizeSolicitationKey(t.bid.solicitationNumber));
    }
  });
});

describe.skipIf(SKIP_DB)('pnpm seed against a scratch database', () => {
  const db = useSeededDatabase();

  async function digest(): Promise<Record<string, string>> {
    const admin = new pg.Client({ connectionString: db().adminUrl });
    await admin.connect();
    try {
      const out: Record<string, string> = {};
      for (const t of ['users', 'organizations', 'memberships', 'bids', 'documents']) {
        const r = await admin.query(`select count(*)::int as n, md5(coalesce(string_agg(x::text, ',' order by id), '')) as h from ${t} x`);
        out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
      }
      return out;
    } finally {
      await admin.end();
    }
  }

  afterAll(async () => {
    await closeDb();
  });

  it('creates both tenants on the first run and says so', () => {
    const r = db().firstRun;
    expect(r.migrated).toBe(true);
    const files = listSampleRfpFiles().length;
    // Per tenant: user, organization, membership, bid. Plus A's documents.
    expect(r.totals).toEqual({ created: 8 + files, updated: 0, unchanged: 0 });
    expect(r.lines.some((l) => l.includes('Tenant A') && l.includes('77344426Q0100'))).toBe(true);
  });

  it('changes nothing on the second run', async () => {
    const before = await digest();
    const second = await seedAll(db().adminUrl);
    expect(second.migrated).toBe(false);
    expect(second.totals).toEqual({ created: 0, updated: 0, unchanged: 8 + listSampleRfpFiles().length });
    expect(await digest()).toEqual(before);
  });

  it('repairs a row that drifted', async () => {
    const before = await digest();
    const admin = new pg.Client({ connectionString: db().adminUrl });
    await admin.connect();
    await admin.query("update organizations set name = 'renamed' where id = $1", [TENANT_B.id]);
    await admin.end();
    expect(await digest()).not.toEqual(before);
    const r = await seedAll(db().adminUrl);
    expect(r.totals.updated).toBe(1);
    expect(r.totals.created).toBe(0);
    // The name is back and the data is byte for byte what the first run wrote.
    const check = new pg.Client({ connectionString: db().adminUrl });
    await check.connect();
    try {
      expect((await check.query('select name from organizations where id = $1', [TENANT_B.id])).rows[0].name).toBe('Tenant B');
    } finally {
      await check.end();
    }
    expect(await digest()).toEqual(before);
  });

  it('migrates again, harmlessly, when --migrate is passed to a migrated database', async () => {
    const before = await digest();
    const r = await seedAll(db().adminUrl, undefined, { migrate: true });
    expect(r.migrated).toBe(true);
    expect(r.totals).toEqual({ created: 0, updated: 0, unchanged: 8 + listSampleRfpFiles().length });
    expect(await digest()).toEqual(before);
  });

  describe('on an empty database', () => {
    let empty = '';
    let emptyUrl = '';
    const base = () => new pg.Client({ connectionString: BASE_URL });
    beforeAll(async () => {
      empty = `test_pd_empty_${randomBytes(4).toString('hex')}`;
      const c = base();
      await c.connect();
      await c.query(`create database ${empty}`);
      await c.end();
      emptyUrl = urlFor(BASE_URL!, null, null, empty);
    });
    afterAll(async () => {
      const c = base();
      await c.connect();
      await c.query(`drop database if exists ${empty} with (force)`);
      await c.end();
    });

    it('does not migrate by itself: it fails and says to pass --migrate', async () => {
      await expect(seedAll(emptyUrl)).rejects.toThrow(/--migrate/);
      const c = new pg.Client({ connectionString: emptyUrl });
      await c.connect();
      try {
        expect((await c.query("select to_regclass('public.organizations') as t")).rows[0].t).toBeNull();
      } finally {
        await c.end();
      }
    });

    it('the CLI fails the same way without --migrate and seeds with it', async () => {
      const out: string[] = [];
      expect(await runSeedCli([], { PD_ADMIN_DATABASE_URL: emptyUrl }, (l) => out.push(l))).toBe(1);
      expect(out.join('\n')).toContain('--migrate');
      out.length = 0;
      expect(await runSeedCli(['--migrate'], { PD_ADMIN_DATABASE_URL: emptyUrl }, (l) => out.push(l))).toBe(0);
      expect(out.join('\n')).toContain(`seed done: ${8 + listSampleRfpFiles().length} created`);
    });
  });

  it('registers every sample file as tenant A document, unprocessed', async () => {
    const admin = new pg.Client({ connectionString: db().adminUrl });
    await admin.connect();
    try {
      const rows = (await admin.query(
        'select id, org_id, bid_id, file_name, kind, amendment_no, amendment_no_source, storage_path, extract_status, scan_status, live_status, size_bytes, sha256 from documents order by file_name',
      )).rows;
      const files = listSampleRfpFiles();
      expect(rows).toHaveLength(files.length);
      expect(rows.every((r) => r.org_id === TENANT_A.id && r.bid_id === TENANT_A.bid.id)).toBe(true);
      expect(rows.every((r) => r.storage_path === null && r.extract_status === null && r.scan_status === null && r.live_status === null)).toBe(true);
      const byName = new Map(rows.map((r) => [r.file_name as string, r]));
      for (const f of files) {
        const row = byName.get(f.fileName)!;
        expect(row.id).toBe(sampleDocumentId(TENANT_A.id, f.relPath));
        expect(row.kind).toBe(f.kind);
        expect(row.amendment_no).toBe(f.amendmentNo);
        expect(row.size_bytes).toBe(f.sizeBytes);
        expect(row.sha256).toBe(f.sha256);
      }
      const bids = (await admin.query('select org_id, solicitation_number, solicitation_key, bid_type, name from bids order by org_id')).rows;
      expect(bids.map((b) => b.solicitation_number)).toEqual(['77344426Q0100', 'TENANT-B-0001']);
      const users = (await admin.query('select email, password_hash, email_verified_at from users order by email')).rows;
      expect(users.map((u) => u.email)).toEqual(['admin-a@example.test', 'admin-b@example.test']);
      expect(users.every((u) => u.password_hash === 'x:y' && u.email_verified_at !== null)).toBe(true);
    } finally {
      await admin.end();
    }
  });

  describe('as the app role', () => {
    const appUrl = () => db().appUrl;

    it.skipIf(APP_ROLE_SKIP !== '')('tenant B sees none of tenant A through withOrg', async () => {
      await closeDb();
      getPool(appUrl()!);
      const seen = await withOrg(TENANT_B.id, async (tx) => ({
        orgs: await tx.select().from(schema.organizations),
        bids: await tx.select().from(schema.bids),
        docs: await tx.select().from(schema.documents),
        members: await tx.select().from(schema.memberships),
      }));
      expect(seen.orgs.map((o) => o.id)).toEqual([TENANT_B.id]);
      expect(seen.bids.map((b) => b.id)).toEqual([TENANT_B.bid.id]);
      expect(seen.docs).toHaveLength(0);
      expect(seen.members.map((m) => m.orgId)).toEqual([TENANT_B.id]);

      const asA = await withOrg(TENANT_A.id, (tx) => tx.select().from(schema.documents));
      expect(asA).toHaveLength(listSampleRfpFiles().length);
      await closeDb();
    });

    it.skipIf(APP_ROLE_SKIP !== '')('assertRlsIsolation passes for pd_app and fails for the owner', async () => {
      const idsA = listSampleRfpFiles().map((f) => sampleDocumentId(TENANT_A.id, f.relPath));
      const app = new pg.Pool({ connectionString: appUrl()! });
      const admin = new pg.Pool({ connectionString: db().adminUrl });
      try {
        const docs = await assertRlsIsolation({ pool: app, table: 'documents', tenantColumn: 'org_id', idsA, tenantA: TENANT_A.id, tenantB: TENANT_B.id });
        expect(docs).toMatchObject({ selectedAsB: 0, updatedAsB: 0, deletedAsB: 0, visibleToA: idsA.length });
        await assertRlsIsolation({ pool: app, table: 'bids', tenantColumn: 'org_id', idsA: [TENANT_A.bid.id], tenantA: TENANT_A.id, tenantB: TENANT_B.id });
        await assertRlsIsolation({ pool: app, table: 'memberships', tenantColumn: 'org_id', idsA: [TENANT_A.membershipId], tenantA: TENANT_A.id, tenantB: TENANT_B.id });
        await assertRlsIsolation({ pool: app, table: 'organizations', tenantColumn: 'id', idsA: [TENANT_A.id], tenantA: TENANT_A.id, tenantB: TENANT_B.id });
        // The superuser skips row-level security: the helper must notice, and must not change data.
        await expect(
          assertRlsIsolation({ pool: admin, table: 'documents', tenantColumn: 'org_id', idsA, tenantA: TENANT_A.id, tenantB: TENANT_B.id }),
        ).rejects.toBeInstanceOf(RlsLeakError);
        const left = await admin.query('select count(*)::int as n from documents');
        expect(left.rows[0].n).toBe(idsA.length);
        // Ids that do not exist prove nothing, so that is an error.
        await expect(
          assertRlsIsolation({ pool: app, table: 'bids', tenantColumn: 'org_id', idsA: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'], tenantA: TENANT_A.id, tenantB: TENANT_B.id }),
        ).rejects.toThrow(/prove nothing/);
      } finally {
        await app.end();
        await admin.end();
      }
    });
  });
});

/**
 * Row-level security checks straight against Postgres, connected as pd_app.
 * Plan 08, Phase 5: "a pool of size 1 serving two requests in a row from different
 * organizations never sees the other's rows".
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeDb, getDb, getPool, schema, userMemberships, withOrg } from '@pd/core';
import { createUser } from './helpers.js';

const unavailable = inject('dbUnavailable');

/** Every table with an org_id column (the tables marked T in plan 03). */
const TENANT_TABLES = [
  'memberships', 'invites', 'rfp_credits', 'audit_log',
  'bids', 'documents', 'upload_sessions', 'amendments', 'amendment_links', 'pages',
  'archive_objects', 'jobs', 'exports', 'ai_runs',
  'bid_facts', 'kickoff_items', 'schedule_activities', 'compliance_rows', 'outline_items',
  'personnel_requirements', 'candidates', 'resume_matches', 'reviews', 'review_assignments',
  'review_findings', 'production_items', 'orals_items', 'lessons', 'row_history',
];

describe.skipIf(Boolean(unavailable))('row-level security catalog', () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
  });

  afterAll(async () => {
    await admin?.end();
  });

  it('gives every table with row-level security at least one policy', async () => {
    const result = await admin.query<{ table: string }>(`
      select c.relname as table
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and c.relrowsecurity
        and not exists (select 1 from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname)
    `);
    expect(result.rows.map((row) => row.table)).toEqual([]);
  });

  it('enables and forces row-level security on every table with org_id, with a pd_app policy', async () => {
    const result = await admin.query<{ table: string; enabled: boolean; forced: boolean; app_policy: boolean }>(`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        exists (
          select 1 from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname
            and p.cmd = 'ALL' and 'pd_app' = any (p.roles)
        ) as app_policy
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `);
    expect(result.rows.map((row) => row.table).sort()).toEqual([...TENANT_TABLES].sort());
    for (const row of result.rows) {
      expect(row, row.table).toMatchObject({ enabled: true, forced: true, app_policy: true });
    }
  });

  it('protects organizations by its own id', async () => {
    const result = await admin.query(`
      select c.relrowsecurity as enabled, c.relforcerowsecurity as forced, p.qual, p.with_check
      from pg_class c
      join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
      where c.relname = 'organizations' and c.relnamespace = 'public'::regnamespace
        and p.cmd = 'ALL' and 'pd_app' = any (p.roles)
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ enabled: true, forced: true });
    expect(result.rows[0].qual).toMatch(/^\(id = \(NULLIF\(current_setting\('app\.org_id'/);
    expect(result.rows[0].with_check).toMatch(/^\(id = \(NULLIF\(current_setting\('app\.org_id'/);
  });

  it('was migrated by a database owner that is not a superuser', async () => {
    const result = await admin.query(`
      select r.rolsuper, r.rolcreaterole,
        (select p.proowner::regrole::text from pg_proc p where p.oid = 'pd_system.user_memberships(uuid)'::regprocedure) as function_owner
      from pg_database d join pg_roles r on r.oid = d.datdba
      where d.datname = current_database()
    `);
    // global-setup migrates as a CREATEROLE owner unless pd_app already existed on the cluster.
    if (!process.env.TEST_PD_APP_PASSWORD) {
      expect(result.rows[0]).toMatchObject({ rolsuper: false, rolcreaterole: true });
    }
    expect(result.rows[0].function_owner).toBe('pd_system');
  });

  it('leaves no policy from the old rls.sql', async () => {
    const result = await admin.query("select policyname from pg_policies where policyname like 'tenant\\_%' and policyname <> 'tenant_isolation'");
    expect(result.rows).toEqual([]);
  });

  it('keeps pd_app subject to row-level security and unable to act as pd_system', async () => {
    const result = await admin.query(`
      select rolsuper, rolbypassrls, pg_has_role('pd_app', 'pd_system', 'MEMBER') as in_system
      from pg_roles where rolname = 'pd_app'
    `);
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, in_system: false });
  });
});

describe.skipIf(Boolean(unavailable))('row-level security as pd_app', () => {
  const orgA = randomUUID();
  const orgB = randomUUID();
  let userA: string;
  let bidA: string;
  let bidB: string;

  beforeAll(async () => {
    getPool({ connectionString: inject('appUrl'), max: 1 });
    userA = (await createUser('rls-a')).userId;
    for (const orgId of [orgA, orgB]) {
      await withOrg(orgId, async (db) => {
        await db.insert(schema.organizations).values({ id: orgId, name: orgId, plan: 'free', planStatus: 'active' });
      });
    }
    await withOrg(orgA, async (db) => {
      await db.insert(schema.memberships).values({ orgId: orgA, userId: userA, role: 'owner' });
      [{ id: bidA }] = await db.insert(schema.bids).values({
        orgId: orgA, name: 'A', bidType: 'federal', solicitationNumber: 'A', solicitationKey: 'a', status: 'draft',
      }).returning({ id: schema.bids.id });
    });
    await withOrg(orgB, async (db) => {
      [{ id: bidB }] = await db.insert(schema.bids).values({
        orgId: orgB, name: 'B', bidType: 'federal', solicitationNumber: 'B', solicitationKey: 'b', status: 'draft',
      }).returning({ id: schema.bids.id });
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it('a pool of size 1 serving two organizations in a row never returns the other rows', async () => {
    const first = await withOrg(orgA, async (db) => ({
      pid: (await db.execute(sql`select pg_backend_pid() as pid`)).rows[0].pid,
      bids: (await db.select().from(schema.bids)).map((bid) => bid.id),
    }));
    const second = await withOrg(orgB, async (db) => ({
      pid: (await db.execute(sql`select pg_backend_pid() as pid`)).rows[0].pid,
      bids: (await db.select().from(schema.bids)).map((bid) => bid.id),
    }));
    expect(second.pid).toBe(first.pid);
    expect(first.bids).toEqual([bidA]);
    expect(second.bids).toEqual([bidB]);

    // Back on the same connection, outside any transaction: the setting is gone.
    const client = await getPool().connect();
    try {
      const after = await client.query<{ pid: number; org: string | null }>(
        "select pg_backend_pid() as pid, current_setting('app.org_id', true) as org",
      );
      expect(after.rows[0].pid).toBe(first.pid);
      expect(after.rows[0].org ?? '').toBe('');
      const bids = await client.query('select id from bids');
      expect(bids.rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('does not keep the setting after a failed transaction', async () => {
    await expect(withOrg(orgA, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await getDb().select().from(schema.bids))).toEqual([]);
  });

  it('sees no tenant rows at all without app.org_id', async () => {
    const pool = getPool();
    for (const table of [...TENANT_TABLES, 'organizations']) {
      const result = await pool.query(`select count(*)::int as n from ${table}`);
      expect(result.rows[0].n, table).toBe(0);
    }
  });

  it('cannot read, change, delete, or insert another organization rows', async () => {
    await withOrg(orgA, async (db) => {
      expect((await db.execute(sql`select id from bids where id = ${bidB}`)).rows).toEqual([]);
      expect((await db.execute(sql`update bids set name = 'taken' where id = ${bidB}`)).rowCount).toBe(0);
      expect((await db.execute(sql`delete from bids where id = ${bidB}`)).rowCount).toBe(0);
    });
    await expect(withOrg(orgA, async (db) => {
      await db.insert(schema.bids).values({
        orgId: orgB, name: 'planted', bidType: 'federal', solicitationNumber: 'x', solicitationKey: 'x', status: 'draft',
      });
    })).rejects.toThrow(/row-level security/);
    await expect(withOrg(orgA, async (db) => {
      await db.execute(sql`update bids set org_id = ${orgB} where id = ${bidA}`);
    })).rejects.toThrow(/row-level security/);
    await withOrg(orgB, async (db) => {
      const [bid] = await db.select().from(schema.bids);
      expect(bid).toMatchObject({ id: bidB, name: 'B' });
    });
  });

  it('sees and changes only its own organization row', async () => {
    await withOrg(orgA, async (db) => {
      expect((await db.select().from(schema.organizations)).map((org) => org.id)).toEqual([orgA]);
      expect((await db.execute(sql`update organizations set name = 'taken' where id = ${orgB}`)).rowCount).toBe(0);
    });
    await expect(withOrg(orgA, async (db) => {
      await db.insert(schema.organizations).values({ id: randomUUID(), name: 'planted', plan: 'free', planStatus: 'active' });
    })).rejects.toThrow(/row-level security/);
    await withOrg(orgB, async (db) => {
      const [org] = await db.select().from(schema.organizations);
      expect(org).toMatchObject({ id: orgB, name: orgB });
    });
  });

  it('finds a user organizations through the pd_system function only', async () => {
    expect(await userMemberships(userA)).toEqual([{ orgId: orgA, role: 'owner' }]);
    expect(await userMemberships(randomUUID())).toEqual([]);
    // pd_app reads memberships directly only under its own organization.
    expect((await getPool().query('select * from memberships')).rows).toEqual([]);
    await expect(getPool().query('set role pd_system')).rejects.toThrow();
  });
});

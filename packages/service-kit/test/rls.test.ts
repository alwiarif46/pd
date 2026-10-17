import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, applyMigrations, migrationServices } from '../src/migrate';
import { applyTenantRls, tenantRlsSql } from '../src/rls';
import { withTenant } from '../src/index';
import { SKIP_DB, useTestDatabase } from './db-helper';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** Tables that legitimately have no tenant RLS. Empty today: add `schema.table` here with a reason. */
const RLS_ALLOW_LIST: ReadonlyArray<string> = [];

describe('tenantRlsSql', () => {
  it('enables and forces RLS and creates the tenant_id policy', () => {
    const sql = tenantRlsSql('billing', 'credits');
    expect(sql).toContain('alter table "billing"."credits" enable row level security;');
    expect(sql).toContain('alter table "billing"."credits" force row level security;');
    expect(sql).toContain('drop policy if exists tenant_isolation on "billing"."credits";');
    expect(sql).toContain("tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid");
  });

  it('rejects names that are not plain identifiers', () => {
    expect(() => tenantRlsSql('billing', 'x"; drop table t; --')).toThrow(/identifier/);
    expect(() => tenantRlsSql('Bad', 'credits')).toThrow(/identifier/);
    expect(() => tenantRlsSql('billing', 'credits', 'tenant id')).toThrow(/identifier/);
  });

  it('writes the same policy as the outbox in every 0001_init.sql', () => {
    for (const svc of migrationServices()) {
      const init = readFileSync(join(REPO_ROOT, svc.folder, 'migrations', '0001_init.sql'), 'utf8');
      const squash = (s: string): string => s.replace(/\s+/g, ' ').replace(/"/g, '');
      const generated = squash(tenantRlsSql(svc.schema, 'outbox'));
      for (const stmt of generated.split(';').map((x) => x.trim()).filter(Boolean)) {
        expect(squash(init), `${svc.id}: ${stmt}`).toContain(stmt);
      }
    }
  });
});

describe.skipIf(SKIP_DB)('tenant RLS in Postgres', () => {
  const db = useTestDatabase();

  it('a table that gets the template is isolated by tenant, also for its owner', async () => {
    await db().admin.query('create table billing.rls_probe (id serial primary key, tenant_id uuid not null, note text)');
    try {
      await applyTenantRls(db().admin, 'billing', 'rls_probe');
      await applyTenantRls(db().admin, 'billing', 'rls_probe'); // idempotent
      await withTenant(db().admin, A, (c) => c.query("insert into billing.rls_probe (tenant_id, note) values ($1, 'a')", [A]));
      await withTenant(db().admin, B, (c) => c.query("insert into billing.rls_probe (tenant_id, note) values ($1, 'b')", [B]));
      const seenA = await withTenant(db().admin, A, (c) => c.query('select note from billing.rls_probe'));
      expect(seenA.rows).toEqual([{ note: 'a' }]);
      expect((await db().admin.query('select 1 from billing.rls_probe')).rowCount).toBe(0);
      await expect(
        withTenant(db().admin, A, (c) => c.query("insert into billing.rls_probe (tenant_id, note) values ($1, 'x')", [B])),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db().admin.query('drop table billing.rls_probe');
    }
  });

  it('every table in every service schema (but schema_migrations) has RLS enabled, forced and a tenant policy', async () => {
    const r = await db().admin.query<{ schema: string; tbl: string; rls: boolean; forced: boolean; has_col: boolean; policies: number }>(
      `select n.nspname as schema, c.relname as tbl, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
              exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as has_col,
              (select count(*)::int from pg_policies p
                where p.schemaname = n.nspname and p.tablename = c.relname
                  and p.qual like '%app.tenant_id%' and p.with_check like '%app.tenant_id%') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1::text[]) and c.relkind in ('r', 'p') and c.relname <> 'schema_migrations'
        order by 1, 2`,
      [db().services.map((s) => s.schema)],
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(db().services.length);
    const listed = (x: { schema: string; tbl: string }): boolean => RLS_ALLOW_LIST.includes(`${x.schema}.${x.tbl}`);
    const name = (x: { schema: string; tbl: string }): string => `${x.schema}.${x.tbl}`;
    const rows = r.rows.filter((x) => !listed(x));
    expect(rows.filter((x) => !(x.rls && x.forced)).map(name), 'RLS not enabled and forced').toEqual([]);
    expect(rows.filter((x) => !x.has_col).map(name), 'no tenant_id column').toEqual([]);
    expect(rows.filter((x) => x.policies < 1).map(name), 'no tenant_id policy').toEqual([]);
  });

  it('applyMigrations is repeatable and leaves the tenant policy and the three relay policies', async () => {
    await applyMigrations({ adminUrl: db().adminUrl, services: db().services, passwords: db().passwords, relayPassword: db().relayPassword });
    const r = await db().admin.query("select count(*)::int as n from pg_policies where schemaname = 'billing' and tablename = 'outbox'");
    expect(r.rows[0].n).toBe(4);
  });
});

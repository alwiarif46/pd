import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/index';
import { roleName } from '../src/migrate';
import { SKIP_DB, useTestDatabase } from './db-helper';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe.skipIf(SKIP_DB)('service roles', () => {
  const db = useTestDatabase();
  const pools = new Map<string, pg.Pool>();

  beforeAll(() => {
    for (const s of db().services) pools.set(s.id, new pg.Pool({ connectionString: db().roleUrl(s.id), max: 2 }));
  });
  afterAll(async () => {
    await Promise.all([...pools.values()].map((p) => p.end()));
  });

  const pool = (id: string): pg.Pool => pools.get(id)!;

  it('(a) each role uses its own outbox under withTenant: own tenant sees the row, tenant B and no tenant see none', async () => {
    for (const s of db().services) {
      const p = pool(s.id);
      await withTenant(p, A, (c) =>
        c.query(
          `insert into "${s.schema}".outbox (tenant_id, event_id, type, schema_version, payload) values ($1, gen_random_uuid(), $2, '1.0', $3)`,
          [A, `${s.id}.test.thing`, { ok: true }],
        ),
      );
      const own = await withTenant(p, A, (c) => c.query(`select type, payload from "${s.schema}".outbox`));
      expect(own.rows, s.id).toEqual([{ type: `${s.id}.test.thing`, payload: { ok: true } }]);
      const other = await withTenant(p, B, (c) => c.query(`select 1 from "${s.schema}".outbox`));
      expect(other.rowCount, `${s.id} tenant B`).toBe(0);
      const none = await p.query(`select 1 from "${s.schema}".outbox`);
      expect(none.rowCount, `${s.id} no tenant`).toBe(0);
      // A write for a tenant other than the one set is refused by the policy (42501).
      expect(await codeOf(withTenant(p, B, (c) => c.query(`insert into "${s.schema}".outbox (tenant_id, event_id, type, schema_version, payload) values ($1, gen_random_uuid(), 't', '1.0', '{}')`, [A])))).toBe('42501');
      // Same with no tenant setting at all.
      expect(await codeOf(p.query(`insert into "${s.schema}".outbox (tenant_id, event_id, type, schema_version, payload) values ($1, gen_random_uuid(), 't', '1.0', '{}')`, [A]))).toBe('42501');
    }
  });

  it('(a) the role may read but not write its own schema_migrations', async () => {
    for (const s of db().services) {
      const r = await pool(s.id).query(`select id from "${s.schema}".schema_migrations`);
      expect(r.rows, s.id).toEqual([{ id: '0001_init.sql' }]);
      expect(await codeOf(pool(s.id).query(`delete from "${s.schema}".schema_migrations`)), s.id).toBe('42501');
    }
  });

  it('(b) every role gets 42501 on every other service\'s outbox and schema_migrations (14 x 13 pairs)', async () => {
    let pairs = 0;
    for (const from of db().services) {
      for (const to of db().services) {
        if (from.id === to.id) continue;
        for (const table of ['outbox', 'schema_migrations']) {
          const code = await codeOf(pool(from.id).query(`select * from "${to.schema}"."${table}"`));
          expect(code, `${roleName(from.schema)} -> ${to.schema}.${table}`).toBe('42501');
        }
        // Writing is refused just the same.
        expect(await codeOf(pool(from.id).query(`delete from "${to.schema}".outbox`)), `${from.id} delete ${to.id}`).toBe('42501');
        pairs++;
      }
    }
    expect(pairs).toBe(14 * 13);
  });

  it('(b) no role reads app.app_settings directly, but each reads its own app_settings view', async () => {
    await db().admin.query("insert into app.app_settings (key, value) values ('flag', '{\"on\": true}') on conflict (key) do nothing");
    for (const s of db().services) {
      expect(await codeOf(pool(s.id).query('select * from app.app_settings')), s.id).toBe('42501');
      expect(await codeOf(pool(s.id).query('select * from app.schema_migrations')), s.id).toBe('42501');
      const view = await pool(s.id).query('select key, value from app_settings');
      expect(view.rows, s.id).toEqual([{ key: 'flag', value: { on: true } }]);
      const qualified = await pool(s.id).query(`select key from "${s.schema}".app_settings`);
      expect(qualified.rowCount, s.id).toBe(1);
      // The view is read-only for the role.
      expect(await codeOf(pool(s.id).query("insert into app_settings (key, value) values ('x', '1')")), s.id).toBe('42501');
      // Another service's view is out of reach too.
      const other = db().services.find((o) => o.id !== s.id)!;
      expect(await codeOf(pool(s.id).query(`select * from "${other.schema}".app_settings`)), s.id).toBe('42501');
    }
  });

  it('(c) no role can create objects in public or in any schema', async () => {
    for (const s of db().services) {
      expect(await codeOf(pool(s.id).query('create table public.sneaky (n int)')), s.id).toBe('42501');
      expect(await codeOf(pool(s.id).query(`create table "${s.schema}".sneaky (n int)`)), s.id).toBe('42501');
      expect(await codeOf(pool(s.id).query('create schema sneaky')), s.id).toBe('42501');
    }
  });

  it('roles are not superusers and do not bypass RLS; their search_path is their schema', async () => {
    const r = await db().admin.query(
      "select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname like '%\\_svc'",
    );
    const mine = r.rows.filter((x) => db().services.some((s) => roleName(s.schema) === x.rolname));
    expect(mine).toHaveLength(14);
    for (const row of mine) {
      expect(row).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true });
    }
    const sp = await pool('drafting').query('show search_path');
    expect(sp.rows[0].search_path).toBe('drafting');
  });
});

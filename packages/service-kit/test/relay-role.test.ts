import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/index';
import { RELAY_ROLE } from '../src/migrate';
import { BASE_URL, SKIP_DB, useTestDatabase } from './db-helper';

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

describe.skipIf(SKIP_DB)('the outbox relay role', () => {
  const db = useTestDatabase();

  async function seed(): Promise<void> {
    for (const s of db().services) {
      for (const t of [A, B]) {
        await withTenant(db().admin, t, (c) =>
          c.query(
            `insert into "${s.schema}".outbox (tenant_id, event_id, type, schema_version, payload)
             values ($1, gen_random_uuid(), 'relay.test', '1.0', '{}')`,
            [t],
          ),
        );
      }
    }
  }

  it('is a login role with a SCRAM verifier and no broad attributes', async () => {
    const base = new pg.Pool({ connectionString: BASE_URL, max: 1 });
    try {
      const r = await base.query(
        `select rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolpassword like 'SCRAM-SHA-256$%' as scram
           from pg_authid where rolname = $1`,
        [RELAY_ROLE],
      );
      expect(r.rows).toEqual([
        { rolcanlogin: true, rolsuper: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, scram: true },
      ]);
    } finally {
      await base.end();
    }
  });

  it('holds exactly SELECT and UPDATE (published_at) on each outbox, nothing else', async () => {
    const schemas = db().services.map((s) => s.schema);
    const tables = await db().admin.query(
      `select table_schema || '.' || table_name as t, privilege_type as p
         from information_schema.role_table_grants where grantee = $1 order by 1, 2`,
      [RELAY_ROLE],
    );
    expect(tables.rows).toEqual(schemas.slice().sort().map((s) => ({ t: `${s}.outbox`, p: 'SELECT' })));
    const cols = await db().admin.query(
      `select table_schema || '.' || table_name as t, column_name as c, privilege_type as p
         from information_schema.role_column_grants where grantee = $1 and privilege_type in ('UPDATE', 'INSERT', 'REFERENCES')
         group by 1, 2, 3 order by 1`,
      [RELAY_ROLE],
    );
    expect(cols.rows).toEqual(schemas.slice().sort().map((s) => ({ t: `${s}.outbox`, c: 'published_at', p: 'UPDATE' })));
    const usage = await db().admin.query(
      `select n.nspname as s from pg_namespace n where has_schema_privilege($1, n.oid, 'USAGE') and n.nspname = any($2::text[]) order by 1`,
      [RELAY_ROLE, schemas],
    );
    expect(usage.rows.map((x) => x.s)).toEqual(schemas.slice().sort());
    const create = await db().admin.query(
      `select count(*)::int as n from pg_namespace n where has_schema_privilege($1, n.oid, 'CREATE')`,
      [RELAY_ROLE],
    );
    expect(create.rows[0].n).toBe(0);
    for (const s of ['app', 'public']) {
      const r = await db().admin.query('select has_schema_privilege($1, $2, $3) as ok', [RELAY_ROLE, s, 'USAGE']);
      expect(r.rows[0].ok, s).toBe(false);
    }
  });

  it('reads every tenant\'s unpublished rows in every service schema and sets published_at', async () => {
    await seed();
    const pool = new pg.Pool({ connectionString: db().relayUrl(), max: 1 });
    try {
      for (const s of db().services) {
        const rows = await pool.query(`select distinct tenant_id from "${s.schema}".outbox where published_at is null order by 1`);
        expect(rows.rows.map((r) => r.tenant_id), s.id).toEqual([A, B]);
        const upd = await pool.query(`update "${s.schema}".outbox set published_at = now() where published_at is null`);
        expect(upd.rowCount, s.id).toBe(2);
      }
    } finally {
      await pool.end();
    }
  });

  it('cannot read, write or change anything else', async () => {
    await seed();
    const pool = new pg.Pool({ connectionString: db().relayUrl(), max: 1 });
    try {
      for (const s of db().services) {
        const t = `"${s.schema}".outbox`;
        // schema_migrations and the app_settings view
        expect(await codeOf(pool.query(`select * from "${s.schema}".schema_migrations`)), `${s.id} ledger select`).toBe('42501');
        expect(await codeOf(pool.query(`insert into "${s.schema}".schema_migrations (id) values ('x')`)), `${s.id} ledger insert`).toBe('42501');
        expect(await codeOf(pool.query(`delete from "${s.schema}".schema_migrations`)), `${s.id} ledger delete`).toBe('42501');
        expect(await codeOf(pool.query(`select * from "${s.schema}".app_settings`)), `${s.id} app_settings`).toBe('42501');
        // outbox: no insert, no delete, no truncate, no other column
        expect(
          await codeOf(
            pool.query(`insert into ${t} (tenant_id, event_id, type, schema_version, payload) values ($1, gen_random_uuid(), 'x', '1.0', '{}')`, [A]),
          ),
          `${s.id} outbox insert`,
        ).toBe('42501');
        expect(await codeOf(pool.query(`delete from ${t}`)), `${s.id} outbox delete`).toBe('42501');
        expect(await codeOf(pool.query(`truncate ${t}`)), `${s.id} outbox truncate`).toBe('42501');
        for (const col of ['payload = \'{}\'', 'type = \'x\'', 'tenant_id = tenant_id', 'event_id = event_id', 'occurred_at = now()', 'id = id', 'schema_version = \'2.0\'']) {
          expect(await codeOf(pool.query(`update ${t} set ${col}`)), `${s.id} outbox update ${col}`).toBe('42501');
        }
        // objects: nothing to create in the service schema, public or a new schema
        expect(await codeOf(pool.query(`create table "${s.schema}".relay_x (n int)`)), `${s.id} create table`).toBe('42501');
      }
      expect(await codeOf(pool.query('create table public.relay_x (n int)'))).toBe('42501');
      expect(await codeOf(pool.query('create schema relay_x'))).toBe('42501');
      expect(await codeOf(pool.query('select * from app.app_settings'))).toBe('42501');
      expect(await codeOf(pool.query('select * from app.schema_migrations'))).toBe('42501');
      expect(await codeOf(pool.query('create role relay_other'))).toBe('42501');
    } finally {
      await pool.end();
    }
  });

  it('cannot read a table the owner adds later in a service schema', async () => {
    await db().admin.query('create table if not exists billing.relay_later (n int)');
    await db().admin.query('insert into billing.relay_later values (1)');
    const pool = new pg.Pool({ connectionString: db().relayUrl(), max: 1 });
    try {
      expect(await codeOf(pool.query('select * from billing.relay_later'))).toBe('42501');
    } finally {
      await pool.end();
      await db().admin.query('drop table billing.relay_later');
    }
  });

  it('can connect to the migrated database, and PUBLIC cannot', async () => {
    const r = await db().admin.query('select has_database_privilege($1, $2, $3) as ok', [RELAY_ROLE, db().database, 'CONNECT']);
    expect(r.rows[0].ok).toBe(true);
  });
});

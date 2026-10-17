import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/index';
import { roleName } from '../src/migrate';
import { BASE_URL, SKIP_DB, useTestDatabase } from './db-helper';

const A = '11111111-1111-4111-8111-111111111111';

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe.skipIf(SKIP_DB)('the table owner is not exempt from RLS', () => {
  const db = useTestDatabase();

  it('migrates as a plain role: not a superuser, no BYPASSRLS, owns the tables', async () => {
    const me = await db().admin.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
    expect(me.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    for (const s of db().services) {
      const t = await db().admin.query('select tableowner from pg_tables where schemaname = $1 and tablename = $2', [s.schema, 'outbox']);
      expect(t.rows, s.id).toEqual([{ tableowner: db().adminRole }]);
    }
  });

  it('shows the owner no rows and refuses its inserts without app.tenant_id; with it, both work', async () => {
    for (const s of db().services) {
      const t = `"${s.schema}".outbox`;
      const insert = `insert into ${t} (tenant_id, event_id, type, schema_version, payload) values ($1, gen_random_uuid(), 'owner.test', '1.0', '{}')`;
      // With the setting, the owner writes and reads its row.
      await withTenant(db().admin, A, (c) => c.query(insert, [A]));
      const seen = await withTenant(db().admin, A, (c) => c.query(`select 1 from ${t}`));
      expect(seen.rowCount, `${s.id} with tenant`).toBe(1);
      // Without it the same connection role sees nothing and cannot insert.
      const none = await db().admin.query(`select 1 from ${t}`);
      expect(none.rowCount, `${s.id} no tenant`).toBe(0);
      expect(await codeOf(db().admin.query(insert, [A])), `${s.id} insert`).toBe('42501');
    }
  });
});

describe.skipIf(SKIP_DB)('database access guards', () => {
  const db = useTestDatabase();

  it('PUBLIC cannot connect to the migrated database; each service role can; an unrelated role cannot', async () => {
    const pub = await db().admin.query(
      'select count(*)::int as n from pg_database d, aclexplode(d.datacl) a where d.datname = $1 and a.grantee = 0 and a.privilege_type = $2',
      [db().database, 'CONNECT'],
    );
    expect(pub.rows[0].n).toBe(0);
    for (const s of db().services) {
      const r = await db().admin.query('select has_database_privilege($1, $2, $3) as ok', [roleName(s.schema), db().database, 'CONNECT']);
      expect(r.rows[0].ok, s.id).toBe(true);
    }
    const probe = `sk_probe_${randomBytes(5).toString('hex')}`;
    await db().admin.query(`create role "${probe}" nologin`);
    try {
      const r = await db().admin.query('select has_database_privilege($1, $2, $3) as ok', [probe, db().database, 'CONNECT']);
      expect(r.rows[0].ok).toBe(false);
    } finally {
      await db().admin.query(`drop role "${probe}"`);
    }
  });

  it('left the postgres database alone', async () => {
    const base = new pg.Pool({ connectionString: BASE_URL, max: 1 });
    try {
      const r = await base.query(
        "select count(*)::int as n from pg_database d, aclexplode(d.datacl) a where d.datname = 'postgres' and a.grantee = 0 and a.privilege_type = 'CONNECT'",
      );
      // datacl is null (default PUBLIC connect) or still lists PUBLIC; either way the migrator did not touch it.
      const acl = await base.query("select datacl is null as dflt from pg_database where datname = 'postgres'");
      expect(acl.rows[0].dflt || r.rows[0].n === 1).toBe(true);
    } finally {
      await base.end();
    }
  });
});

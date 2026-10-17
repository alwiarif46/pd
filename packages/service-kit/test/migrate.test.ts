import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APP_MIGRATIONS_DIR,
  MIGRATION_ORDER,
  REPO_ROOT,
  applyMigrations,
  migrationFiles,
  migrationServices,
} from '../src/migrate';
import { BASE_URL, SKIP_DB, urlFor, useTestDatabase } from './db-helper';
import { randomBytes } from 'node:crypto';

/** Drops comments and string literals so `current_setting('app.tenant_id')` is not a schema reference. */
function stripSql(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^']|'')*'/g, "''");
}

describe('migration files', () => {
  const services = migrationServices();

  it('cover the 14 services with a schema, in the 09 s9.3 order list', () => {
    expect(services).toHaveLength(14);
    expect(MIGRATION_ORDER).toEqual([
      'app', 'identity', 'billing', 'ingest', 'intel', 'orchestrator', 'modelgw', 'drafting',
      'review', 'render', 'evidence', 'comms', 'portal', 'drive', 'notify',
    ]);
    for (const s of services) expect(MIGRATION_ORDER).toContain(s.schema);
  });

  it('exist for every service and none references another schema', () => {
    const schemas = [...MIGRATION_ORDER, 'public'];
    for (const svc of services) {
      const dir = join(REPO_ROOT, svc.folder, 'migrations');
      const files = migrationFiles(dir);
      expect(files.length, `${svc.id} has no migrations`).toBeGreaterThan(0);
      for (const file of files) {
        const sql = stripSql(readFileSync(join(dir, file), 'utf8'));
        for (const other of schemas.filter((s) => s !== svc.schema)) {
          const re = new RegExp(`(^|[^A-Za-z0-9_])"?${other}"?\\s*\\.`, 'i');
          expect(re.test(sql), `${svc.folder}/migrations/${file} references schema ${other}`).toBe(false);
        }
      }
    }
  });

  it('never set search_path: the migrator sets it, and a file may not change it', () => {
    const dirs = [APP_MIGRATIONS_DIR, ...services.map((svc) => join(REPO_ROOT, svc.folder, 'migrations'))];
    for (const dir of dirs) {
      for (const file of migrationFiles(dir)) {
        const sql = readFileSync(join(dir, file), 'utf8').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(/search_path/i.test(sql), `${dir}/${file} mentions search_path`).toBe(false);
      }
    }
  });

  it('give each outbox the 09 s2 columns, FORCE RLS and the tenant policy', () => {
    for (const svc of services) {
      const sql = readFileSync(join(REPO_ROOT, svc.folder, 'migrations', '0001_init.sql'), 'utf8');
      expect(sql).toContain(`create schema if not exists ${svc.schema};`);
      expect(sql).toContain(`${svc.schema}.outbox enable row level security`);
      expect(sql).toContain(`${svc.schema}.outbox force row level security`);
      expect(sql).toContain("tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid");
      expect(sql).toContain(`to ${svc.schema}_svc`);
    }
  });

  it('keeps the app step apart from the service schemas', () => {
    expect(migrationFiles(APP_MIGRATIONS_DIR)).toEqual(['0001_app_settings.sql']);
  });
});

describe('applyMigrations argument handling', () => {
  it('rejects an unknown id in only before connecting', async () => {
    await expect(
      applyMigrations({ adminUrl: 'postgres://nobody@127.0.0.1:1/none', services: migrationServices(), only: ['nope'] }),
    ).rejects.toThrow(/Unknown service/);
  });
});

describe.skipIf(SKIP_DB)('applyMigrations against Postgres', () => {
  const db = useTestDatabase();
  const scratch: string[] = [];
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  it('recorded 0001_init.sql for every schema and app', async () => {
    for (const s of db().services) {
      const r = await db().admin.query(`select id from "${s.schema}".schema_migrations`);
      expect(r.rows, s.schema).toEqual([{ id: '0001_init.sql' }]);
    }
    expect((await db().admin.query('select id from app.schema_migrations')).rows).toEqual([{ id: '0001_app_settings.sql' }]);
  });

  it('is idempotent: a second run skips everything and applies nothing', async () => {
    const results = await applyMigrations({ adminUrl: db().adminUrl, services: db().services, passwords: db().passwords });
    expect(results.map((r) => r.step)).toEqual(['app', ...MIGRATION_ORDER.slice(1)]);
    for (const r of results) {
      expect(r.applied, r.step).toEqual([]);
      expect(r.skipped.length, r.step).toBe(1);
    }
  });

  it('applies in the fixed order whatever order the services are passed in', async () => {
    const seen: string[] = [];
    await applyMigrations({
      adminUrl: db().adminUrl,
      services: [...db().services].reverse(),
      passwords: db().passwords,
      log: (l) => seen.push(l),
    });
    const steps = seen.filter((l) => /: applied \d+/.test(l)).map((l) => l.split(':')[0]);
    expect(steps).toEqual([...MIGRATION_ORDER]);
  });

  it('applies later files in filename order and records them, only for the selected service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sk-mig-'));
    scratch.push(root);
    mkdirSync(join(root, 'infra', 'db', 'app'), { recursive: true });
    writeFileSync(join(root, 'infra', 'db', 'app', '0001_app_settings.sql'), readFileSync(join(APP_MIGRATIONS_DIR, '0001_app_settings.sql')));
    const folder = 'svc/billing';
    mkdirSync(join(root, folder, 'migrations'), { recursive: true });
    writeFileSync(join(root, folder, 'migrations', '0002_b.sql'), 'create table if not exists billing.t_b (n int);');
    writeFileSync(join(root, folder, 'migrations', '0001_a.sql'), 'create table if not exists billing.t_a (n int);');
    const database = `sk_order_${randomBytes(5).toString('hex')}`;
    const base = new pg.Pool({ connectionString: BASE_URL, max: 1 });
    await base.query(`create database ${database}`);
    try {
      const adminUrl = urlFor(BASE_URL!, null, null, database);
      const svc = [{ id: 'billing', schema: 'billing', folder }];
      const first = await applyMigrations({ adminUrl, services: svc, repoRoot: root, only: ['billing'] });
      expect(first.find((r) => r.step === 'billing')?.applied).toEqual(['0001_a.sql', '0002_b.sql']);
      writeFileSync(join(root, folder, 'migrations', '0003_c.sql'), 'create table if not exists billing.t_c (n int); create table if not exists t_unqualified (n int);');
      const second = await applyMigrations({ adminUrl, services: svc, repoRoot: root });
      expect(second.find((r) => r.step === 'billing')).toMatchObject({ applied: ['0003_c.sql'], skipped: ['0001_a.sql', '0002_b.sql'] });
      writeFileSync(join(root, folder, 'migrations', '0004_bad.sql'), 'select * from no_such_table;');
      await expect(applyMigrations({ adminUrl, services: svc, repoRoot: root })).rejects.toThrow(/0004_bad.sql failed/);
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      const ids = (await admin.query('select id from billing.schema_migrations order by id')).rows.map((r) => r.id);
      await admin.end();
      expect(ids).toEqual(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
      // An unqualified name in a migration file lands in the service's own schema.
      const where = new pg.Client({ connectionString: adminUrl });
      await where.connect();
      const loc = await where.query("select table_schema from information_schema.tables where table_name = 't_unqualified'");
      await where.end();
      expect(loc.rows).toEqual([{ table_schema: 'billing' }]);
    } finally {
      await base.query(`drop database if exists ${database} with (force)`);
      await base.end();
    }
  });
});

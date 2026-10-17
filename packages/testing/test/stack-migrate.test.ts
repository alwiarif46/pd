import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_ORDER, roleName } from '@pd/service-kit/migrate';
import { repoRoot } from '../src/index';
import { BASE_URL, SKIP_DB, urlFor } from './db-helper';

// `pnpm migrate` end to end against a scratch database (done-when: every schema applies in the 09 s9.3 order), and the
// Zitadel side of schema isolation (the Zitadel database role cannot read service schemas).
// "A service role that queries another service's schema gets a permission error" is covered by
// packages/service-kit/test/isolation.test.ts (14 roles x 13 other schemas, error 42501).
const ROOT = repoRoot();
const CLUSTER_LOCK = 7_450_902; // same key as the other database tests: roles are cluster-wide

function runMigrateCli(adminUrl: string): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PD_ADMIN_DATABASE_URL: adminUrl };
  for (const k of Object.keys(env)) if (k.endsWith('_DB_PASSWORD')) delete env[k]; // no password: roles stay as they are
  // Same as the root script "migrate": tsx packages/service-kit/scripts/migrate-cli.ts
  const r = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsx'), ['packages/service-kit/scripts/migrate-cli.ts'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(SKIP_DB)('pnpm migrate against a scratch database', () => {
  let lock: pg.Client;
  let database: string;
  let adminUrl: string;
  let first: { status: number | null; out: string };
  const probeRole = `zitadel_probe_${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    lock = new pg.Client({ connectionString: BASE_URL });
    await lock.connect();
    await lock.query('select pg_advisory_lock($1)', [CLUSTER_LOCK]);
    database = `stack_migrate_${randomBytes(6).toString('hex')}`;
    await lock.query(`create database "${database}"`);
    adminUrl = urlFor(BASE_URL as string, null, null, database);
    first = runMigrateCli(adminUrl);
  });

  afterAll(async () => {
    try {
      await lock.query(`drop database if exists "${database}" with (force)`);
      await lock.query(`drop owned by "${probeRole}"`).catch(() => undefined);
      await lock.query(`drop role if exists "${probeRole}"`).catch(() => undefined);
    } finally {
      await lock.query('select pg_advisory_unlock($1)', [CLUSTER_LOCK]).catch(() => undefined);
      await lock.end();
    }
  });

  it('exits 0 and reports ok', () => {
    expect(first.out).toContain('migrate ok');
    expect(first.status).toBe(0);
  });

  it('applies all 15 schemas in the 09 s9.3 order', () => {
    const steps = [...first.out.matchAll(/^(\w+): applied (\d+), skipped (\d+)$/gm)].map((m) => m[1]);
    expect(steps).toEqual([...MIGRATION_ORDER]);
    expect(steps).toHaveLength(15);
    expect(steps[0]).toBe('app');
    expect(first.out).toContain('migrate ok: 15 file(s) applied across 15 step(s)');
  });

  it('makes the 14 service roles before the first schema step', () => {
    const lines = first.out.split('\n');
    const lastRole = lines.reduce((n, l, i) => (/^role \w+_svc: /.test(l) ? i : n), -1);
    const firstStep = lines.findIndex((l) => /^app: applied/.test(l));
    expect([...first.out.matchAll(/^role (\w+_svc): /gm)]).toHaveLength(14);
    expect(lastRole).toBeLessThan(firstStep);
  });

  it('records one migration in every schema ledger, and a second run changes nothing', async () => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      for (const schema of MIGRATION_ORDER) {
        const { rows } = await c.query<{ n: string }>(`select count(*) as n from ${schema}.schema_migrations`);
        expect(Number(rows[0]?.n), `${schema} ledger`).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await c.end();
    }
    const again = runMigrateCli(adminUrl);
    expect(again.status).toBe(0);
    expect(again.out).toContain('migrate ok: 0 file(s) applied across 15 step(s)');
  });

  it('a role outside the 14 (as Zitadel is) cannot connect to the database, and cannot read any service schema', async () => {
    // Stands in for the zitadel login role: a plain login role with no grants. The Compose init script gives the real one
    // its own database and revokes PUBLIC connect on it the same way (infra/compose/postgres-init/01-databases.sh).
    await lock.query(`create role "${probeRole}" login password '${randomBytes(12).toString('hex')}' nosuperuser nobypassrls`);
    const probePassword = randomBytes(12).toString('hex');
    await lock.query(`alter role "${probeRole}" password '${probePassword}'`);

    // 1. It cannot even connect: migrate revoked CONNECT from PUBLIC on this database.
    const blocked = new pg.Client({ connectionString: urlFor(BASE_URL as string, probeRole, probePassword, database) });
    await expect(blocked.connect()).rejects.toMatchObject({ code: '42501' });
    await blocked.end().catch(() => undefined);

    // 2. Even if it could connect (CONNECT granted by mistake), no service schema is readable.
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`grant connect on database "${database}" to "${probeRole}"`);
      const roles = [probeRole];
      const hasZitadel = (await admin.query("select 1 from pg_roles where rolname = 'zitadel'")).rowCount === 1;
      if (hasZitadel) roles.push('zitadel');
      for (const role of roles) {
        for (const schema of MIGRATION_ORDER) {
          await admin.query(`set role "${role}"`);
          const err = await admin.query(`select 1 from ${schema}.${schema === 'app' ? 'app_settings' : 'outbox'} limit 1`).then(
            () => null,
            (e: { code?: string }) => e,
          );
          await admin.query('reset role');
          expect(err?.code, `${role} reading ${schema}`).toBe('42501');
        }
      }
    } finally {
      await admin.query('reset role').catch(() => undefined);
      await admin.query(`revoke connect on database "${database}" from "${probeRole}"`).catch(() => undefined);
      await admin.end();
    }
  });

  it('the 14 service roles are not superusers and do not bypass row-level security', async () => {
    const { rows } = await lock.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolname, rolsuper, rolbypassrls from pg_roles where rolname = any($1::text[])',
      [MIGRATION_ORDER.filter((s) => s !== 'app').map(roleName)],
    );
    expect(rows).toHaveLength(14);
    for (const r of rows) {
      expect(r.rolsuper).toBe(false);
      expect(r.rolbypassrls).toBe(false);
    }
  });
});

describe('Compose Postgres init script', () => {
  const script = readFileSync(join(ROOT, 'infra', 'compose', 'postgres-init', '01-databases.sh'), 'utf8');

  it('revokes PUBLIC connect on the Zitadel database and grants it to the Zitadel role only', () => {
    expect(script).toMatch(/revoke connect on database :"zdb" from public;/i);
    expect(script).toMatch(/grant connect on database :"zdb" to :"zuser";/i);
  });

  it('enables pgvector in the e2e database and takes the password from the environment', () => {
    expect(script).toMatch(/create extension if not exists vector;/i);
    expect(script).toContain('"${ZITADEL_DB_PASSWORD:?}"');
    expect(script).not.toMatch(/password\s+'[^:]/i);
  });
});

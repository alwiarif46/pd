import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { applyMigrations, migrationServices, roleName, type MigrationService } from '../src/migrate';

export const BASE_URL = process.env.TEST_DATABASE_URL;
export const IN_CI = process.env.CI === 'true';
/** True when DB tests must be skipped: no database and not in CI. In CI a missing URL fails. */
export const SKIP_DB = !BASE_URL && !IN_CI;

if (SKIP_DB) {
  console.warn('[service-kit] TEST_DATABASE_URL is not set: database tests are skipped (they fail under CI=true)');
}

// Roles are cluster-wide, so two test runs on one cluster must not overlap.
const CLUSTER_LOCK = 7_450_902;

export function urlFor(base: string, user: string | null, password: string | null, database: string): string {
  const u = new URL(base);
  if (user !== null) u.username = user;
  if (password !== null) u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

export interface TestDb {
  database: string;
  adminUrl: string;
  services: MigrationService[];
  passwords: Record<string, string>;
  roleUrl(serviceId: string): string;
  admin: pg.Pool;
}

/** Creates a fresh database, migrates it, and drops it after the file's tests. */
export function useTestDatabase(): () => TestDb {
  let state: TestDb | undefined;
  let lockClient: pg.Client | undefined;
  let base: pg.Pool | undefined;

  beforeAll(async () => {
    if (!BASE_URL) throw new Error('TEST_DATABASE_URL is not set (required under CI=true)');
    lockClient = new pg.Client({ connectionString: BASE_URL });
    await lockClient.connect();
    await lockClient.query('select pg_advisory_lock($1)', [CLUSTER_LOCK]);

    const database = `sk_test_${randomBytes(6).toString('hex')}`;
    base = new pg.Pool({ connectionString: BASE_URL, max: 1 });
    await base.query(`create database ${database}`);

    const services = migrationServices();
    const passwords = Object.fromEntries(services.map((s) => [s.id, randomBytes(18).toString('hex')]));
    const adminUrl = urlFor(BASE_URL, null, null, database);
    await applyMigrations({ adminUrl, services, passwords });
    state = {
      database,
      adminUrl,
      services,
      passwords,
      roleUrl: (id) => {
        const svc = services.find((s) => s.id === id);
        if (!svc) throw new Error(`unknown service ${id}`);
        return urlFor(BASE_URL, roleName(svc.schema), passwords[id]!, database);
      },
      admin: new pg.Pool({ connectionString: adminUrl, max: 2 }),
    };
  });

  afterAll(async () => {
    try {
      await state?.admin.end();
      if (base && state) {
        await base.query(`drop database if exists ${state.database} with (force)`);
      }
    } finally {
      await base?.end();
      if (lockClient) {
        await lockClient.query('select pg_advisory_unlock($1)', [CLUSTER_LOCK]).catch(() => undefined);
        await lockClient.end();
      }
    }
  });

  return () => {
    if (!state) throw new Error('test database is not ready');
    return state;
  };
}

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { seedAll, type SeedReport } from '../src/seed';

export const BASE_URL = process.env.TEST_DATABASE_URL;
export const IN_CI = process.env.CI === 'true';
/** True when DB tests must be skipped: no database and not in CI. In CI a missing URL fails. */
export const SKIP_DB = !BASE_URL && !IN_CI;

if (SKIP_DB) {
  console.warn('[testing] TEST_DATABASE_URL is not set: database tests are skipped (they fail under CI=true)');
}

// Roles are cluster-wide (pd_app, pd_system), so two runs on one cluster must not overlap.
// Same key as packages/service-kit/test/db-helper.ts.
const CLUSTER_LOCK = 7_450_902;

export function urlFor(base: string, user: string | null, password: string | null, database: string): string {
  const u = new URL(base);
  if (user !== null) u.username = user;
  if (password !== null) u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

export interface SeededDb {
  database: string;
  adminUrl: string;
  /** Login as pd_app (row-level security applies). Null when pd_app already existed and TEST_PD_APP_PASSWORD is unset. */
  appUrl: string | null;
  firstRun: SeedReport;
}

/**
 * A scratch database, migrated and seeded once, dropped after the file's tests.
 * Roles that the migration creates are dropped too, unless they existed before.
 */
export function useSeededDatabase(): () => SeededDb {
  let state: SeededDb | undefined;
  let lock: pg.Client | undefined;
  let roleExisted = true;

  beforeAll(async () => {
    if (!BASE_URL) throw new Error('TEST_DATABASE_URL is not set (required under CI=true)');
    lock = new pg.Client({ connectionString: BASE_URL });
    await lock.connect();
    await lock.query('select pg_advisory_lock($1)', [CLUSTER_LOCK]);
    roleExisted = ((await lock.query("select 1 from pg_roles where rolname = 'pd_app'")).rowCount ?? 0) > 0;

    const database = `testing_${randomBytes(6).toString('hex')}`;
    await lock.query(`create database ${database}`);
    const adminUrl = urlFor(BASE_URL, null, null, database);
    const firstRun = await seedAll(adminUrl);

    let appUrl: string | null = null;
    if (!roleExisted) {
      const password = randomBytes(12).toString('hex');
      await lock.query(`alter role pd_app with login password '${password}'`);
      appUrl = urlFor(BASE_URL, 'pd_app', password, database);
    } else if (process.env.TEST_PD_APP_PASSWORD) {
      appUrl = urlFor(BASE_URL, 'pd_app', process.env.TEST_PD_APP_PASSWORD, database);
    } else {
      console.warn('[testing] role pd_app already exists and TEST_PD_APP_PASSWORD is unset: the row-level security tests are skipped');
    }
    state = { database, adminUrl, appUrl, firstRun };
  });

  afterAll(async () => {
    if (!lock) return;
    try {
      if (state) await lock.query(`drop database if exists ${state.database} with (force)`);
      if (!roleExisted) {
        await lock.query('drop owned by pd_app, pd_system cascade').catch(() => undefined);
        await lock.query('drop role if exists pd_app').catch(() => undefined);
        await lock.query('drop role if exists pd_system').catch(() => undefined);
      }
    } finally {
      await lock.query('select pg_advisory_unlock($1)', [CLUSTER_LOCK]).catch(() => undefined);
      await lock.end();
    }
  });

  return () => {
    if (!state) throw new Error('database is not ready');
    return state;
  };
}

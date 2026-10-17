import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import { RELAY_ROLE, applyMigrations, migrationServices, roleName, type MigrationService } from '../src/migrate';

export const BASE_URL = process.env.TEST_DATABASE_URL;
export const IN_CI = process.env.CI === 'true';
/** No database and not in CI. In CI a missing URL fails. */
export const SKIP_DB_NO_URL = !BASE_URL && !IN_CI;

if (SKIP_DB_NO_URL) {
  console.warn('[service-kit] TEST_DATABASE_URL is not set: database tests are skipped (they fail under CI=true)');
}

/**
 * The tests call applyMigrations with random passwords, which resets the password of each
 * `<schema>_svc` role. Roles are cluster-wide, so on a cluster whose roles are really in use
 * (a login role with a password already set) that would lock the services out. Refuse unless the
 * runner says the cluster is disposable.
 */
export const RESETS_ROLES_OK = process.env.SERVICE_KIT_TEST_RESETS_ROLES === '1';

/** Decided once in test/global-setup.ts, before any file runs (a per-file check would trip on roles an earlier file made). */
const inUse = inject('serviceRolesInUse');
export const SKIP_ROLE_RESET = inUse.length > 0;
/** True when database tests are skipped: no URL (outside CI), or a cluster whose service roles are in use. */
export const SKIP_DB = SKIP_DB_NO_URL || SKIP_ROLE_RESET;

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
  /** Connection of the database owner: a plain role (CREATEROLE, CREATEDB), not a superuser, not BYPASSRLS. */
  adminUrl: string;
  adminRole: string;
  services: MigrationService[];
  passwords: Record<string, string>;
  relayPassword: string;
  roleUrl(serviceId: string): string;
  /** Connection string of the outbox relay role. */
  relayUrl(): string;
  /** A pool connected as the owner role. */
  admin: pg.Pool;
}

/**
 * Creates a fresh database owned by a throwaway non-superuser role, migrates it as that role
 * (so FORCE RLS is proven for the table owner), and drops both after the file's tests.
 */
export function useTestDatabase(): () => TestDb {
  let state: TestDb | undefined;
  let lockClient: pg.Client | undefined;
  let base: pg.Pool | undefined;
  let adminRole: string | undefined;
  let database: string | undefined;

  beforeAll(async () => {
    if (!BASE_URL) throw new Error('TEST_DATABASE_URL is not set (required under CI=true)');
    lockClient = new pg.Client({ connectionString: BASE_URL });
    await lockClient.connect();
    await lockClient.query('select pg_advisory_lock($1)', [CLUSTER_LOCK]);

    const suffix = randomBytes(6).toString('hex');
    database = `sk_test_${suffix}`;
    adminRole = `sk_admin_${suffix}`;
    const adminPassword = randomBytes(18).toString('hex');
    base = new pg.Pool({ connectionString: BASE_URL, max: 1 });
    const create = await base.query<{ sql: string }>(
      "select format('create role %I createrole createdb nosuperuser nobypassrls login password %L', $1::text, $2::text) as sql",
      [adminRole, adminPassword],
    );
    await base.query(create.rows[0]!.sql);
    // PG16: altering a role that already exists needs ADMIN OPTION on it. Roles that do not
    // exist yet are created by the owner, which gets ADMIN OPTION on them automatically.
    const services = migrationServices();
    const existing = await base.query<{ rolname: string }>('select rolname from pg_roles where rolname = any($1::text[])', [
      [...services.map((s) => roleName(s.schema)), RELAY_ROLE],
    ]);
    for (const { rolname } of existing.rows) {
      await base.query(`grant "${rolname}" to "${adminRole}" with admin option`);
    }
    await base.query(`create database "${database}" owner "${adminRole}"`);

    const passwords = Object.fromEntries(services.map((s) => [s.id, randomBytes(18).toString('hex')]));
    const adminUrl = urlFor(BASE_URL, adminRole, adminPassword, database);
    const relayPassword = randomBytes(18).toString('hex');
    await applyMigrations({ adminUrl, services, passwords, relayPassword });
    const dbName = database;
    const adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    // An idle client that the server drops at teardown must not become an uncaught exception.
    adminPool.on('error', () => undefined);
    state = {
      database: dbName,
      adminUrl,
      adminRole,
      services,
      passwords,
      roleUrl: (id) => {
        const svc = services.find((s) => s.id === id);
        if (!svc) throw new Error(`unknown service ${id}`);
        return urlFor(BASE_URL, roleName(svc.schema), passwords[id]!, dbName);
      },
      relayUrl: () => urlFor(BASE_URL, RELAY_ROLE, relayPassword, dbName),
      relayPassword,
      admin: adminPool,
    };
  });

  afterAll(async () => {
    try {
      await state?.admin.end();
      if (base && database) await base.query(`drop database if exists "${database}" with (force)`);
      if (base && adminRole) await base.query(`drop role if exists "${adminRole}"`);
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

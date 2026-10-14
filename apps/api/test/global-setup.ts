/**
 * Provides a real Postgres for the api tests, migrated with the repo's migrations, and a
 * connection string for the `pd_app` role so row-level security is exercised.
 *
 * - TEST_DATABASE_URL set: a superuser connection to a throwaway cluster (CI uses a
 *   `services: postgres` container). A fresh database is created and dropped per run.
 * - Otherwise: starts a temporary cluster with the `embedded-postgres` package.
 *   Set PD_TEST_EMBEDDED=0 to turn that off.
 * - Neither available: the database tests skip with the reason, except under CI, where
 *   the run fails instead.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    /** Superuser connection to the cluster's maintenance database (for tests that create databases). */
    clusterUrl: string;
    appUrl: string;
    dbUnavailable: string;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../../packages/core/src/db/migrations');

interface Cluster {
  url: string;
  stop: () => Promise<void>;
}

async function startEmbedded(): Promise<Cluster> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const databaseDir = join(await mkdtemp(join(tmpdir(), 'pd-api-test-')), 'data');
  const password = randomBytes(12).toString('hex');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password,
    authMethod: 'scram-sha-256',
    persistent: false,
    onLog: () => undefined,
  });
  await server.initialise();
  await server.start();
  return {
    url: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`,
    stop: () => server.stop(),
  };
}

function withDatabase(url: string, database: string, user?: { name: string; password: string }): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  if (user) {
    next.username = user.name;
    next.password = user.password;
  }
  return next.toString();
}

export default async function setup({ provide }: GlobalSetupContext) {
  let cluster: Cluster | null = null;
  const external = process.env.TEST_DATABASE_URL;
  try {
    if (external) {
      cluster = { url: external, stop: async () => undefined };
    } else if (process.env.PD_TEST_EMBEDDED !== '0') {
      cluster = await startEmbedded();
    }
  } catch (error) {
    const reason = `embedded-postgres could not start: ${error instanceof Error ? error.message : String(error)}`;
    if (process.env.CI) {
      throw new Error(reason);
    }
    console.warn(`[api tests] ${reason}`);
    cluster = null;
  }
  if (!cluster) {
    if (process.env.CI) {
      throw new Error('No database for the api tests. Set TEST_DATABASE_URL.');
    }
    const reason = 'No TEST_DATABASE_URL, and embedded Postgres is off or failed: the database tests are skipped.';
    console.warn(`[api tests] ${reason}`);
    provide('dbUnavailable', reason);
    provide('adminUrl', '');
    provide('clusterUrl', '');
    provide('appUrl', '');
    return;
  }

  const database = `pd_test_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const admin = new pg.Client({ connectionString: cluster.url });
  await admin.connect();
  const existing = await admin.query("select 1 from pg_roles where rolname = 'pd_app'");
  const roleExisted = (existing.rowCount ?? 0) > 0;
  if (roleExisted && !process.env.TEST_PD_APP_PASSWORD) {
    await admin.end();
    await cluster.stop();
    throw new Error(
      'Role pd_app already exists on the TEST_DATABASE_URL cluster. Use a throwaway cluster, '
      + 'or set TEST_PD_APP_PASSWORD to its password so the tests do not change it.',
    );
  }
  // Migrate the way production should: as an owner role that owns the database and has
  // CREATEROLE but is not a superuser. When pd_app already existed (TEST_PD_APP_PASSWORD),
  // that owner cannot be granted SET on the existing pd_system, so the superuser migrates.
  const owner = { name: `pd_owner_${randomBytes(4).toString('hex')}`, password: randomBytes(12).toString('hex') };
  if (!roleExisted) {
    await admin.query(`create role "${owner.name}" login createrole nosuperuser nobypassrls password '${owner.password}'`);
    await admin.query(`create database "${database}" owner "${owner.name}"`);
  } else {
    await admin.query(`create database "${database}"`);
  }

  const adminUrl = withDatabase(cluster.url, database);
  const migrator = new pg.Client({
    connectionString: roleExisted ? adminUrl : withDatabase(cluster.url, database, owner),
  });
  await migrator.connect();
  await migrate(drizzle(migrator), { migrationsFolder });
  await migrator.end();

  const appPassword = process.env.TEST_PD_APP_PASSWORD ?? randomBytes(12).toString('hex');
  if (!roleExisted) {
    await admin.query(`alter role pd_app with login password '${appPassword}'`);
  }
  await admin.end();

  provide('adminUrl', adminUrl);
  provide('clusterUrl', cluster.url);
  provide('appUrl', withDatabase(cluster.url, database, { name: 'pd_app', password: appPassword }));
  provide('dbUnavailable', '');

  const stop = cluster.stop;
  const baseUrl = cluster.url;
  return async () => {
    if (external) {
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      await cleanup.query(`drop database if exists "${database}" with (force)`);
      if (!roleExisted) {
        // Created by this run's migration on a throwaway cluster; leave the cluster as found.
        await cleanup.query('drop owned by pd_app, pd_system cascade').catch(() => undefined);
        await cleanup.query('drop role if exists pd_app').catch(() => undefined);
        await cleanup.query('drop role if exists pd_system').catch(() => undefined);
        await cleanup.query(`drop role if exists "${owner.name}"`).catch(() => undefined);
      }
      await cleanup.end();
    }
    await stop();
  };
}

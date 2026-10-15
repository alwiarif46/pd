/**
 * Local dev database: starts an embedded Postgres cluster in a persistent folder, migrates
 * it as a non-superuser owner (as production should), sets the pd_app password, and writes
 * the app connection string to <root>/dev-db.json. Stays running until stopped.
 *
 *   pnpm dev:db                      data in <repo>/.dev/pg
 *   PD_DEV_DB_ROOT=<dir> pnpm dev:db data in <dir> (an existing cluster keeps its data)
 *
 * PD_DEV_DB_PORT and the PD_DEV_DB_*_PASSWORD variables override the dev defaults below.
 * The passwords only take effect when the cluster and database are first created.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = resolve(process.env.PD_DEV_DB_ROOT || join(repo, '.dev', 'pg'));
const port = Number(process.env.PD_DEV_DB_PORT || 54329);
const adminPassword = process.env.PD_DEV_DB_ADMIN_PASSWORD || 'dev-admin-pw';
const ownerName = 'pd_owner';
const ownerPassword = process.env.PD_DEV_DB_OWNER_PASSWORD || 'dev-owner-pw';
const appPassword = process.env.PD_DEV_DB_APP_PASSWORD || 'dev-app-pw';

/** A SQL string literal; role passwords cannot be bound as parameters. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

mkdirSync(root, { recursive: true });
const dataDir = join(root, 'data');
const fresh = !existsSync(join(dataDir, 'PG_VERSION'));

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  port,
  user: 'postgres',
  password: adminPassword,
  authMethod: 'scram-sha-256',
  persistent: true,
  onLog: () => undefined,
});
if (fresh) await server.initialise();
await server.start();

const admin = new pg.Client({ connectionString: `postgres://postgres:${encodeURIComponent(adminPassword)}@127.0.0.1:${port}/postgres` });
await admin.connect();
const hasDb = await admin.query("select 1 from pg_database where datname = 'pd'");
if (hasDb.rowCount === 0) {
  await admin.query(`create role "${ownerName}" login createrole nosuperuser nobypassrls password ${literal(ownerPassword)}`);
  await admin.query(`create database pd owner "${ownerName}"`);
  const migrator = new pg.Client({ connectionString: `postgres://${ownerName}:${encodeURIComponent(ownerPassword)}@127.0.0.1:${port}/pd` });
  await migrator.connect();
  await migrate(drizzle(migrator), { migrationsFolder: join(repo, 'packages/core/src/db/migrations') });
  await migrator.end();
  await admin.query(`alter role pd_app with login password ${literal(appPassword)}`);
}
await admin.end();

const url = `postgres://pd_app:${encodeURIComponent(appPassword)}@127.0.0.1:${port}/pd`;
writeFileSync(join(root, 'dev-db.json'), JSON.stringify({ databaseUrl: url, port }));
console.log(`READY ${url} (data in ${root})`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => undefined, 60_000);

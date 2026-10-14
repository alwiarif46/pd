import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

const { Pool } = pg;

export type AppDatabase = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let db: AppDatabase | null = null;

/**
 * Returns the shared pool, creating it on first use. `config` only applies on that first
 * call: a connection string, or full pool options (tests use `max: 1`).
 */
export function getPool(config?: string | pg.PoolConfig): pg.Pool {
  if (!pool) {
    const options: pg.PoolConfig = typeof config === 'string' || config === undefined
      ? { connectionString: config || process.env.DATABASE_URL }
      : config;
    pool = new Pool(options);
  }
  return pool;
}

/**
 * A database handle with no `app.org_id`. Under `pd_app` it sees no rows in any tenant table.
 * Use it only for tables without `org_id` (users, sessions, auth tokens, phone codes).
 */
export function getDb(config?: string | pg.PoolConfig): AppDatabase {
  if (!db) {
    db = drizzle(getPool(config), { schema });
  }
  return db;
}

export function closeDb(): Promise<void> {
  const current = pool;
  pool = null;
  db = null;
  if (!current) {
    return Promise.resolve();
  }
  return current.end();
}

export { schema };
export { assertTenantRole, enforceTenantRole, isUuid, userMemberships, withOrg, type UserMembership } from './tenant';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

const { Pool } = pg;

export type AppDatabase = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let db: AppDatabase | null = null;

export function getPool(connectionString?: string): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
    });
  }
  return pool;
}

export function getDb(connectionString?: string): AppDatabase {
  if (!db) {
    db = drizzle(getPool(connectionString), { schema });
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
export { withOrg } from './tenant';

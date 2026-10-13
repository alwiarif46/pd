import { drizzle } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

const { Pool } = pg;

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getDb(connectionString?: string) {
  if (!db) {
    pool = new Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
    });
    db = drizzle(pool, { schema });
  }
  return db;
}

export function closeDb() {
  if (pool) {
    pool.end();
    pool = null;
    db = null;
  }
}

export { schema };

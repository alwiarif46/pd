import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { getPool, type AppDatabase } from './index';

/**
 * Runs `fn` in a transaction whose `app.org_id` setting is local to that
 * transaction (`set_config` third argument `true`). A pooled connection cannot
 * carry one organization's setting into the next request.
 *
 * `getPool` is imported from `./index`, which re-exports this function. The
 * import is only used inside the function, after `./index` has finished loading.
 */
export async function withOrg<T>(
  orgId: string,
  fn: (db: AppDatabase) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.org_id', $1, true)", [orgId]);
    const tx = drizzle(client, { schema });
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be unusable.
    }
    throw error;
  } finally {
    client.release();
  }
}

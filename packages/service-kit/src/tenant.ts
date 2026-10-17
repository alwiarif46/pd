import type { Pool, PoolClient } from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** What `withTenant` needs from a pool: `pg.Pool` fits. */
export type TenantPool = Pick<Pool, 'connect'>;

/**
 * Runs `fn` in a transaction after setting `app.tenant_id` and `app.org_id`, both local to the
 * transaction (`set_config` third argument `true`), so a pooled connection cannot carry one
 * tenant's setting into the next request. Same pattern as `withOrg` in packages/core.
 *
 * 09 s2, PD mapping: PD's `org_id` holds the same UUID as `tenant_id`, so both settings carry the
 * same value until PD's tables rename the column.
 */
export async function withTenant<T>(
  pool: TenantPool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isUuid(tenantId)) {
    throw new Error('withTenant needs a tenant id (uuid)');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.tenant_id', $1, true), set_config('app.org_id', $1, true)", [tenantId]);
    const result = await fn(client);
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

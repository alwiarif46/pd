import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { getPool, type AppDatabase } from './index';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

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
  if (!isUuid(orgId)) {
    throw new Error('withOrg needs an organization id');
  }
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

export interface UserMembership {
  orgId: string;
  role: 'owner' | 'member';
}

/**
 * The organizations a user belongs to, read before `app.org_id` is known.
 * Goes through the `pd_system.user_memberships` SECURITY DEFINER function (migration
 * 0001_tenant_rls), which returns only org ids and roles for one user. Pass only a user id
 * taken from a verified session.
 */
export async function userMemberships(userId: string): Promise<UserMembership[]> {
  if (!isUuid(userId)) {
    return [];
  }
  const result = await getPool().query<{ org_id: string; role: 'owner' | 'member' }>(
    'select org_id, role from pd_system.user_memberships($1)',
    [userId],
  );
  return result.rows.map((row) => ({ orgId: row.org_id, role: row.role }));
}

/**
 * Throws if the connected role skips row-level security (a superuser or a BYPASSRLS role).
 * The api and worker must connect as `pd_app`; any other role defeats tenant isolation.
 */
export async function assertTenantRole(): Promise<void> {
  const result = await getPool().query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user',
  );
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `Database role ${role?.rolname ?? '(unknown)'} skips row-level security. Connect as pd_app.`,
    );
  }
}

/**
 * Startup check for the api and worker: refuses a role that skips row-level security.
 * Only `PD_ALLOW_BYPASS_RLS=1` turns the refusal into a warning (the tests' superuser mode).
 */
export async function enforceTenantRole(warn: (message: string) => void = console.warn): Promise<void> {
  try {
    await assertTenantRole();
  } catch (error) {
    if (process.env.PD_ALLOW_BYPASS_RLS !== '1') {
      throw error;
    }
    warn(`${error instanceof Error ? error.message : String(error)} Allowed by PD_ALLOW_BYPASS_RLS=1.`);
  }
}

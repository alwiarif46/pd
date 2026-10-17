import pg from 'pg';
import { RELAY_ROLE, migrationServices, roleName } from '../src/migrate';

/** Service roles that already have a login password: the tests would reset them. */
export async function serviceRolesInUse(baseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    const names = [...migrationServices().map((s) => roleName(s.schema)), RELAY_ROLE];
    const r = await client.query<{ rolname: string }>(
      'select rolname from pg_authid where rolname = any($1::text[]) and rolcanlogin and rolpassword is not null order by 1',
      [names],
    );
    return r.rows.map((x) => x.rolname);
  } finally {
    await client.end();
  }
}

export function refusalMessage(inUse: ReadonlyArray<string>): string {
  return (
    `[service-kit] REFUSING to run database tests: ${inUse.length} service role(s) already have a login password ` +
    `(${inUse.slice(0, 3).join(', ')}${inUse.length > 3 ? ', ...' : ''}). The tests reset those passwords. ` +
    'Point TEST_DATABASE_URL at a disposable cluster, or set SERVICE_KIT_TEST_RESETS_ROLES=1 if resetting them is fine.'
  );
}

/** What to do about the roles found: run, skip with a warning, or fail the run (CI). */
export function guardDecision(inUse: ReadonlyArray<string>, ci: boolean, optIn: boolean): 'run' | 'skip' | 'fail' {
  if (optIn || inUse.length === 0) return 'run';
  return ci ? 'fail' : 'skip';
}

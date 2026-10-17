import pg from 'pg';

/** Does the role the row-level security tests log in as already exist on the cluster? */
export async function appRoleExists(baseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    return ((await client.query("select 1 from pg_roles where rolname = 'pd_app'")).rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

export interface AppRoleFacts {
  /** pd_app was on the cluster before the run. */
  roleExists: boolean;
  /** TEST_PD_APP_PASSWORD is set. */
  hasPassword: boolean;
  ci: boolean;
}

/**
 * Can the row-level security tests log in as pd_app? When the run creates the role, or knows its
 * password, yes ('run'). Otherwise they cannot: skip them where a person sees it, and fail in CI,
 * where a green run that never exercised row-level security is worse than a red one.
 */
export function appRoleDecision(f: AppRoleFacts): 'run' | 'skip' | 'fail' {
  if (!f.roleExists || f.hasPassword) return 'run';
  return f.ci ? 'fail' : 'skip';
}

export function appRoleSkipMessage(): string {
  return (
    '[testing] role pd_app already exists on the TEST_DATABASE_URL cluster and TEST_PD_APP_PASSWORD is unset: ' +
    'the row-level security tests cannot log in as it. Use a throwaway cluster, or set TEST_PD_APP_PASSWORD to its password.'
  );
}

const IDENT = /^[a-z][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Not a safe identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** What `applyTenantRls` needs: `pg.Pool`, `pg.Client` and `pg.PoolClient` all fit. */
export interface SqlRunner {
  query(sql: string): Promise<unknown>;
}

/**
 * The RLS template for one tenant table (09 s2): ENABLE and FORCE row level security, plus the
 * `tenant_isolation` policy on `app.tenant_id`. FORCE makes the table owner obey the policy too.
 * The statements are idempotent, so a migration can run them again. The text matches the outbox
 * policy in every service's 0001_init.sql (a test compares them).
 *
 * Use it in a migration: paste the output, or call `applyTenantRls` from a script. The table
 * needs a `tenant_id uuid not null` column.
 */
export function tenantRlsSql(schema: string, table: string, column = 'tenant_id'): string {
  const t = `${ident(schema)}.${ident(table)}`;
  ident(column);
  const c = column;
  const check = `${c} = nullif(current_setting('app.tenant_id', true), '')::uuid`;
  return [
    `alter table ${t} enable row level security;`,
    `alter table ${t} force row level security;`,
    `drop policy if exists tenant_isolation on ${t};`,
    `create policy tenant_isolation on ${t} for all using (${check}) with check (${check});`,
  ].join('\n');
}

/** Runs the template. One multi-statement query, so a failure leaves nothing half applied in a transaction. */
export async function applyTenantRls(runner: SqlRunner, schema: string, table: string, column = 'tenant_id'): Promise<void> {
  await runner.query(tenantRlsSql(schema, table, column));
}

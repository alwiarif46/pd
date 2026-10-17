import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queries: Array<{ sql: string; params?: unknown[] }> = [];
let roleRow: { rolname: string; rolsuper: boolean; rolbypassrls: boolean } | undefined;

vi.mock('./index', () => {
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    getPool: () => ({
      connect: async () => client,
      query: async () => ({ rows: roleRow ? [roleRow] : [] }),
    }),
  };
});

const { withOrg, assertTenantRole, enforceTenantRole } = await import('./tenant');

const ORG = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queries.length = 0;
  roleRow = undefined;
});
afterEach(() => {
  delete process.env.PD_ALLOW_BYPASS_RLS;
});

describe('withOrg', () => {
  it('sets app.tenant_id and app.org_id to the same value, local to the transaction', async () => {
    await withOrg(ORG, async () => 1);
    const set = queries.find((q) => q.sql.includes('set_config'));
    expect(set?.sql).toContain("'app.tenant_id'");
    expect(set?.sql).toContain("'app.org_id'");
    expect(set?.sql).toMatch(/\$1, true\).*\$1, true\)/);
    expect(set?.params).toEqual([ORG]);
    expect(queries[0]?.sql).toBe('BEGIN');
    expect(queries.at(-1)?.sql).toBe('COMMIT');
  });

  it('rejects a non-uuid', async () => {
    await expect(withOrg('nope', async () => 1)).rejects.toThrow(/organization id/);
  });
});

describe('assertTenantRole', () => {
  it('accepts pd_app and every per-service <schema>_svc role', async () => {
    for (const name of ['pd_app', 'identity_svc', 'billing_svc', 'notify_svc']) {
      roleRow = { rolname: name, rolsuper: false, rolbypassrls: false };
      await expect(assertTenantRole()).resolves.toBeUndefined();
    }
  });

  it('refuses a superuser or BYPASSRLS role and names both kinds of role in the message', async () => {
    roleRow = { rolname: 'postgres', rolsuper: true, rolbypassrls: true };
    await expect(assertTenantRole()).rejects.toThrow(/skips row-level security.*pd_app.*_svc/);
    roleRow = { rolname: 'outbox_relay', rolsuper: false, rolbypassrls: true };
    await expect(assertTenantRole()).rejects.toThrow(/skips row-level security/);
  });
});

describe('enforceTenantRole', () => {
  it('throws by default and only warns under PD_ALLOW_BYPASS_RLS=1', async () => {
    roleRow = { rolname: 'postgres', rolsuper: true, rolbypassrls: true };
    await expect(enforceTenantRole(() => undefined)).rejects.toThrow(/skips row-level security/);
    process.env.PD_ALLOW_BYPASS_RLS = '1';
    const warn = vi.fn();
    await enforceTenantRole(warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/Allowed by PD_ALLOW_BYPASS_RLS=1/);
  });
});

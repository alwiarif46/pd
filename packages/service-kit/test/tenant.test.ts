import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withTenant } from '../src/index';
import { SKIP_DB, useTestDatabase } from './db-helper';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('withTenant validation', () => {
  it('rejects a non-uuid before touching the pool', async () => {
    const pool = {
      connect: async (): Promise<never> => {
        throw new Error('should not connect');
      },
    };
    await expect(withTenant(pool as never, 'nope', async () => 1)).rejects.toThrow(/tenant id/);
    await expect(withTenant(pool as never, "x'; drop table t; --", async () => 1)).rejects.toThrow(/tenant id/);
  });
});

describe.skipIf(SKIP_DB)('withTenant against Postgres', () => {
  const db = useTestDatabase();

  it('sets app.tenant_id and app.org_id inside the transaction and clears them after', async () => {
    const pool = new pg.Pool({ connectionString: db().roleUrl('billing'), max: 1 });
    try {
      const seen = await withTenant(pool, A, async (c) => {
        const r = await c.query("select current_setting('app.tenant_id') as t, current_setting('app.org_id') as o");
        return r.rows[0] as { t: string; o: string };
      });
      expect(seen).toEqual({ t: A, o: A });
      // Same single connection afterwards: the setting must not leak.
      const after = await pool.query("select nullif(current_setting('app.tenant_id', true), '') as t, nullif(current_setting('app.org_id', true), '') as o");
      expect(after.rows[0]).toEqual({ t: null, o: null });
    } finally {
      await pool.end();
    }
  });

  it('rolls back when fn throws', async () => {
    const pool = new pg.Pool({ connectionString: db().roleUrl('billing'), max: 1 });
    try {
      await expect(
        withTenant(pool, A, async (c) => {
          await c.query(
            'insert into billing.outbox (tenant_id, event_id, type, schema_version, payload) values ($1, gen_random_uuid(), $2, $3, $4)',
            [A, 'billing.test.rolled_back', '1.0', {}],
          );
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const count = await withTenant(pool, A, async (c) => (await c.query('select count(*)::int as n from billing.outbox')).rows[0].n);
      expect(count).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('isolates tenants in the outbox', async () => {
    const pool = new pg.Pool({ connectionString: db().roleUrl('notify') });
    try {
      await withTenant(pool, A, (c) =>
        c.query(
          'insert into notify.outbox (tenant_id, event_id, type, schema_version, payload) values ($1, gen_random_uuid(), $2, $3, $4)',
          [A, 'notification.created', '1.0', { n: 1 }],
        ),
      );
      expect(await withTenant(pool, A, async (c) => (await c.query('select 1 from notify.outbox')).rowCount)).toBe(1);
      expect(await withTenant(pool, B, async (c) => (await c.query('select 1 from notify.outbox')).rowCount)).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createServiceApp, readSchemaMigration } from '../src/index';
import { SKIP_DB, useTestDatabase } from './db-helper';

describe('healthz without a database', () => {
  it('returns the standard shape with schemaMigration "none"', async () => {
    const app = createServiceApp({ id: 'demo', version: '1.2.3' });
    const res = await app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: 'demo', version: '1.2.3', schemaMigration: 'none' });
    await app.close();
  });

  it('registers the service routes next to /healthz', async () => {
    const app = createServiceApp({
      id: 'demo',
      version: '1',
      routes: async (a) => {
        a.get('/ping', async () => ({ pong: true }));
      },
    });
    expect((await app.inject({ url: '/ping' })).json()).toEqual({ pong: true });
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('healthz with a stubbed database', () => {
  it('reads the latest migration id from the service schema', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [{ id: '0002_more.sql' }] };
      },
    };
    const app = createServiceApp({ id: 'billing', version: '1', db: { pool } });
    expect((await app.inject({ url: '/healthz' })).json().schemaMigration).toBe('0002_more.sql');
    expect(queries[0]).toContain('"billing".schema_migrations');
    await app.close();
  });

  it('says "none" for an empty ledger and "unavailable" when the query throws, never a 500', async () => {
    const empty = createServiceApp({ id: 'billing', version: '1', db: { pool: { query: async () => ({ rows: [] }) } } });
    expect((await empty.inject({ url: '/healthz' })).json().schemaMigration).toBe('none');
    const broken = createServiceApp({
      id: 'billing',
      version: '1',
      db: {
        pool: {
          query: async () => {
            throw new Error('connection refused');
          },
        },
      },
    });
    const res = await broken.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().schemaMigration).toBe('unavailable');
  });

  it('is "unavailable" for a service without a schema or an unsafe schema name', async () => {
    const pool = { query: async () => ({ rows: [{ id: 'x' }] }) };
    expect(await readSchemaMigration('gateway', { pool })).toBe('unavailable');
    expect(await readSchemaMigration('x', { pool, schema: 'a"; drop table t; --' })).toBe('unavailable');
  });
});

describe.skipIf(SKIP_DB)('healthz with a real database', () => {
  const db = useTestDatabase();

  it('reports the applied migration through the service role', async () => {
    const pool = new pg.Pool({ connectionString: db().roleUrl('identity') });
    try {
      const app = createServiceApp({ id: 'identity', version: '0.1.0', db: { pool } });
      const res = await app.inject({ url: '/healthz' });
      expect(res.json()).toEqual({ service: 'identity', version: '0.1.0', schemaMigration: '0001_init.sql' });
    } finally {
      await pool.end();
    }
  });

  it('cancels the query on the server at 2 s instead of leaving it running', async () => {
    const pool = new pg.Pool({ connectionString: db().roleUrl('identity'), max: 1 });
    const holder = new pg.Client({ connectionString: db().adminUrl });
    await holder.connect();
    try {
      // A lock the ledger query has to wait for.
      await holder.query('begin');
      await holder.query('lock table identity.schema_migrations in access exclusive mode');
      const started = Date.now();
      expect(await readSchemaMigration('identity', { pool })).toBe('unavailable');
      expect(Date.now() - started).toBeLessThan(3500);
      let waiting = 1;
      for (let i = 0; i < 20 && waiting > 0; i++) {
        const r = await db().admin.query(
          "select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'identity_svc' and state = 'active' and query like '%schema_migrations%'",
          [db().database],
        );
        waiting = r.rows[0].n;
        if (waiting > 0) await new Promise((res) => setTimeout(res, 100));
      }
      expect(waiting, 'the ledger query is still running on the server').toBe(0);
      // The pool is healthy afterwards and its default has no statement timeout.
      expect((await pool.query('show statement_timeout')).rows[0].statement_timeout).toBe('0');
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
      await pool.end();
    }
  });

  it('is "unavailable" when the database is down', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    pool.on('error', () => undefined);
    try {
      const app = createServiceApp({ id: 'identity', version: '1', db: { pool } });
      expect((await app.inject({ url: '/healthz' })).json().schemaMigration).toBe('unavailable');
    } finally {
      await pool.end();
    }
  });
});

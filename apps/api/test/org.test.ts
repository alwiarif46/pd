import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { closeDb, getPool, userMemberships } from '@pd/core';
import { as, createUser } from './helpers.js';

const unavailable = inject('dbUnavailable');

describe.skipIf(Boolean(unavailable))('POST /api/org', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    delete process.env.PD_ALLOW_BYPASS_RLS;
    getPool({ connectionString: inject('appUrl'), max: 4 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  it('creates one organization when two creates for the same user overlap', async () => {
    const user = await createUser('org-race');
    const call = as(app, user.token);
    // Hold the per-user lock from another connection so both requests are provably waiting
    // on it at the same time, then let them go.
    const holder = new pg.Client({ connectionString: inject('appUrl') });
    await holder.connect();
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`org-create:${user.userId}`]);
    const pending = Promise.all([
      call('POST', '/api/org', { name: 'First' }),
      call('POST', '/api/org', { name: 'Second' }),
    ]);
    const deadline = Date.now() + 10_000;
    let waiting = 0;
    while (waiting < 2 && Date.now() < deadline) {
      await holder.query('select pg_stat_clear_snapshot()');
      const result = await holder.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and wait_event = 'advisory'",
      );
      waiting = result.rows[0].n;
    }
    await holder.query('commit');
    await holder.end();
    expect(waiting).toBe(2);
    const results = await pending;
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect(await userMemberships(user.userId)).toHaveLength(1);
  });
});

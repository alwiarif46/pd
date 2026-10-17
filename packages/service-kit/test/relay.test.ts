import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { SERVICES } from '@pd/contracts';
import {
  assertOwnChannel,
  listenOnOutbox,
  notifyOutbox,
  outboxChannel,
  relayAll,
  relayOnce,
  relayTargets,
  streamName,
  type RelayRedis,
} from '../src/relay';
import { withTenant } from '../src/index';
import { SKIP_DB, useTestDatabase } from './db-helper';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

class FakeRedis implements RelayRedis {
  entries: Array<{ stream: string; fields: Record<string, string> }> = [];
  failAfter = Infinity;
  async xadd(stream: string, id: string, ...fields: string[]): Promise<string> {
    if (this.entries.length >= this.failAfter) throw new Error('redis down');
    expect(id).toBe('*');
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
    this.entries.push({ stream, fields: map });
    return `${this.entries.length}-0`;
  }
}

describe('streamName', () => {
  it('joins the stream prefix and the event type', () => {
    expect(streamName('e2e.review', 'red.delivered')).toBe('e2e.review.red.delivered');
  });
  it('does not repeat the service id when the type is the full event name', () => {
    expect(streamName('e2e.review', 'review.red.delivered')).toBe('e2e.review.red.delivered');
  });
});

describe('relayTargets', () => {
  it('maps the contract services that have a schema and a stream prefix', () => {
    const t = relayTargets(SERVICES);
    expect(t).toHaveLength(14);
    expect(t[0]).toEqual({ schema: 'identity', streamPrefix: 'e2e.identity' });
  });
});

describe('outbox channels', () => {
  it('names the channel <schema>_outbox', () => {
    expect(outboxChannel('billing')).toBe('billing_outbox');
  });
  it('accepts a channel with the service\'s own prefix', () => {
    expect(() => assertOwnChannel('billing', 'billing_outbox')).not.toThrow();
    expect(() => assertOwnChannel('billing', 'billing_other_thing')).not.toThrow();
  });
  it('rejects another service\'s channel, a bare schema name and an unsafe name', () => {
    expect(() => assertOwnChannel('billing', 'identity_outbox')).toThrow(/billing_/);
    expect(() => assertOwnChannel('billing', 'billing')).toThrow();
    expect(() => assertOwnChannel('billing', 'billing_x"; drop table t; --')).toThrow();
    expect(() => assertOwnChannel('billing', 'billing_Outbox')).toThrow();
  });
  it('checks the channel before it touches the connection', async () => {
    const client = { query: async (): Promise<never> => { throw new Error('should not query'); } };
    await expect(listenOnOutbox(client as never, 'billing', 'identity_outbox')).rejects.toThrow(/billing_/);
    await expect(notifyOutbox(client as never, 'billing', 'identity_outbox')).rejects.toThrow(/billing_/);
  });
});

describe.skipIf(SKIP_DB)('relayOnce against Postgres', () => {
  const db = useTestDatabase();

  async function insert(schema: string, tenant: string, type: string, n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      await withTenant(db().admin, tenant, (c) =>
        c.query(
          `insert into "${schema}".outbox (tenant_id, event_id, type, schema_version, payload)
           values ($1, gen_random_uuid(), $2, '1.0', $3)`,
          [tenant, type, JSON.stringify({ n: i })],
        ),
      );
    }
  }
  // The owner sees no rows without a tenant, so count as the relay role (which reads all tenants).
  const unpublished = async (schema: string): Promise<number> => {
    const pool = new pg.Pool({ connectionString: db().relayUrl(), max: 1 });
    try {
      return (await pool.query(`select count(*)::int as n from "${schema}".outbox where published_at is null`)).rows[0].n;
    } finally {
      await pool.end();
    }
  };

  function relayPool(): pg.Pool {
    return new pg.Pool({ connectionString: db().relayUrl(), max: 4 });
  }

  it('publishes every tenant\'s rows to <stream_prefix>.<type> and marks them sent', async () => {
    await insert('billing', A, 'credit.reserved');
    await insert('billing', B, 'billing.credit.consumed');
    const pool = relayPool();
    const redis = new FakeRedis();
    try {
      const sent = await relayOnce(pool, redis, { schema: 'billing', streamPrefix: 'e2e.billing' });
      expect(sent).toBe(2);
      expect(redis.entries.map((e) => e.stream).sort()).toEqual(['e2e.billing.credit.consumed', 'e2e.billing.credit.reserved']);
      const first = redis.entries.find((e) => e.fields.tenant_id === A)!;
      expect(Object.keys(first.fields).sort()).toEqual(['event_id', 'occurred_at', 'payload', 'schema_version', 'tenant_id', 'type']);
      expect(JSON.parse(first.fields.payload!)).toEqual({ n: 0 });
      expect(await unpublished('billing')).toBe(0);
      expect(await relayOnce(pool, redis, { schema: 'billing', streamPrefix: 'e2e.billing' })).toBe(0);
      expect(redis.entries).toHaveLength(2);
    } finally {
      await pool.end();
    }
  });

  it('does not double publish when two relays run at once (SKIP LOCKED)', async () => {
    await insert('intel', A, 'shred.done', 12);
    await insert('intel', B, 'shred.done', 12);
    const pool = relayPool();
    const redis = new FakeRedis();
    try {
      const target = { schema: 'intel', streamPrefix: 'e2e.intel' };
      const run = async (): Promise<number> => {
        let total = 0;
        for (let n = await relayOnce(pool, redis, target, { batchSize: 5 }); n > 0; n = await relayOnce(pool, redis, target, { batchSize: 5 })) total += n;
        return total;
      };
      const [x, y] = await Promise.all([run(), run()]);
      expect(x + y).toBe(24);
      expect(redis.entries).toHaveLength(24);
      expect(new Set(redis.entries.map((e) => e.fields.event_id)).size).toBe(24);
      expect(await unpublished('intel')).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('keeps what was sent, leaves the rest unpublished and rethrows when Redis fails', async () => {
    await insert('ingest', A, 'document.ingested', 4);
    const pool = relayPool();
    const redis = new FakeRedis();
    redis.failAfter = 2;
    try {
      await expect(relayOnce(pool, redis, { schema: 'ingest', streamPrefix: 'e2e.ingest' })).rejects.toThrow(/redis down/);
      expect(redis.entries).toHaveLength(2);
      expect(await unpublished('ingest')).toBe(2);
      redis.failAfter = Infinity;
      expect(await relayOnce(pool, redis, { schema: 'ingest', streamPrefix: 'e2e.ingest' })).toBe(2);
      expect(await unpublished('ingest')).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('relayAll drains the batch of each target and reports a count per schema', async () => {
    await insert('notify', A, 'sent', 2);
    await insert('drive', B, 'file.stored', 3);
    const pool = relayPool();
    const redis = new FakeRedis();
    try {
      const counts = await relayAll(pool, redis, [
        { schema: 'notify', streamPrefix: 'e2e.notify' },
        { schema: 'drive', streamPrefix: 'e2e.drive' },
      ]);
      expect(counts).toEqual({ notify: 2, drive: 3 });
    } finally {
      await pool.end();
    }
  });

  it('rejects an unsafe schema name and a bad batch size before querying', async () => {
    const pool = { connect: async (): Promise<never> => { throw new Error('should not connect'); } };
    await expect(relayOnce(pool as never, new FakeRedis(), { schema: 'x"; drop', streamPrefix: 'e2e.x' })).rejects.toThrow(/identifier/);
    await expect(relayOnce(pool as never, new FakeRedis(), { schema: 'billing', streamPrefix: 'e2e.billing' }, { batchSize: 0 })).rejects.toThrow(/batch/);
  });

  it('delivers LISTEN/NOTIFY on the service\'s own channel', async () => {
    const listener = await db().admin.connect();
    try {
      await listenOnOutbox(listener, 'billing');
      const got = new Promise<string>((resolve) => listener.once('notification', (m) => resolve(m.channel)));
      await notifyOutbox(db().admin, 'billing');
      expect(await got).toBe('billing_outbox');
    } finally {
      listener.release();
    }
  });
});

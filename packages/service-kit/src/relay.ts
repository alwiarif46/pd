import type { Pool, PoolClient } from 'pg';

/**
 * The outbox relay (09 s2). It connects as the `outbox_relay` role, the only cross-tenant reader
 * (CLAUDE.md rule 4 exception), so it does not use `withTenant`. It reads unpublished rows, sends
 * each to a Redis Stream with `XADD`, then sets `published_at`. Delivery is at least once: a crash
 * between `XADD` and the commit sends the row again, and consumers dedupe on `event_id`.
 */

const IDENT = /^[a-z][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Not a safe identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** What the relay needs from Redis. ioredis `xadd(key, '*', ...fieldsAndValues)` fits. */
export interface RelayRedis {
  xadd(stream: string, id: '*', ...fieldsAndValues: string[]): Promise<unknown>;
}

export type RelayPool = Pick<Pool, 'connect'>;

export interface RelayTarget {
  /** The service's Postgres schema; its table is `<schema>.outbox`. */
  schema: string;
  /** `stream_prefix` of services.json, for example `e2e.review`. */
  streamPrefix: string;
}

export interface RelayOptions {
  /** Rows claimed per call. Default 100. */
  batchSize?: number;
}

/** Targets for every service of services.json that has a schema and a stream prefix. */
export function relayTargets(
  services: ReadonlyArray<{ schema: string | null; stream_prefix: string | null }>,
): RelayTarget[] {
  return services.flatMap((s) =>
    s.schema !== null && s.stream_prefix !== null ? [{ schema: s.schema, streamPrefix: s.stream_prefix }] : [],
  );
}

/**
 * `<stream_prefix>.<type>`. Event names in the contracts start with the service id
 * (`review.red.delivered`), so an outbox `type` holding the full name does not repeat it:
 * prefix `e2e.review` and type `review.red.delivered` give `e2e.review.red.delivered`.
 */
export function streamName(streamPrefix: string, type: string): string {
  const service = streamPrefix.split('.').pop() ?? streamPrefix;
  return type.startsWith(`${service}.`) ? `${streamPrefix}.${type.slice(service.length + 1)}` : `${streamPrefix}.${type}`;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_id: string;
  type: string;
  schema_version: string;
  payload: unknown;
  occurred_at: Date;
}

/**
 * Publishes one batch for one service. Claims unpublished rows with `FOR UPDATE SKIP LOCKED`, so
 * relays running at once never take the same row. Returns the number of rows sent. If Redis
 * fails part way, the rows already sent stay marked, the rest stay unpublished, and the error
 * is thrown.
 */
export async function relayOnce(
  pool: RelayPool,
  redis: RelayRedis,
  target: RelayTarget,
  options: RelayOptions = {},
): Promise<number> {
  const table = `${ident(target.schema)}.outbox`;
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('relay batch size must be a positive integer');
  const client: PoolClient = await pool.connect();
  const sent: string[] = [];
  let failure: unknown;
  try {
    await client.query('BEGIN');
    const rows = await client.query<OutboxRow>(
      `select id, tenant_id, event_id, type, schema_version, payload, occurred_at
         from ${table} where published_at is null
        order by occurred_at, id limit $1 for update skip locked`,
      [batchSize],
    );
    for (const row of rows.rows) {
      try {
        await redis.xadd(
          streamName(target.streamPrefix, row.type),
          '*',
          'event_id', row.event_id,
          'tenant_id', row.tenant_id,
          'type', row.type,
          'schema_version', row.schema_version,
          'occurred_at', row.occurred_at.toISOString(),
          'payload', JSON.stringify(row.payload),
        );
        sent.push(row.id);
      } catch (error) {
        failure = error;
        break;
      }
    }
    if (sent.length > 0) {
      await client.query(`update ${table} set published_at = now() where id = any($1::uuid[])`, [sent]);
    }
    await client.query('COMMIT');
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
  if (failure !== undefined) throw failure;
  return sent.length;
}

/** One batch for each target, in order. Returns the count sent per schema. */
export async function relayAll(
  pool: RelayPool,
  redis: RelayRedis,
  targets: ReadonlyArray<RelayTarget>,
  options: RelayOptions = {},
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const target of targets) counts[target.schema] = await relayOnce(pool, redis, target, options);
  return counts;
}

/** What the channel helpers need from a connection: `pg.Client`, `pg.PoolClient` and `pg.Pool` fit. */
export interface QueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** The LISTEN/NOTIFY channel a service uses for its outbox: `<schema>_outbox`. */
export function outboxChannel(schema: string): string {
  ident(schema);
  return `${schema}_outbox`;
}

/**
 * Throws unless `channel` starts with `<schema>_` and is a plain lowercase name. Postgres has no
 * ACL on channels, so this is a convention: a service listens and notifies only on its own prefix,
 * and review rejects a channel that does not. The relay may listen on each schema's own channel.
 */
export function assertOwnChannel(schema: string, channel: string): void {
  ident(schema);
  if (!channel.startsWith(`${schema}_`) || !IDENT.test(channel) || channel.length > 63) {
    throw new Error(`Channel ${JSON.stringify(channel)} must start with ${schema}_ and use only a-z, 0-9 and _`);
  }
}

/** `LISTEN` on the service's own channel (default `<schema>_outbox`). */
export async function listenOnOutbox(client: QueryRunner, schema: string, channel = outboxChannel(schema)): Promise<void> {
  assertOwnChannel(schema, channel);
  await client.query(`listen ${ident(channel)}`);
}

/** `NOTIFY` on the service's own channel. Send it after the outbox row commits. */
export async function notifyOutbox(client: QueryRunner, schema: string, channel = outboxChannel(schema)): Promise<void> {
  assertOwnChannel(schema, channel);
  await client.query('select pg_notify($1, $2)', [channel, '']);
}

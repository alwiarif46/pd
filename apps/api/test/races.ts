import pg from 'pg';
import { inject } from 'vitest';

/** Backends of this database (other than the holder) blocked on a lock right now. */
async function lockWaiters(holder: pg.Client): Promise<number> {
  // A short pause between polls, so the loop does not spin on the holder connection.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await holder.query('select pg_stat_clear_snapshot()');
  const result = await holder.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'",
  );
  return result.rows[0].n;
}

/**
 * Holds `sql` (a FOR UPDATE) from a separate pd_app connection with `app.org_id` set, starts the
 * contenders one at a time, each only once every one before it is blocked on a lock (so they
 * queue, and are granted the lock, in the order given), then commits. Returns how many waited and
 * the contenders' settled results.
 */
export async function raceInOrder(orgId: string, sql: string, params: unknown[], contenders: (() => Promise<unknown>)[]) {
  const holder = new pg.Client({ connectionString: inject('appUrl') });
  await holder.connect();
  await holder.query('begin');
  await holder.query("select set_config('app.org_id', $1, true)", [orgId]);
  await holder.query(sql, params);
  const started: Promise<unknown>[] = [];
  let waiting = 0;
  for (const contender of contenders) {
    started.push(contender());
    const deadline = Date.now() + 10_000;
    do {
      waiting = await lockWaiters(holder);
    } while (waiting < started.length && Date.now() < deadline);
  }
  await holder.query('commit');
  await holder.end();
  return { waiting, results: await Promise.allSettled(started) };
}

export function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') {
    throw result.reason;
  }
  return result.value;
}

export type Reply = { statusCode: number; body: string; json: <T>() => T };

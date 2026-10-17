import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadServiceConfig } from './config.js';
import type { ServiceDb } from './app.js';

/** Idle pool clients can fail (server restart, network). Log the error object, never the connection string. */
export function logPoolErrors(
  pool: { on(event: 'error', listener: (err: Error) => void): unknown },
  log: { error(obj: unknown, msg: string): void },
): void {
  pool.on('error', (e) => log.error({ err: e }, 'idle client error'));
}

/**
 * Boots a service: reads its config, opens a pool when `<ID>_DATABASE_URL` is set, builds the
 * app and listens on the configured port. Exits the process on a listen error.
 */
export async function startService(opts: {
  id: string;
  build: (db: ServiceDb | undefined) => FastifyInstance;
}): Promise<FastifyInstance> {
  const config = loadServiceConfig(opts.id);
  const pool = config.databaseUrl ? new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 2000 }) : undefined;
  const app = opts.build(pool ? { pool } : undefined);
  if (pool) logPoolErrors(pool, app.log);
  if (pool) app.addHook('onClose', async () => pool.end());
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`${opts.id} listening on ${config.port}`);
    console.log(`${opts.id} listening on port ${config.port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  return app;
}

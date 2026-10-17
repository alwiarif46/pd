import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadServiceConfig } from './config.js';
import type { ServiceDb } from './app.js';

/**
 * Boots a service: reads its config, opens a pool when `<ID>_DATABASE_URL` is set, builds the
 * app and listens on the configured port. Exits the process on a listen error.
 */
export async function startService(opts: {
  id: string;
  build: (db: ServiceDb | undefined) => FastifyInstance;
}): Promise<FastifyInstance> {
  const config = loadServiceConfig(opts.id);
  const pool = config.databaseUrl ? new pg.Pool({ connectionString: config.databaseUrl }) : undefined;
  const app = opts.build(pool ? { pool } : undefined);
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

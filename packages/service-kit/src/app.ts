import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { SERVICES } from './services-table.js';

/** The only thing healthz needs from a database: `pg.Pool` and `pg.Client` fit. */
export interface Queryable {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ServiceDb {
  pool: Queryable;
  /** The service's own schema. Defaults to the schema listed for `id` in the service table. */
  schema?: string;
}

export interface ServiceAppOptions {
  id: string;
  version: string;
  /** Registered after /healthz. */
  routes?: FastifyPluginAsync;
  db?: ServiceDb;
  logger?: boolean;
}

export interface HealthBody {
  service: string;
  version: string;
  schemaMigration: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const HEALTH_DB_TIMEOUT_MS = 2000;

/**
 * Latest applied migration id from `<schema>.schema_migrations`.
 * "none" when no database is configured, "unavailable" when the query fails or is slow. Never throws.
 */
export async function readSchemaMigration(id: string, db: ServiceDb | undefined): Promise<string> {
  if (!db) return 'none';
  try {
    const schema = db.schema ?? SERVICES[id];
    if (!schema || !IDENT.test(schema)) return 'unavailable';
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), HEALTH_DB_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        db.pool.query(`select id from "${schema}".schema_migrations order by id desc limit 1`),
        timeout,
      ]);
      const latest = result.rows[0]?.id;
      return typeof latest === 'string' ? latest : 'none';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 'unavailable';
  }
}

/** A Fastify app with `GET /healthz` (09 s9.1) and the service's own routes. */
export function createServiceApp(options: ServiceAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  app.get('/healthz', async (): Promise<HealthBody> => ({
    service: options.id,
    version: options.version,
    schemaMigration: await readSchemaMigration(options.id, options.db),
  }));
  if (options.routes) {
    void app.register(options.routes);
  }
  return app;
}

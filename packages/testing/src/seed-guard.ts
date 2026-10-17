import { parse as parseConnectionString } from 'pg-connection-string';

// `pnpm seed` writes rows with fixed ids and can run migrations. It must never point at real data.

export type SeedTargetDecision = { ok: true; reason: string } | { ok: false; message: string };

/** Names that say the database is for tests or local work: a keyword as a whole word at the start, or after `_` or `-`. */
const SAFE_NAME = /^(test|scratch|local|dev)([_-]|$)|[_-](test|scratch|local|dev)([_-]|$)/i;
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|::1)$/i;
/** Query parameters that pg ignores but libpq honors. A URL that sets them is not one we can judge. */
const UNJUDGEABLE_PARAMS = ['hostaddr', 'dbname', 'service', 'servicefile'];

/**
 * The host and database that pg (and so getPool and drizzle) will use. Those come from
 * `pg-connection-string`, not from `new URL`: a `?host=` parameter overrides the authority, and a
 * `socket:` URL takes the database from `?db=`. Anything that does not resolve to one host and one
 * database is an error.
 */
function resolve(url: string): { host: string; name: string } | { error: string } {
  if (!/^(postgres(ql)?|socket):/i.test(url)) return { error: 'the database URL is not a postgres:// or socket: URL' };
  let config: Record<string, string | null | undefined>;
  try {
    config = parseConnectionString(url) as unknown as Record<string, string | null | undefined>;
  } catch {
    return { error: 'the database URL does not parse' };
  }
  const extra = UNJUDGEABLE_PARAMS.filter((k) => k in config);
  if (extra.length > 0) return { error: `the database URL sets ${extra.join(', ')}, which pg and libpq read differently` };
  const host = config.host ?? '';
  const name = config.database ?? '';
  if (host === '') return { error: 'the database URL names no host (PGHOST would decide)' };
  if (host.includes(',')) return { error: 'the database URL lists more than one host' };
  if (name === '') return { error: 'the database URL does not name a database' };
  if (name.includes(',')) return { error: 'the database URL lists more than one database' };
  return { host, name };
}

/**
 * May the seed write to this database? Yes when `allow` equals the database name exactly (the explicit
 * override, PD_SEED_ALLOW). Otherwise the name must not contain `prod`, and either say it is for tests
 * (`SAFE_NAME`: test, scratch, local or dev as a whole word at the start, or after `_` or `-`) or sit on
 * a loopback host or unix socket with a name other than `postgres`. The host and name are the ones pg
 * will use. The message never includes the password.
 */
export function seedTargetDecision(url: string, allow?: string): SeedTargetDecision {
  const target = resolve(url);
  if ('error' in target) return { ok: false, message: `refusing to seed: ${target.error}` };
  const { host, name } = target;
  if (allow !== undefined && allow !== '' && allow === name) return { ok: true, reason: `PD_SEED_ALLOW names ${name}` };

  const where = `database ${JSON.stringify(name)} on host ${JSON.stringify(host)} (the ones pg will use)`;
  const override = `To seed it anyway, set PD_SEED_ALLOW=${name}.`;
  if (/prod/i.test(name)) return { ok: false, message: `refusing to seed ${where}: the name contains "prod". ${override}` };
  if (SAFE_NAME.test(name)) return { ok: true, reason: 'the database name says it is for tests or local work' };
  const local = host.startsWith('/') || LOOPBACK_HOST.test(host);
  if (local && name !== 'postgres') return { ok: true, reason: 'loopback host' };
  const why = local
    ? 'it is the maintenance database'
    : 'the host is not loopback and the name is not a test, dev, local or scratch name';
  return { ok: false, message: `refusing to seed ${where}: ${why}. ${override}` };
}

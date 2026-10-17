// `pnpm seed` writes rows with fixed ids and can run migrations. It must never point at real data.

export type SeedTargetDecision = { ok: true; reason: string } | { ok: false; message: string };

/** Names that say the database is for tests or local work: a keyword at either end, or after an underscore or dash. */
const SAFE_NAME = /^(test|scratch|local|dev)|[_-](test|scratch|local|dev)(?:[_-]|$)|(test|scratch|local|dev)$/i;
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;

function parse(url: string): { host: string; name: string } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname, name: decodeURIComponent(u.pathname.replace(/^\//, '')) };
  } catch {
    return null;
  }
}

/**
 * May the seed write to this database? Yes when `allow` equals the database name exactly (the explicit
 * override, PD_SEED_ALLOW). Otherwise the name must not contain `prod`, and either say it is for tests
 * (`SAFE_NAME`: `_test`, `_dev`, `_local`, `_scratch`, or starting or ending with test, scratch, local,
 * dev) or sit on a loopback host with a name other than `postgres`. The message never includes the password.
 */
export function seedTargetDecision(url: string, allow?: string): SeedTargetDecision {
  const target = parse(url);
  if (!target || target.name === '') {
    return { ok: false, message: 'refusing to seed: the database URL does not name a database' };
  }
  const { host, name } = target;
  if (allow !== undefined && allow !== '' && allow === name) return { ok: true, reason: `PD_SEED_ALLOW names ${name}` };

  const where = `database ${JSON.stringify(name)} on host ${JSON.stringify(host === '' ? '(socket)' : host)}`;
  const override = `To seed it anyway, set PD_SEED_ALLOW=${name}.`;
  if (/prod/i.test(name)) return { ok: false, message: `refusing to seed ${where}: the name contains "prod". ${override}` };
  if (SAFE_NAME.test(name)) return { ok: true, reason: 'the database name says it is for tests or local work' };
  const loopback = host === '' || LOOPBACK_HOST.test(host);
  if (loopback && name !== 'postgres') return { ok: true, reason: 'loopback host' };
  const why = loopback
    ? 'it is the maintenance database'
    : 'the host is not loopback and the name does not end or start with test, dev, local or scratch';
  return { ok: false, message: `refusing to seed ${where}: ${why}. ${override}` };
}

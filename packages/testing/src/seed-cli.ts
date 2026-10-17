import { seedAll } from './seed.js';
import { seedTargetDecision } from './seed-guard.js';

export const SEED_USAGE =
  'usage: PD_ADMIN_DATABASE_URL=postgres://.../pd_dev pnpm seed [--migrate]\n' +
  '  --migrate         apply PD migrations first (idempotent); without it a database with no tables is an error\n' +
  '  PD_SEED_ALLOW=<database name>   seed a database that does not look like a test database';

/** The `pnpm seed` command. Returns the exit code. `env` and `log` are parameters so tests need no process state. */
export async function runSeedCli(argv: string[], env: Record<string, string | undefined>, log: (line: string) => void): Promise<number> {
  const unknown = argv.filter((a) => a !== '--migrate');
  if (unknown.length > 0) {
    log(`seed: unknown argument ${unknown[0]}\n${SEED_USAGE}`);
    return 1;
  }
  const allow = env.PD_SEED_ALLOW;
  let url = env.PD_ADMIN_DATABASE_URL;
  if (!url && env.TEST_DATABASE_URL) {
    // Only a database that passes the guard on its own name; PD_SEED_ALLOW does not widen the fallback.
    const decision = seedTargetDecision(env.TEST_DATABASE_URL);
    if (!decision.ok) {
      log(`seed: TEST_DATABASE_URL is not used as a fallback: ${decision.message}\nSet PD_ADMIN_DATABASE_URL to the database to seed.\n${SEED_USAGE}`);
      return 1;
    }
    url = env.TEST_DATABASE_URL;
  }
  if (!url) {
    log(`seed: set PD_ADMIN_DATABASE_URL to the database to seed.\n${SEED_USAGE}`);
    return 1;
  }
  const decision = seedTargetDecision(url, allow);
  if (!decision.ok) {
    log(`seed: ${decision.message}`);
    return 1;
  }
  try {
    const r = await seedAll(url, log, { migrate: argv.includes('--migrate'), allow });
    log(`seed done: ${r.totals.created} created, ${r.totals.updated} updated, ${r.totals.unchanged} unchanged`);
    return 0;
  } catch (error) {
    log(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

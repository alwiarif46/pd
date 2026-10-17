// pnpm migrate. Reads PD_ADMIN_DATABASE_URL and <SERVICE>_DB_PASSWORD from the environment.
import { applyMigrations, migrationServices } from '../src/migrate.js';

const adminUrl = process.env.PD_ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error('PD_ADMIN_DATABASE_URL is not set (connection string of a role that can create roles and schemas)');
  process.exit(2);
}
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

try {
  const results = await applyMigrations({
    adminUrl,
    services: migrationServices(),
    ...(only.length > 0 ? { only } : {}),
    log: (line) => console.log(line),
  });
  const applied = results.reduce((n, r) => n + r.applied.length, 0);
  console.log(`migrate ok: ${applied} file(s) applied across ${results.length} step(s)`);
} catch (err) {
  console.error(`migrate failed: ${(err as Error).message}`);
  process.exit(1);
}

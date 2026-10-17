import { seedAll } from '../src/seed.js';

const url = process.env.PD_ADMIN_DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('seed: set PD_ADMIN_DATABASE_URL (or TEST_DATABASE_URL) to the database to seed.');
  process.exit(1);
}

seedAll(url, (line) => console.log(line))
  .then((r) => {
    console.log(`seed done: ${r.totals.created} created, ${r.totals.updated} updated, ${r.totals.unchanged} unchanged`);
  })
  .catch((error: unknown) => {
    console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

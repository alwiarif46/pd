/**
 * One-off for amendments applied before the added-rows run (PR #22, migration 0009; 01 s6 has the
 * runbook). Such an amendment closed rows and wrote links, but its own rows were never inserted.
 * apps/worker/src/amendment-backfill.ts has what it writes and what it never changes.
 *
 * Dry run by default (read-only, no model call). Run with the worker's environment (DATABASE_URL
 * as pd_app, AI_PROVIDER and its key):
 *   npx tsx apps/worker/scripts/backfill-amendments.ts --org <uuid> [--org <uuid> ...] [--bid <uuid>] [--limit N] [--apply]
 * The worker image has no scripts/: run it from a checkout at the deployed commit (01 s6).
 * Row-level security shows pd_app one organization at a time, so organizations are named. Exit
 * code 1 on any failure (a read, a model pass or a write; that amendment is left as it was, so
 * run again), 2 on bad arguments.
 */
import { closeDb, enforceTenantRole } from '@pd/core';
import { BACKFILL_USAGE, parseBackfillArgs, runBackfill } from '../src/amendment-backfill.js';

const args = parseBackfillArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(args.error);
  console.error(BACKFILL_USAGE);
  process.exit(2);
}
// The tenant role only: a role that skips row-level security would read across organizations.
await enforceTenantRole();
const report = await runBackfill(args);
await closeDb();
process.exit(report.failed > 0 ? 1 : 0);

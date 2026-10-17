// `pnpm seed`: tenants A and B, one admin each, one bid each, and tenant A's sample RFP documents.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, getTableColumns, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { TENANT_A, TENANT_B, VERIFIED_AT, type TenantFixture } from './fixtures.js';
import { listSampleRfpFiles, sampleDocumentId } from './sample-rfp.js';
import { seedTargetDecision } from './seed-guard.js';

const here = dirname(fileURLToPath(import.meta.url));
/** PD's migrations, the same folder services/gateway/test/global-setup.ts applies. */
export const CORE_MIGRATIONS = join(here, '..', '..', 'core', 'src', 'db', 'migrations');

type Outcome = 'created' | 'updated' | 'unchanged';
type Tx = Parameters<Parameters<typeof withOrg>[1]>[0];

export interface SeedReport {
  migrated: boolean;
  lines: string[];
  /** Counts by outcome across every row the seed wrote or checked. */
  totals: Record<Outcome, number>;
}

/**
 * Insert a row with a fixed id, or update it when a listed column differs. A row that already matches
 * is not touched (not even `updated_at`), so a second run changes nothing.
 */
async function upsert(db: Tx, table: PgTable & { id: unknown }, values: Record<string, unknown>, compare: string[]): Promise<Outcome> {
  const cols = getTableColumns(table) as Record<string, { name: string }>;
  const excluded = (key: string): SQL => sql`excluded.${sql.identifier(cols[key]!.name)}`;
  const set = Object.fromEntries(compare.map((k) => [k, excluded(k)]));
  const left = sql.join(compare.map((k) => sql`${cols[k] as never}`), sql`, `);
  const right = sql.join(compare.map(excluded), sql`, `);
  const rows = await db
    .insert(table)
    .values(values as never)
    .onConflictDoUpdate({ target: cols.id as never, set, setWhere: sql`(${left}) is distinct from (${right})` })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  const row = rows[0];
  return !row ? 'unchanged' : row.inserted ? 'created' : 'updated';
}

async function seedTenant(tenant: TenantFixture, report: SeedReport, withDocuments: boolean): Promise<void> {
  const note = (what: string, outcome: Outcome, count = 1): void => {
    report.totals[outcome] += count;
    report.lines.push(`${tenant.name}: ${what}: ${outcome}`);
  };
  await withOrg(tenant.id, async (db) => {
    note(`user ${tenant.admin.email}`, await upsert(db, schema.users, {
      id: tenant.admin.id,
      email: tenant.admin.email,
      name: tenant.admin.name,
      // Not a usable hash: nobody can sign in with a password. The password code leaves in chat 2.
      passwordHash: 'x:y',
      emailVerifiedAt: VERIFIED_AT,
    }, ['email', 'name', 'passwordHash', 'emailVerifiedAt']));
    note('organization', await upsert(db, schema.organizations, {
      id: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      planStatus: tenant.planStatus,
    }, ['name', 'plan', 'planStatus']));
    note('owner membership', await upsert(db, schema.memberships, {
      id: tenant.membershipId,
      orgId: tenant.id,
      userId: tenant.admin.id,
      role: 'owner',
    }, ['orgId', 'userId', 'role']));
    note(`bid ${tenant.bid.solicitationNumber}`, await upsert(db, schema.bids, {
      id: tenant.bid.id,
      orgId: tenant.id,
      name: tenant.bid.name,
      agency: tenant.bid.agency,
      bidType: tenant.bid.bidType,
      solicitationNumber: tenant.bid.solicitationNumber,
      solicitationKey: tenant.bid.solicitationKey,
    }, ['orgId', 'name', 'agency', 'bidType', 'solicitationNumber', 'solicitationKey']));

    if (!withDocuments) return;
    const counts: Record<Outcome, number> = { created: 0, updated: 0, unchanged: 0 };
    const files = listSampleRfpFiles();
    for (const f of files) {
      // Registered, not processed: storagePath stays null and every status column keeps its default.
      const outcome = await upsert(db, schema.documents, {
        id: sampleDocumentId(tenant.id, f.relPath),
        orgId: tenant.id,
        bidId: tenant.bid.id,
        fileName: f.fileName,
        mime: f.mime,
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
        kind: f.kind,
        amendmentNo: f.amendmentNo,
        // PD records a typed amendment number as 'user'. Other kinds carry no source.
        amendmentNoSource: f.kind === 'amendment' ? 'user' : null,
      }, ['orgId', 'bidId', 'fileName', 'mime', 'sizeBytes', 'sha256', 'kind', 'amendmentNo', 'amendmentNoSource']);
      counts[outcome] += 1;
    }
    for (const outcome of ['created', 'updated', 'unchanged'] as const) {
      if (counts[outcome] > 0) note(`${counts[outcome]} of ${files.length} sample RFP documents`, outcome, counts[outcome]);
    }
  });
}

export interface SeedOptions {
  /** Apply PD's migrations first. Drizzle's journal makes this safe to repeat. Without it the seed never migrates. */
  migrate?: boolean;
  /** The PD_SEED_ALLOW value: the exact database name to seed although it does not look like a test database. */
  allow?: string | undefined;
}

/** Apply PD's migrations (drizzle skips the ones in its journal). */
async function migrateDatabase(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: CORE_MIGRATIONS });
  } finally {
    await client.end();
  }
}

async function requireTables(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const found = await client.query("select to_regclass('public.organizations') as t");
    if (found.rows[0].t === null) {
      throw new Error('the database has no organizations table, so PD migrations have not run. Run the seed again with --migrate to apply them.');
    }
  } finally {
    await client.end();
  }
}

/**
 * Seed both tenants into the database at `adminUrl`. Safe to run again. Refuses a database that does not
 * look like a test database (see seed-guard.ts) unless `options.allow` is its exact name. Never migrates
 * unless `options.migrate` is set; without it an unmigrated database is an error. Every insert runs in
 * `withOrg`, so row-level security applies when `adminUrl` is a login that does not bypass it; as a
 * superuser it is bypassed and the seed still sets `app.org_id`.
 */
export async function seedAll(adminUrl: string, log: (line: string) => void = () => undefined, options: SeedOptions = {}): Promise<SeedReport> {
  const decision = seedTargetDecision(adminUrl, options.allow);
  if (!decision.ok) throw new Error(decision.message);
  const report: SeedReport = { migrated: false, lines: [], totals: { created: 0, updated: 0, unchanged: 0 } };
  if (options.migrate) {
    await migrateDatabase(adminUrl);
    report.migrated = true;
    report.lines.push('applied PD migrations (--migrate; already applied ones are skipped)');
  } else {
    await requireTables(adminUrl);
  }
  getPool(adminUrl);
  try {
    await seedTenant(TENANT_A, report, true);
    await seedTenant(TENANT_B, report, false);
  } finally {
    await closeDb();
  }
  for (const line of report.lines) log(line);
  return report;
}

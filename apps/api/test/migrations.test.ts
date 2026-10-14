/**
 * A database set up by hand with the old rls.sql (policies tenant_select ... on memberships,
 * bids, documents) converges when 0001_tenant_rls runs on top of the baseline.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';

const unavailable = inject('dbUnavailable');
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/core/src/db/migrations');

const OLD_POLICIES = ['memberships', 'bids', 'documents'].flatMap((table) => [
  `CREATE POLICY tenant_select ON ${table} FOR SELECT TO pd_app USING (org_id = current_setting('app.org_id', true)::uuid)`,
  `CREATE POLICY tenant_insert ON ${table} FOR INSERT TO pd_app WITH CHECK (org_id = current_setting('app.org_id', true)::uuid)`,
  `CREATE POLICY tenant_update ON ${table} FOR UPDATE TO pd_app USING (org_id = current_setting('app.org_id', true)::uuid)`,
  `CREATE POLICY tenant_delete ON ${table} FOR DELETE TO pd_app USING (org_id = current_setting('app.org_id', true)::uuid)`,
]);

/** A copy of the migrations folder whose journal lists only the baseline. */
async function baselineOnly(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'pd-migrations-'));
  await mkdir(join(folder, 'meta'));
  await copyFile(join(migrationsFolder, '0000_baseline.sql'), join(folder, '0000_baseline.sql'));
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf-8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.tag === '0000_baseline');
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

describe.skipIf(Boolean(unavailable))('0001_tenant_rls on a hand-built database', () => {
  it('drops the old rls.sql policies and leaves one tenant_isolation policy', async () => {
    const database = `pd_converge_${randomBytes(4).toString('hex')}`;
    const cluster = new pg.Client({ connectionString: inject('clusterUrl') });
    await cluster.connect();
    await cluster.query(`create database "${database}"`);
    const url = new URL(inject('clusterUrl'));
    url.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await migrate(drizzle(client), { migrationsFolder: await baselineOnly() });
      for (const table of ['memberships', 'bids', 'documents']) {
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      }
      for (const statement of OLD_POLICIES) {
        await client.query(statement);
      }
      await migrate(drizzle(client), { migrationsFolder });
      const result = await client.query<{ tablename: string; policyname: string }>(`
        select tablename, policyname from pg_policies
        where tablename in ('memberships', 'bids', 'documents') and 'pd_app' = any (roles)
        order by tablename, policyname
      `);
      expect(result.rows).toEqual([
        { tablename: 'bids', policyname: 'tenant_isolation' },
        { tablename: 'documents', policyname: 'tenant_isolation' },
        { tablename: 'memberships', policyname: 'tenant_isolation' },
      ]);
    } finally {
      await client.end();
      await cluster.query(`drop database if exists "${database}" with (force)`);
      await cluster.end();
    }
  });
});

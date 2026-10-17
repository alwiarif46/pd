/**
 * 0003_credits_and_cascades merges rfp_credits rows that share (org_id, period_start) before it
 * adds the unique index, and points bids at the kept row.
 */
import { randomBytes, randomUUID } from 'node:crypto';
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

/** A copy of the migrations folder whose journal stops before `tag`. */
async function migrationsBefore(tag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'pd-migrations-'));
  await mkdir(join(folder, 'meta'));
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf-8')) as {
    entries: { idx: number; tag: string }[];
  };
  const stop = journal.entries.find((entry) => entry.tag === tag)!.idx;
  journal.entries = journal.entries.filter((entry) => entry.idx < stop);
  for (const entry of journal.entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

describe.skipIf(Boolean(unavailable))('0003_credits_and_cascades on a database with duplicate periods', () => {
  it('merges duplicate rfp_credits rows, repoints bids, and adds the unique index', async () => {
    const database = `pd_dupes_${randomBytes(4).toString('hex')}`;
    // Migrate as a non-superuser owner, as production does: FORCE ROW LEVEL SECURITY hides the
    // rows from it, so this proves the migration lifts FORCE for the merge. Seed as superuser.
    const owner = { name: `pd_owner_${randomBytes(4).toString('hex')}`, password: randomBytes(12).toString('hex') };
    const cluster = new pg.Client({ connectionString: inject('clusterUrl') });
    await cluster.connect();
    await cluster.query(`create role "${owner.name}" login createrole nosuperuser nobypassrls password '${owner.password}'`);
    await cluster.query(`grant pd_system to "${owner.name}" with inherit false, set true`);
    await cluster.query(`create database "${database}" owner "${owner.name}"`);
    const url = new URL(inject('clusterUrl'));
    url.pathname = `/${database}`;
    const ownerUrl = new URL(url.toString());
    ownerUrl.username = owner.name;
    ownerUrl.password = owner.password;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    const migrator = new pg.Client({ connectionString: ownerUrl.toString() });
    await migrator.connect();
    try {
      await migrate(drizzle(migrator), { migrationsFolder: await migrationsBefore('0003_credits_and_cascades') });
      const orgId = randomUUID();
      const start = new Date('2026-09-01T00:00:00Z');
      await client.query("insert into organizations (id, name, plan, plan_status) values ($1, 'Dupes', 'free', 'active')", [orgId]);
      const ids: string[] = [];
      for (const [offset, used, reserved, allowed] of [[0, 1, 0, 2], [1, 0, 1, 1], [2, 1, 0, 1]] as const) {
        const result = await client.query<{ id: string }>(
          `insert into rfp_credits (org_id, period_start, period_end, allowed, used, reserved, created_at)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [orgId, start, new Date('2026-10-01T00:00:00Z'), allowed, used, reserved, new Date(start.getTime() + offset * 1000)],
        );
        ids.push(result.rows[0].id);
      }
      const other = await client.query<{ id: string }>(
        "insert into rfp_credits (org_id, period_start, period_end, allowed) values ($1, '2026-10-01', '2026-11-01', 1) returning id",
        [orgId],
      );
      const bid = await client.query<{ id: string }>(
        `insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key, status, credit_id, credit_status)
         values ($1, 'B', 'sled', 'X', 'X', 'draft', $2, 'reserved') returning id`,
        [orgId, ids[1]],
      );
      const legacy = await client.query<{ id: string }>(
        `insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key, status)
         values ($1, 'L1', 'sled', 'w912-26 r', 'w912-26 r', 'draft'), ($1, 'L2', 'sled', '--', '--', 'draft') returning id`,
        [orgId],
      );

      await migrate(drizzle(migrator), { migrationsFolder });

      const rows = await client.query<{ id: string; used: number; reserved: number; allowed: number }>(
        'select id, used, reserved, allowed from rfp_credits where org_id = $1 order by period_start',
        [orgId],
      );
      expect(rows.rows).toEqual([
        { id: ids[0], used: 2, reserved: 1, allowed: 2 },
        { id: other.rows[0].id, used: 0, reserved: 0, allowed: 1 },
      ]);
      const bidRow = await client.query<{ credit_id: string }>('select credit_id from bids where id = $1', [bid.rows[0].id]);
      expect(bidRow.rows[0].credit_id).toBe(ids[0]);
      const keys = await client.query<{ solicitation_key: string }>(
        'select solicitation_key from bids where id = any($1) order by name',
        [legacy.rows.map((row) => row.id)],
      );
      expect(keys.rows.map((row) => row.solicitation_key)).toEqual(['W91226R', 'PENDING']);
      const forced = await client.query<{ relname: string; relforcerowsecurity: boolean }>(
        "select relname, relforcerowsecurity from pg_class where relname in ('rfp_credits', 'bids', 'upload_sessions') order by relname",
      );
      expect(forced.rows.every((row) => row.relforcerowsecurity)).toBe(true);
      await expect(client.query(
        'insert into rfp_credits (org_id, period_start, period_end, allowed) values ($1, $2, $3, 1)',
        [orgId, start, new Date('2026-10-01T00:00:00Z')],
      )).rejects.toThrow(/rfp_credits_org_period_uq/);
    } finally {
      await client.end();
      await migrator.end();
      await cluster.query(`drop database if exists "${database}" with (force)`);
      await cluster.query(`drop owned by "${owner.name}" cascade`).catch(() => undefined);
      await cluster.query(`drop role if exists "${owner.name}"`).catch(() => undefined);
      await cluster.end();
    }
  });
});

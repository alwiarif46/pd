/**
 * 0006_tab_rows backfills legacy tab values, run as a non-superuser owner the way production
 * migrates: FORCE ROW LEVEL SECURITY hides tenant rows from that owner, so this proves the
 * migration lifts FORCE around each update and puts it back.
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
  const stop = journal.entries.findIndex((entry) => entry.tag === tag);
  journal.entries = journal.entries.slice(0, stop);
  for (const entry of journal.entries) {
    await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

describe.skipIf(Boolean(unavailable))('0006_tab_rows on a database with legacy tab values', () => {
  it('backfills statuses, positions, categories, origins and AI results, and keeps RLS forced', async () => {
    const database = `pd_tabrows_${randomBytes(4).toString('hex')}`;
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
      await migrate(drizzle(migrator), { migrationsFolder: await migrationsBefore('0006_tab_rows') });
      const orgId = randomUUID();
      await client.query("insert into organizations (id, name, plan, plan_status) values ($1, 'Legacy', 'free', 'active')", [orgId]);
      const bid = (await client.query<{ id: string }>(
        `insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key, status)
         values ($1, 'B', 'sled', 'X', 'X', 'planning') returning id`,
        [orgId],
      )).rows[0].id;
      const insert = async (sql: string, params: unknown[]) => (await client.query<{ id: string }>(sql, params)).rows.map((row) => row.id);

      const compliance = await insert(
        `insert into compliance_rows (org_id, bid_id, req_id, requirement_text, status) values
         ($1, $2, 'a', 'x', null), ($1, $2, 'b', 'x', 'Done'), ($1, $2, 'c', 'x', 'weird'), ($1, $2, 'd', 'x', 'assigned')
         returning id`, [orgId, bid]);
      const volume = (await insert(
        `insert into outline_items (org_id, bid_id, title, number, status) values ($1, $2, 'Vol', '1', 'not started') returning id`,
        [orgId, bid]))[0];
      const sections = await insert(
        `insert into outline_items (org_id, bid_id, parent_id, title, number, status, created_at) values
         ($1, $2, $3, 'Ten', '1.10', 'in progress', now()),
         ($1, $2, $3, 'Two', '1.2', null, now() - interval '1 day'),
         ($1, $2, $3, 'Unnumbered', null, 'review', now() - interval '2 days')
         returning id`, [orgId, bid, volume]);
      const reviews = await insert(
        `insert into reviews (org_id, bid_id, type, status) values ($1, $2, 'red', 'open'), ($1, $2, 'pink', null), ($1, $2, 'gold', 'done')
         returning id`, [orgId, bid]);
      const findings = await insert(
        `insert into review_findings (org_id, review_id, kind, text, disposition) values
         ($1, $2, 'risk', 'x', null), ($1, $2, 'risk', 'x', 'accept'), ($1, $2, 'risk', 'x', 'Rejected')
         returning id`, [orgId, reviews[0]]);
      const requirement = (await insert(
        "insert into personnel_requirements (org_id, bid_id, role, requirement) values ($1, $2, 'PM', 'PMP') returning id", [orgId, bid]))[0];
      const candidate = (await insert(
        "insert into candidates (org_id, bid_id, name, role) values ($1, $2, 'Pat', 'PM') returning id", [orgId, bid]))[0];
      const matches = await insert(
        `insert into resume_matches (org_id, candidate_id, requirement_id, result, reviewer_override) values
         ($1, $2, $3, 'partial', false), ($1, $2, $3, 'meets', true),
         ($1, $2, $3, ' Gap ', false), ($1, $2, $3, 'maybe', false) returning id`, [orgId, candidate, requirement]);
      const production = await insert(
        `insert into production_items (org_id, bid_id, category, rule, origin) values
         ($1, $2, 'Fonts', 'Confirm the required font and size', 'user'),
         ($1, $2, 'Portal', 'Confirm the submission portal and deadline', 'user'),
         ($1, $2, 'Fonts', 'Use 12 point Times', 'user'),
         ($1, $2, 'Binding', 'Comb bound', 'ai')
         returning id`, [orgId, bid]);
      const orals = await insert(
        `insert into orals_items (org_id, bid_id, category, item, origin) values
         ($1, $2, 'Rules', 'Orals format from the solicitation', 'user'),
         ($1, $2, 'Checklist', 'Bring badges', 'user'),
         ($1, $2, 'Venue', 'Room 4', 'user')
         returning id`, [orgId, bid]);

      await migrate(drizzle(migrator), { migrationsFolder });

      const values = async (table: string, column: string, ids: string[]) => {
        const result = await client.query<Record<string, unknown>>(`select id, ${column} as value from ${table} where id = any($1)`, [ids]);
        const byId = new Map(result.rows.map((row) => [row.id, row.value]));
        return ids.map((id) => byId.get(id));
      };
      expect(await values('compliance_rows', 'status', compliance)).toEqual(['open', 'done', 'open', 'assigned']);
      expect(await values('outline_items', 'status', [volume, ...sections])).toEqual(['not_started', 'in_progress', 'not_started', 'review']);
      // Numeric order (1.2 before 1.10), unnumbered last.
      expect(await values('outline_items', 'position', [volume, ...sections])).toEqual([0, 1, 0, 2]);
      expect(await values('reviews', 'status', reviews)).toEqual(['planned', 'planned', 'done']);
      expect(await values('review_findings', 'disposition', findings)).toEqual(['open', 'accepted', 'rejected']);
      // An odd legacy result neither aborts the migration nor becomes an AI result.
      expect(await values('resume_matches', 'ai_result', matches)).toEqual(['partial', null, 'gap', null]);
      expect(await values('production_items', 'category', production)).toEqual(['format', 'submission', 'format', 'other']);
      expect(await values('production_items', 'origin', production)).toEqual(['standard', 'standard', 'user', 'ai']);
      expect(await values('orals_items', 'category', orals)).toEqual(['rules', 'prep', 'prep']);
      expect(await values('orals_items', 'origin', orals)).toEqual(['standard', 'user', 'user']);

      await expect(client.query("update compliance_rows set status = 'started' where id = $1", [compliance[0]])).rejects.toThrow(/compliance_rows_status_check/);
      await expect(client.query('update orals_items set minutes = -1 where id = $1', [orals[0]])).rejects.toThrow(/orals_items_minutes_check/);
      await expect(client.query("update production_items set category = 'Fonts' where id = $1", [production[0]])).rejects.toThrow(/production_items_category_check/);
      await expect(client.query("update orals_items set category = 'other' where id = $1", [orals[0]])).rejects.toThrow(/orals_items_category_check/);
      await expect(client.query("update review_findings set disposition = null where id = $1", [findings[0]])).rejects.toThrow(/null value/);

      const forced = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
        select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relname in ('compliance_rows', 'outline_items', 'resume_matches', 'reviews', 'review_findings',
          'production_items', 'orals_items', 'check_these') and relnamespace = 'public'::regnamespace`);
      expect(forced.rows).toHaveLength(8);
      for (const row of forced.rows) {
        expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      }
      const policy = await client.query("select 1 from pg_policies where tablename = 'check_these' and policyname = 'tenant_isolation' and 'pd_app' = any (roles)");
      expect(policy.rowCount).toBe(1);
      const grants = await client.query<{ privilege_type: string }>(
        "select privilege_type from information_schema.role_table_grants where table_name = 'check_these' and grantee = 'pd_app' order by 1");
      expect(grants.rows.map((row) => row.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
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

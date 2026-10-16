/**
 * 0011_amendment_tabs adds bid_facts.fact_key (backfilled from the field with the rules of
 * factKeyOf in packages/core), schedule_activities.date_key (not backfilled), amendments.
 * tabs_status, their CHECKs, and the (bid_id, key) indexes. Migrated as a non-superuser owner, as
 * production does.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACT_KEY_SPELLINGS, factKeyOf } from '@pd/core';
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

/** Fields whose SQL backfill must agree with factKeyOf: every spelling, odd cases, and others. */
const FIELDS = [
  ...FACT_KEY_SPELLINGS.map(([spelling]) => spelling),
  'Agency', 'solicitationNumber', 'Solicitation Number', 'solicitation_number', 'NAICS code', 'set-aside', 'Set Aside',
  'contractType', 'periodOfPerformance', 'placeOfPerformance', 'submissionMethod', 'contractingOfficer', 'CO',
  'bidType', 'dueDate', 'dueTime', 'timeZone', 'Lunch', '', '  agency  ', 'agency2',
];

describe.skipIf(Boolean(unavailable))('0011_amendment_tabs on a database with facts and dates', () => {
  it('backfills fact_key, adds date_key and tabs_status, the CHECKs, and the indexes', async () => {
    const database = `pd_amdtabs_${randomBytes(4).toString('hex')}`;
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
      await migrate(drizzle(migrator), { migrationsFolder: await migrationsBefore('0011_amendment_tabs') });
      const orgId = randomUUID();
      await client.query("insert into organizations (id, name, plan, plan_status) values ($1, 'Tabs', 'free', 'free')", [orgId]);
      const [{ id: bidId }] = (await client.query<{ id: string }>(
        `insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key, status)
         values ($1, 'B', 'sled', 'X-1', 'X1', 'planning') returning id`,
        [orgId],
      )).rows;
      const [{ id: documentId }] = (await client.query<{ id: string }>(
        `insert into documents (org_id, bid_id, file_name, mime, size_bytes, sha256, kind)
         values ($1, $2, 'amd.pdf', 'application/pdf', 1, 'abc', 'amendment') returning id`,
        [orgId, bidId],
      )).rows;
      const facts = new Map<string, string>();
      for (const field of FIELDS) {
        const [{ id }] = (await client.query<{ id: string }>(
          "insert into bid_facts (org_id, bid_id, field, value) values ($1, $2, $3, 'v') returning id",
          [orgId, bidId, field],
        )).rows;
        facts.set(id, field);
      }
      const [{ id: activityId }] = (await client.query<{ id: string }>(
        "insert into schedule_activities (org_id, bid_id, label, origin) values ($1, $2, 'Date from solicitation', 'ai') returning id",
        [orgId, bidId],
      )).rows;
      const [{ id: amendmentId }] = (await client.query<{ id: string }>(
        `insert into amendments (org_id, bid_id, document_id, solicitation_key_found, status)
         values ($1, $2, $3, true, 'applied') returning id`,
        [orgId, bidId, documentId],
      )).rows;

      await migrate(drizzle(migrator), { migrationsFolder });

      const keys = new Map((await client.query<{ id: string; fact_key: string }>(
        'select id, fact_key from bid_facts where org_id = $1', [orgId],
      )).rows.map((row) => [row.id, row.fact_key]));
      for (const [id, field] of facts) {
        expect(keys.get(id), JSON.stringify(field)).toBe(factKeyOf(field));
      }
      expect([...keys.values()].filter((key) => key !== 'other').length).toBeGreaterThan(FACT_KEY_SPELLINGS.length);
      expect((await client.query('select date_key from schedule_activities where id = $1', [activityId])).rows[0])
        .toEqual({ date_key: 'other' });
      expect((await client.query('select tabs_status from amendments where id = $1', [amendmentId])).rows[0])
        .toEqual({ tabs_status: null });

      const refused = async (sql: string, params: unknown[], constraint: string) => {
        await expect(client.query(sql, params)).rejects.toMatchObject({ code: '23514', constraint });
      };
      const [factId] = facts.keys();
      await refused('update bid_facts set fact_key = $2 where id = $1', [factId, 'due_date'], 'bid_facts_fact_key_check');
      await refused('update schedule_activities set date_key = $2 where id = $1', [activityId, 'due'], 'schedule_activities_date_key_check');
      await refused('update amendments set tabs_status = $2 where id = $1', [amendmentId, 'done'], 'amendments_tabs_status_check');
      await client.query("update bid_facts set fact_key = 'pop' where id = $1", [factId]);
      await client.query("update schedule_activities set date_key = 'proposal_due' where id = $1", [activityId]);
      await client.query("update amendments set tabs_status = 'pending' where id = $1", [amendmentId]);
      await expect(client.query('update bid_facts set fact_key = null where id = $1', [factId])).rejects.toMatchObject({ code: '23502' });

      const indexes = (await client.query<{ indexname: string; indexdef: string }>(
        "select indexname, indexdef from pg_indexes where indexname in ('bid_facts_bid_id_fact_key_idx', 'schedule_activities_bid_id_date_key_idx') order by indexname",
      )).rows;
      expect(indexes.map((row) => row.indexname)).toEqual(['bid_facts_bid_id_fact_key_idx', 'schedule_activities_bid_id_date_key_idx']);
      expect(indexes[0].indexdef).toContain('(bid_id, fact_key)');
      expect(indexes[1].indexdef).toContain('(bid_id, date_key)');

      const force = (await client.query<{ relforcerowsecurity: boolean }>(
        "select relforcerowsecurity from pg_class where relname = 'bid_facts'",
      )).rows[0];
      expect(force.relforcerowsecurity).toBe(true);
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

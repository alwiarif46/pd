/**
 * 0008_amendment_key_check dedupes amendments rows per document (an overridden row first, then
 * the latest; links cascade), maps statuses onto the new CHECK, and adds the key_status CHECK and
 * the unique index. Migrated as a non-superuser owner, as production does.
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

describe.skipIf(Boolean(unavailable))('0008_amendment_key_check on a database with duplicate amendments', () => {
  it('dedupes amendments, cascades their links, maps statuses, and adds the CHECKs and the unique index', async () => {
    const database = `pd_amendkey_${randomBytes(4).toString('hex')}`;
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
      await migrate(drizzle(migrator), { migrationsFolder: await migrationsBefore('0008_amendment_key_check') });
      const orgId = randomUUID();
      await client.query("insert into organizations (id, name, plan, plan_status) values ($1, 'Amend', 'free', 'free')", [orgId]);
      const bid = (await client.query<{ id: string }>(
        `insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key, status)
         values ($1, 'B', 'sled', 'X-1', 'X1', 'planning') returning id`,
        [orgId],
      )).rows[0].id;
      const document = async () => (await client.query<{ id: string }>(
        `insert into documents (org_id, bid_id, file_name, mime, size_bytes, sha256, kind)
         values ($1, $2, 'a.pdf', 'application/pdf', 1, $3, 'amendment') returning id`,
        [orgId, bid, randomUUID()],
      )).rows[0].id;
      const amendment = async (documentId: string, values: { override?: boolean; found?: boolean; status: string; at: string }) => {
        const id = (await client.query<{ id: string }>(
          `insert into amendments (org_id, bid_id, document_id, amendment_no, solicitation_key_found, key_override, status, created_at)
           values ($1, $2, $3, 1, $4, $5, $6, $7) returning id`,
          [orgId, bid, documentId, values.found ?? false, values.override ?? false, values.status, values.at],
        )).rows[0].id;
        await client.query(
          `insert into amendment_links (org_id, amendment_id, row_table, action, status)
           values ($1, $2, 'compliance_rows', 'add', 'auto')`,
          [orgId, id],
        );
        return id;
      };
      // Document 1: the overridden row is older than the others and is kept.
      const one = await document();
      const overridden = await amendment(one, { override: true, status: 'processing', at: '2026-10-01' });
      await amendment(one, { status: 'processing', at: '2026-10-02' });
      await amendment(one, { found: true, status: 'applied', at: '2026-10-03' });
      // Document 2: no override; the latest is kept.
      const two = await document();
      await amendment(two, { found: true, status: 'applied', at: '2026-10-01' });
      const latest = await amendment(two, { found: true, status: 'needs_confirmation', at: '2026-10-05' });
      // Documents 3 to 5: one row each, statuses mapped.
      const unknownFound = await amendment(await document(), { found: true, status: 'queued', at: '2026-10-01' });
      const unknownMissing = await amendment(await document(), { status: 'queued', at: '2026-10-01' });
      const stuck = await amendment(await document(), { status: 'processing', at: '2026-10-01' });

      await migrate(drizzle(migrator), { migrationsFolder });

      const rows = await client.query<{ id: string; status: string }>('select id, status from amendments where org_id = $1', [orgId]);
      const byId = new Map(rows.rows.map((row) => [row.id, row.status]));
      expect(rows.rows).toHaveLength(5);
      expect(byId.get(overridden)).toBe('processing');
      expect(byId.get(latest)).toBe('needs_confirmation');
      expect(byId.get(unknownFound)).toBe('processing');
      expect(byId.get(unknownMissing)).toBe('held');
      expect(byId.get(stuck)).toBe('held');
      const links = await client.query<{ amendment_id: string }>('select amendment_id from amendment_links where org_id = $1', [orgId]);
      expect(links.rows.map((row) => row.amendment_id).sort()).toEqual([...byId.keys()].sort());

      const forced = await client.query<{ relforcerowsecurity: boolean }>("select relforcerowsecurity from pg_class where relname = 'amendments'");
      expect(forced.rows[0].relforcerowsecurity).toBe(true);
      const timeout = await migrator.query<{ lock_timeout: string }>('show lock_timeout');
      expect(timeout.rows[0].lock_timeout).toBe('0');

      await expect(client.query(
        `insert into amendments (org_id, bid_id, document_id, amendment_no, solicitation_key_found, status)
         values ($1, $2, $3, 2, true, 'processing')`,
        [orgId, bid, one],
      )).rejects.toThrow(/amendments_document_uq/);
      await expect(client.query("update amendments set status = 'queued' where id = $1", [overridden]))
        .rejects.toThrow(/amendments_status_check/);
      await expect(client.query("update documents set key_status = 'maybe' where id = $1", [one]))
        .rejects.toThrow(/documents_key_status_check/);
      await client.query("update documents set key_status = 'bid_key_pending', key_found = 'X-1' where id = $1", [one]);
      await client.query("update amendments set matched_key = 'X1', status = 'held' where id = $1", [overridden]);
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

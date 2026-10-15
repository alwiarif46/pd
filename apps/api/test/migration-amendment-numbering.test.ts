/**
 * 0009_amendment_numbering numbers each bid's amendment documents by created_at (source
 * 'sequence'; deleted ones only when their amendment wrote rows), mirrors the number to
 * amendments, sets changed_by_amendment from auto and confirmed links, seeds the link confidence
 * setting, and adds the CHECKs and the partial unique index. Migrated as a non-superuser owner,
 * as production does.
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

describe.skipIf(Boolean(unavailable))('0009_amendment_numbering on a database with amendments', () => {
  it('backfills numbers and changed_by_amendment, seeds the setting, and adds the CHECKs and the unique index', async () => {
    const database = `pd_amendno_${randomBytes(4).toString('hex')}`;
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
      await migrate(drizzle(migrator), { migrationsFolder: await migrationsBefore('0009_amendment_numbering') });
      const orgId = randomUUID();
      await client.query("insert into organizations (id, name, plan, plan_status) values ($1, 'Amend', 'free', 'free')", [orgId]);
      const bid = async () => (await client.query<{ id: string }>(
        `insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key, status)
         values ($1, 'B', 'sled', 'X-1', 'X1', 'planning') returning id`,
        [orgId],
      )).rows[0].id;
      const document = async (bidId: string, kind: string, at: string, live = 'live') => (await client.query<{ id: string }>(
        `insert into documents (org_id, bid_id, file_name, mime, size_bytes, sha256, kind, live_status, created_at)
         values ($1, $2, 'a.pdf', 'application/pdf', 1, $3, $4, $5, $6) returning id`,
        [orgId, bidId, randomUUID(), kind, live, at],
      )).rows[0].id;
      const amendment = async (bidId: string, documentId: string, status: string) => (await client.query<{ id: string }>(
        `insert into amendments (org_id, bid_id, document_id, amendment_no, solicitation_key_found, status)
         values ($1, $2, $3, 1, true, $4) returning id`,
        [orgId, bidId, documentId, status],
      )).rows[0].id;
      const row = async (bidId: string, status: string) => (await client.query<{ id: string }>(
        `insert into compliance_rows (org_id, bid_id, req_id, requirement_text, supersede_status)
         values ($1, $2, 'C-01', 'x', $3) returning id`,
        [orgId, bidId, status],
      )).rows[0].id;
      const link = (amendmentId: string, oldRowId: string, action: string, status: string) => client.query(
        `insert into amendment_links (org_id, amendment_id, row_table, old_row_id, action, status)
         values ($1, $2, 'compliance_rows', $3, $4, $5)`,
        [orgId, amendmentId, oldRowId, action, status],
      );

      // Bid one: three amendments by date, one deleted that wrote rows, one deleted that did not,
      // a solicitation (never numbered).
      const one = await bid();
      const solicitation = await document(one, 'solicitation', '2026-10-01');
      const first = await document(one, 'amendment', '2026-10-02');
      const deletedApplied = await document(one, 'amendment', '2026-10-03', 'deleted');
      const deletedUnapplied = await document(one, 'amendment', '2026-10-04', 'deleted');
      const third = await document(one, 'amendment', '2026-10-05');
      const amendFirst = await amendment(one, first, 'applied');
      const amendDeleted = await amendment(one, deletedApplied, 'applied');
      await amendment(one, deletedUnapplied, 'processing');
      const amendThird = await amendment(one, third, 'needs_confirmation');
      const supersededByFirst = await row(one, 'superseded');
      const withdrawnByDeleted = await row(one, 'withdrawn');
      const confirmedByThird = await row(one, 'superseded');
      const proposedOnly = await row(one, 'active');
      await link(amendFirst, supersededByFirst, 'supersede', 'auto');
      await link(amendDeleted, withdrawnByDeleted, 'withdraw', 'auto');
      await link(amendThird, confirmedByThird, 'supersede', 'confirmed');
      await link(amendThird, proposedOnly, 'withdraw', 'proposed');
      // Bid two: numbering restarts at 1.
      const two = await bid();
      const other = await document(two, 'amendment', '2026-09-01');
      await client.query("insert into app_settings (key, value) values ('kept', '1')");

      await migrate(drizzle(migrator), { migrationsFolder });

      const numbers = new Map((await client.query<{ id: string; amendment_no: number | null; amendment_no_source: string | null }>(
        'select id, amendment_no, amendment_no_source from documents where org_id = $1', [orgId],
      )).rows.map((item) => [item.id, [item.amendment_no, item.amendment_no_source]]));
      expect(numbers.get(solicitation)).toEqual([null, null]);
      expect(numbers.get(first)).toEqual([1, 'sequence']);
      expect(numbers.get(deletedApplied)).toEqual([2, 'sequence']);
      expect(numbers.get(deletedUnapplied)).toEqual([null, null]);
      expect(numbers.get(third)).toEqual([3, 'sequence']);
      expect(numbers.get(other)).toEqual([1, 'sequence']);
      const mirrored = new Map((await client.query<{ document_id: string; amendment_no: number | null }>(
        'select document_id, amendment_no from amendments where org_id = $1', [orgId],
      )).rows.map((item) => [item.document_id, item.amendment_no]));
      expect(mirrored.get(first)).toBe(1);
      expect(mirrored.get(deletedApplied)).toBe(2);
      expect(mirrored.get(deletedUnapplied)).toBeNull();
      expect(mirrored.get(third)).toBe(3);
      const changed = new Map((await client.query<{ id: string; changed_by_amendment: number | null }>(
        'select id, changed_by_amendment from compliance_rows where org_id = $1', [orgId],
      )).rows.map((item) => [item.id, item.changed_by_amendment]));
      expect(changed.get(supersededByFirst)).toBe(1);
      expect(changed.get(withdrawnByDeleted)).toBe(2);
      expect(changed.get(confirmedByThird)).toBe(3);
      expect(changed.get(proposedOnly)).toBeNull();

      const settings = await client.query<{ key: string; value: string }>("select key, value from app_settings where key in ('amendment_link_confidence', 'kept') order by key");
      expect(settings.rows).toEqual([{ key: 'amendment_link_confidence', value: '0.80' }, { key: 'kept', value: '1' }]);
      const forced = await client.query<{ relname: string; relforcerowsecurity: boolean }>(
        "select relname, relforcerowsecurity from pg_class where relname in ('documents', 'amendments', 'amendment_links', 'compliance_rows')",
      );
      expect(forced.rows.every((item) => item.relforcerowsecurity)).toBe(true);
      expect(forced.rows).toHaveLength(4);
      const timeout = await migrator.query<{ lock_timeout: string }>('show lock_timeout');
      expect(timeout.rows[0].lock_timeout).toBe('0');

      // CHECKs.
      await expect(client.query('update documents set amendment_no = 0 where id = $1', [first])).rejects.toThrow(/documents_amendment_no_check/);
      await expect(client.query('update documents set amendment_no = 1000 where id = $1', [first])).rejects.toThrow(/documents_amendment_no_check/);
      await expect(client.query("update documents set amendment_no_source = 'guess' where id = $1", [first])).rejects.toThrow(/documents_amendment_no_source_check/);
      await expect(client.query("update amendments set status = 'queued' where id = $1", [amendFirst])).rejects.toThrow(/amendments_status_check/);
      await client.query("update amendments set status = 'needs_number', amendment_no = null where id = $1", [amendThird]);
      await client.query("update amendments set status = 'failed' where id = $1", [amendThird]);
      const userId = (await client.query<{ id: string }>(
        "insert into users (email, password_hash) values ($1, 'x:y') returning id", [`${randomUUID()}@example.com`],
      )).rows[0].id;
      const session = (amendmentNo: number) => client.query(
        `insert into upload_sessions (org_id, bid_id, user_id, file_name, kind, declared_size, sha256, chunk_count, status, expires_at, amendment_no)
         values ($1, $2, $3, 'a', 'amendment', 1, 'x', 1, 'open', now(), $4)`,
        [orgId, one, userId, amendmentNo],
      );
      await expect(session(1000)).rejects.toThrow(/upload_sessions_amendment_no_check/);
      await session(999);
      // The partial unique index: two live amendments cannot share a number; a deleted one can.
      await expect(client.query('update documents set amendment_no = 1 where id = $1', [third])).rejects.toThrow(/documents_bid_amendment_no_uq/);
      await client.query('update documents set amendment_no = 1 where id = $1', [deletedUnapplied]);
      await client.query("update documents set amendment_no = 9, kind = 'amendment' where id = $1", [other]);
      const indexes = await client.query<{ indexname: string }>(
        "select indexname from pg_indexes where indexname in ('amendment_links_amendment_id_idx', 'amendment_links_old_row_id_idx', 'amendment_links_new_row_id_idx', 'compliance_rows_bid_id_req_id_idx', 'documents_bid_amendment_no_uq')",
      );
      expect(indexes.rows).toHaveLength(5);
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

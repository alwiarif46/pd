/**
 * 0005_documents_and_bids rewrites bid statuses to the four values and moves documents the old
 * restore endpoint left in 'restoring' to 'restore_requested', run as a non-superuser owner
 * (FORCE ROW LEVEL SECURITY hides tenant rows from it unless the migration lifts FORCE).
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

describe.skipIf(Boolean(unavailable))('0005_documents_and_bids on a database with old rows', () => {
  it('maps bid statuses, adds the CHECK, and moves pending restores to restore_requested', async () => {
    const database = `pd_0005_${randomBytes(4).toString('hex')}`;
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
      await migrate(drizzle(migrator), { migrationsFolder: await migrationsBefore('0005_documents_and_bids') });
      // Seed as superuser.
      const orgId = randomUUID();
      await client.query("insert into organizations (id, name, plan, plan_status) values ($1, 'Old', 'free', 'active')", [orgId]);
      const bids = await client.query<{ id: string; name: string }>(
        `insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key, status) values
           ($1, 'draft', 'sled', 'X', 'X', 'draft'),
           ($1, 'active', 'sled', 'X', 'X', 'active'),
           ($1, 'writing', 'sled', 'X', 'X', 'writing'),
           ($1, 'closed', 'sled', 'X', 'X', 'closed')
         returning id, name`,
        [orgId],
      );
      const bidId = bids.rows[0].id;
      const requestedAt = new Date('2026-10-01T12:00:00Z');
      const doc = async (name: string, liveStatus: string) => (await client.query<{ id: string }>(
        `insert into documents (org_id, bid_id, file_name, mime, size_bytes, sha256, kind, live_status, updated_at)
         values ($1, $2, $3, 'application/pdf', 1, $3, 'attachment', $4, $5) returning id`,
        [orgId, bidId, name, liveStatus, requestedAt],
      )).rows[0].id;
      const pending = await doc('pending', 'restoring');
      const noCopies = await doc('no-copies', 'restoring');
      const working = await doc('working', 'restoring');
      const archived = await doc('archived', 'archived');
      const archive = async (documentId: string, restoreStatus: string | null, purged = false) => (await client.query<{ id: string }>(
        `insert into archive_objects (org_id, document_id, object_type, archive_key, archived_at, restore_status, purged_at)
         values ($1, $2, 'original', $3, now(), $4, $5) returning id`,
        [orgId, documentId, randomUUID(), restoreStatus, purged ? new Date() : null],
      )).rows[0].id;
      const pendingCopy = await archive(pending, 'none');
      const pendingNull = await archive(pending, null);
      const pendingPurged = await archive(pending, 'none', true);
      const workingCopy = await archive(working, 'restoring');
      const archivedCopy = await archive(archived, 'none');

      await migrate(drizzle(migrator), { migrationsFolder });

      const statuses = await client.query<{ name: string; status: string }>(
        'select name, status from bids where org_id = $1 order by name',
        [orgId],
      );
      expect(statuses.rows).toEqual([
        { name: 'active', status: 'planning' },
        { name: 'closed', status: 'closed' },
        { name: 'draft', status: 'planning' },
        { name: 'writing', status: 'writing' },
      ]);
      await expect(client.query("update bids set status = 'draft' where id = $1", [bidId])).rejects.toThrow(/bids_status_check/);
      const inserted = await client.query<{ status: string }>(
        "insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key) values ($1, 'new', 'sled', 'X', 'X') returning status",
        [orgId],
      );
      expect(inserted.rows[0].status).toBe('planning');

      const docs = await client.query<{ id: string; live_status: string }>(
        'select id, live_status from documents where org_id = $1',
        [orgId],
      );
      const statusOf = (id: string) => docs.rows.find((row) => row.id === id)!.live_status;
      expect(statusOf(pending)).toBe('restore_requested');
      expect(statusOf(noCopies)).toBe('restore_requested');
      expect(statusOf(working)).toBe('restoring');
      expect(statusOf(archived)).toBe('archived');

      const copies = await client.query<{ id: string; restore_status: string | null; restore_requested_at: Date | null }>(
        'select id, restore_status, restore_requested_at from archive_objects where org_id = $1',
        [orgId],
      );
      const copy = (id: string) => copies.rows.find((row) => row.id === id)!;
      for (const id of [pendingCopy, pendingNull]) {
        expect(copy(id).restore_status).toBe('requested');
        expect(copy(id).restore_requested_at).not.toBeNull();
      }
      expect(copy(pendingPurged).restore_status).toBe('none');
      expect(copy(workingCopy).restore_status).toBe('restoring');
      expect(copy(archivedCopy).restore_status).toBe('none');

      const column = await client.query("select 1 from information_schema.columns where table_name = 'documents' and column_name = 'marking_page'");
      expect(column.rowCount).toBe(1);
      const forced = await client.query<{ relname: string; relforcerowsecurity: boolean }>(
        "select relname, relforcerowsecurity from pg_class where relname in ('bids', 'documents', 'archive_objects')",
      );
      expect(forced.rows).toHaveLength(3);
      expect(forced.rows.every((row) => row.relforcerowsecurity)).toBe(true);
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

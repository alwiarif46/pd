/**
 * 0007_plan_status_and_customer backfills organizations.plan_status ('free' on the free plan)
 * as a non-superuser owner, under FORCE ROW LEVEL SECURITY, then adds the CHECK and the unique
 * Stripe customer index.
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

describe.skipIf(Boolean(unavailable))('0007_plan_status_and_customer', () => {
  it('backfills plan_status as a non-superuser owner and adds the CHECK and customer index', async () => {
    const database = `pd_status_${randomBytes(4).toString('hex')}`;
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
      await migrate(drizzle(migrator), { migrationsFolder: await migrationsBefore('0007_plan_status_and_customer') });
      // Seeded as superuser: the owner cannot see these rows while FORCE is on.
      const free = randomUUID();
      const paid = randomUUID();
      const pastDue = randomUUID();
      const odd = randomUUID();
      await client.query(
        `insert into organizations (id, name, plan, plan_status) values
         ($1, 'Free', 'free', 'active'), ($2, 'Paid', 'starter', 'active'),
         ($3, 'Late', 'growth', 'past_due'), ($4, 'Odd', 'starter', 'trialing')`,
        [free, paid, pastDue, odd],
      );

      await migrate(drizzle(migrator), { migrationsFolder });

      const rows = await client.query<{ id: string; plan_status: string }>(
        'select id, plan_status from organizations where id = any($1)',
        [[free, paid, pastDue, odd]],
      );
      const status = Object.fromEntries(rows.rows.map((row) => [row.id, row.plan_status]));
      expect(status).toEqual({ [free]: 'free', [paid]: 'active', [pastDue]: 'past_due', [odd]: 'active' });

      const forced = await client.query<{ relforcerowsecurity: boolean }>(
        "select relforcerowsecurity from pg_class where relname = 'organizations'",
      );
      expect(forced.rows[0].relforcerowsecurity).toBe(true);

      await expect(client.query("update organizations set plan_status = 'trialing' where id = $1", [paid]))
        .rejects.toThrow(/organizations_plan_status_check/);

      await client.query("update organizations set stripe_customer_id = 'cus_1' where id = $1", [paid]);
      await expect(client.query("update organizations set stripe_customer_id = 'cus_1' where id = $1", [pastDue]))
        .rejects.toThrow(/organizations_stripe_customer_uq/);
      // Organizations without a customer are not constrained by the index.
      const nulls = await client.query<{ n: number }>(
        'select count(*)::int as n from organizations where stripe_customer_id is null',
      );
      expect(nulls.rows[0].n).toBe(3);
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

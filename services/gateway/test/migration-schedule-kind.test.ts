/**
 * 0010_schedule_kind marks the old seed route's rows as origin 'template', backfills
 * schedule_activities.kind and review_color from phase and label (the same rules as
 * inferActivityKind in packages/core), adds bids.schedule_workdays_only (default true), and adds
 * the CHECKs. Migrated as a non-superuser owner, as production does.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferActivityKind } from '@pd/core';
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

const STANDARD = ['Kickoff', 'Storyboard', 'Draft', 'Pink team', 'Red team', 'Production', 'Submit'];
const COLOR_REVIEWS = ['Pink team', 'Red team', 'Gold team', 'Production'];

/** Labels whose SQL backfill must agree with inferActivityKind. */
const LABELS = [
  'Pink team', 'Red team review', 'blue-team', 'Green Team', 'Gold team', 'White glove review', 'white-glove',
  'Reduce page count', 'Proposal due', 'Proposals due', 'Submit', 'Submission', 'Questions due', 'Kickoff',
  'Kick-off call', 'Site visit', 'Answers posted', 'RFP released', 'Production', 'Print and package',
  'Storyboard', 'Draft', 'First draft writing', 'Outline and compliance matrix', 'Final revisions',
  'Pricing volume', 'Date from solicitation', 'Lunch', '  Red team  ', 'Proposal submission', 'Due date',
  'Questions due date', 'Proposal due date', 'Offers due', 'Final quote submission', 'Bid due', 'Submission',
  'Due date for questions', 'Due date for Q&A', 'Due date for site visit registration', 'Submission of questions',
  'Submit questions', 'RFI response due', 'Inquiries due', 'Intent to bid due', 'Orals submission', 'Registration submission',
];

describe.skipIf(Boolean(unavailable))('0010_schedule_kind on a database with schedule rows', () => {
  it('backfills template origin, kind, and review color, adds the bid setting, and adds the CHECKs', async () => {
    const database = `pd_schedkind_${randomBytes(4).toString('hex')}`;
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
      await migrate(drizzle(migrator), { migrationsFolder: await migrationsBefore('0010_schedule_kind') });
      const orgId = randomUUID();
      await client.query("insert into organizations (id, name, plan, plan_status) values ($1, 'Sched', 'free', 'free')", [orgId]);
      const bid = async () => (await client.query<{ id: string }>(
        `insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key, status)
         values ($1, 'B', 'sled', 'X-1', 'X1', 'planning') returning id`,
        [orgId],
      )).rows[0].id;
      const one = await bid();
      const two = await bid();
      const [{ id: documentId }] = (await client.query<{ id: string }>(
        `insert into documents (org_id, bid_id, file_name, mime, size_bytes, sha256, kind)
         values ($1, $2, 'rfp.pdf', 'application/pdf', 1, 'abc', 'solicitation') returning id`,
        [orgId, one],
      )).rows;
      /** Rows inserted in one statement, so they share created_at as the old seed route's did. */
      const group = async (bidId: string, labels: string[], at: string, origin = 'user') => (await client.query<{ id: string }>(
        `insert into schedule_activities (org_id, bid_id, label, origin, created_at)
         select $1, $2, label, $3, $4 from unnest($5::text[]) as label returning id`,
        [orgId, bidId, origin, at, labels],
      )).rows.map((row) => row.id);
      const single = async (bidId: string, label: string, extra: { origin?: string | null; phase?: string; documentId?: string } = {}) => (
        await client.query<{ id: string }>(
          `insert into schedule_activities (org_id, bid_id, label, origin, phase, document_id)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [orgId, bidId, label, extra.origin === undefined ? 'user' : extra.origin, extra.phase ?? null, extra.documentId ?? null],
        )).rows[0].id;

      const standard = await group(one, STANDARD, '2026-10-01T10:00:00Z');
      const colorReviews = await group(two, COLOR_REVIEWS, '2026-10-02T10:00:00Z');
      // Seeded twice on one bid: both sets are templates.
      const colorAgain = await group(two, COLOR_REVIEWS, '2026-10-03T10:00:00Z');
      // A seeded set with a renamed row, and one missing a row, are no longer recognisable.
      const renamed = await group(one, [...STANDARD.slice(0, 6), 'Submit to portal'], '2026-10-04T10:00:00Z');
      const short = await group(two, COLOR_REVIEWS.slice(0, 3), '2026-10-05T10:00:00Z');
      // The same labels written by the AI are not the seed route's.
      const aiSet = await group(one, COLOR_REVIEWS, '2026-10-06T10:00:00Z', 'ai');
      // A hand-added row with a template label stays the user's.
      const handPink = await single(one, 'Pink team');
      const aiDate = await single(one, 'Date from solicitation', { origin: 'ai', documentId });
      const phased = await single(one, 'Session', { phase: 'Red team' });
      const nullOrigin = await single(one, 'Lunch', { origin: null });
      const labelled = new Map<string, string>();
      for (const label of LABELS) {
        labelled.set(label, await single(two, label));
      }

      await migrate(drizzle(migrator), { migrationsFolder });

      const rows = new Map((await client.query<{ id: string; origin: string | null; kind: string; review_color: string | null }>(
        'select id, origin, kind, review_color from schedule_activities where org_id = $1', [orgId],
      )).rows.map((row) => [row.id, row]));
      const origin = (id: string) => rows.get(id)!.origin;
      const kind = (id: string) => [rows.get(id)!.kind, rows.get(id)!.review_color];

      for (const id of [...standard, ...colorReviews, ...colorAgain]) {
        expect(origin(id)).toBe('template');
      }
      for (const id of [...renamed, ...short, handPink]) {
        expect(origin(id)).toBe('user');
      }
      for (const id of [...aiSet, aiDate]) {
        expect(origin(id)).toBe('ai');
      }
      expect(origin(nullOrigin)).toBeNull();

      expect(standard.map(kind)).toEqual([
        ['milestone', null], ['writing', null], ['writing', null], ['review', 'pink'], ['review', 'red'],
        ['production', null], ['submission', null],
      ]);
      expect(colorReviews.map(kind)).toEqual([['review', 'pink'], ['review', 'red'], ['review', 'gold'], ['production', null]]);
      expect(kind(handPink)).toEqual(['review', 'pink']);
      expect(kind(aiDate)).toEqual(['milestone', null]);
      expect(kind(phased)).toEqual(['review', 'red']);
      expect(kind(nullOrigin)).toEqual(['custom', null]);
      for (const [label, id] of labelled) {
        const inferred = inferActivityKind(label);
        expect(kind(id), label).toEqual([inferred.kind, inferred.reviewColor]);
      }

      const bids = (await client.query<{ schedule_workdays_only: boolean }>(
        'select schedule_workdays_only from bids where org_id = $1', [orgId],
      )).rows;
      expect(bids.map((row) => row.schedule_workdays_only)).toEqual([true, true]);
      const [{ id: newBid }] = (await client.query<{ id: string }>(
        `insert into bids (org_id, name, bid_type, solicitation_number, solicitation_key)
         values ($1, 'C', 'federal', 'Y-1', 'Y1') returning id`,
        [orgId],
      )).rows;
      expect((await client.query('select schedule_workdays_only from bids where id = $1', [newBid])).rows[0])
        .toEqual({ schedule_workdays_only: true });

      // A new row defaults to 'custom'.
      const fresh = await single(one, 'Anything');
      expect((await client.query('select kind, review_color from schedule_activities where id = $1', [fresh])).rows[0])
        .toEqual({ kind: 'custom', review_color: null });

      const refused = async (sql: string, params: unknown[], constraint: string) => {
        await expect(client.query(sql, params)).rejects.toMatchObject({ code: '23514', constraint });
      };
      await refused('update schedule_activities set kind = $2 where id = $1', [fresh, 'meeting'], 'schedule_activities_kind_check');
      await refused(
        "update schedule_activities set kind = 'review', review_color = $2 where id = $1",
        [fresh, 'purple'],
        'schedule_activities_review_color_check',
      );
      await refused(
        "update schedule_activities set kind = 'writing', review_color = $2 where id = $1",
        [fresh, 'red'],
        'schedule_activities_review_color_kind_check',
      );
      await refused('update schedule_activities set origin = $2 where id = $1', [fresh, 'standard'], 'schedule_activities_origin_check');
      await client.query("update schedule_activities set origin = 'template', kind = 'review', review_color = 'white_glove' where id = $1", [fresh]);

      // FORCE ROW LEVEL SECURITY is back on.
      const force = (await client.query<{ relforcerowsecurity: boolean }>(
        "select relforcerowsecurity from pg_class where relname = 'schedule_activities'",
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

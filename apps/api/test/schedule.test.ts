/**
 * The schedule routes (05 s3.2, PR4): the tab with the bid's "Workdays only" setting, the
 * setting on PATCH /api/bids/:id, activity insert and patch (kind, review color, owner, end
 * date; 409 on a locked move), adjust (shift, scale, keep, with and without workdays), template
 * seeding, and cross-tenant refusals. Runs as pd_app against the real database.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { as, createTenant, type Tenant } from './helpers.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const unavailable = inject('dbUnavailable');

interface Activity {
  id: string;
  label: string;
  startDate: string | null;
  endDate: string | null;
  kind: string;
  reviewColor: string | null;
  origin: string | null;
  owner: string | null;
  locked: boolean;
}

const day = (value: string | null) => (value ? value.slice(0, 10) : null);

describe.skipIf(Boolean(unavailable))('schedule', () => {
  let app: FastifyInstance;
  let a: Tenant;
  let asA: ReturnType<typeof as>;
  let asB: ReturnType<typeof as>;

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-schedule-'));
    delete process.env.PD_ALLOW_BYPASS_RLS;
    getPool({ connectionString: inject('appUrl'), max: 8 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    a = await createTenant(app, 'sa');
    const b = await createTenant(app, 'sb');
    asA = as(app, a.token);
    asB = as(app, b.token);
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  /** A new bid of tenant A with these dates. */
  async function bid(dates: { startDate?: string | null; dueDate?: string | null } = {}): Promise<string> {
    const created = await asA('POST', '/api/bids', { name: 'Schedule bid', bidType: 'federal' });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    if (Object.keys(dates).length > 0) {
      expect((await asA('PATCH', `/api/bids/${id}`, dates)).statusCode).toBe(200);
    }
    return id;
  }

  async function add(bidId: string, body: Record<string, unknown>, call = asA): Promise<Activity> {
    const response = await call('POST', `/api/bids/${bidId}/tabs/schedule/rows`, body);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Activity>();
  }

  async function tab(bidId: string, call = asA) {
    const response = await call('GET', `/api/bids/${bidId}/tabs/schedule`);
    expect(response.statusCode).toBe(200);
    return response.json<{ activities: Activity[]; workdaysOnly: boolean }>();
  }

  async function byId(bidId: string) {
    return new Map((await tab(bidId)).activities.map((activity) => [activity.id, activity]));
  }

  const patch = (bidId: string, rowId: string, fields: Record<string, unknown>, call = asA) => call(
    'PATCH', `/api/bids/${bidId}/rows/schedule_activities/${rowId}`, { fields },
  );

  describe('workdays only setting', () => {
    it('defaults to on, round-trips through PATCH /api/bids/:id, and shows on the tab', async () => {
      const id = await bid();
      expect((await tab(id)).workdaysOnly).toBe(true);
      expect((await asA('GET', `/api/bids/${id}`)).json<{ scheduleWorkdaysOnly: boolean }>().scheduleWorkdaysOnly).toBe(true);

      const off = await asA('PATCH', `/api/bids/${id}`, { scheduleWorkdaysOnly: false });
      expect(off.statusCode).toBe(200);
      expect(off.json<{ scheduleWorkdaysOnly: boolean }>().scheduleWorkdaysOnly).toBe(false);
      expect((await tab(id)).workdaysOnly).toBe(false);
      // Other fields leave it alone.
      expect((await asA('PATCH', `/api/bids/${id}`, { name: 'Renamed' })).json<{ scheduleWorkdaysOnly: boolean }>().scheduleWorkdaysOnly).toBe(false);

      const bad = await asA('PATCH', `/api/bids/${id}`, { scheduleWorkdaysOnly: 'no' });
      expect(bad.statusCode).toBe(400);
      expect((await tab(id)).workdaysOnly).toBe(false);
      expect((await asA('PATCH', `/api/bids/${id}`, { scheduleWorkdaysOnly: true })).statusCode).toBe(200);
      expect((await tab(id)).workdaysOnly).toBe(true);
    });
  });

  describe('insert and patch', () => {
    it('infers kind and review color from the label, takes explicit ones, and orders by start date', async () => {
      const id = await bid();
      const pink = await add(id, { label: 'Pink team review', startDate: '2026-11-10' });
      expect(pink).toMatchObject({ kind: 'review', reviewColor: 'pink', origin: 'user', locked: false });
      expect(day(pink.startDate)).toBe('2026-11-10');
      expect(day(pink.endDate)).toBe('2026-11-10');
      const custom = await add(id, {
        label: 'Data call', startDate: '2026-11-02', endDate: '2026-11-04', kind: 'writing', owner: 'Priya',
      });
      expect(custom).toMatchObject({ kind: 'writing', reviewColor: null, owner: 'Priya' });
      expect(day(custom.endDate)).toBe('2026-11-04');
      const colored = await add(id, { label: 'Session', reviewColor: 'gold' });
      expect(colored).toMatchObject({ kind: 'review', reviewColor: 'gold', startDate: null });
      const locked = await add(id, { label: 'Proposal due', startDate: '2026-11-20T00:00:00.000Z', locked: true });
      expect(locked).toMatchObject({ kind: 'submission', locked: true });
      expect(day(locked.startDate)).toBe('2026-11-20');

      expect((await tab(id)).activities.map((activity) => activity.label))
        .toEqual(['Data call', 'Pink team review', 'Proposal due', 'Session']);
    });

    it('refuses bad kinds, colors, and dates', async () => {
      const id = await bid();
      const post = (body: Record<string, unknown>) => asA('POST', `/api/bids/${id}/tabs/schedule/rows`, body);
      expect((await post({ label: 'X', kind: 'meeting' })).statusCode).toBe(400);
      expect((await post({ label: 'X', reviewColor: 'purple' })).statusCode).toBe(400);
      expect((await post({ label: 'X', kind: 'writing', reviewColor: 'red' })).json()).toEqual({ error: 'Only a review activity has a review color.' });
      expect((await post({ label: 'X', startDate: 'soon' })).statusCode).toBe(400);
      expect((await post({ label: 'X', startDate: '2026-02-30' })).statusCode).toBe(400);
      expect((await post({ label: 'X', startDate: '2026-11-10', endDate: '2026-11-09' })).statusCode).toBe(400);
      expect((await post({ startDate: '2026-11-10' })).statusCode).toBe(400);
      expect((await tab(id)).activities).toEqual([]);
    });

    it('patches kind, review color, owner, and end date', async () => {
      const id = await bid();
      const row = await add(id, { label: 'Red team review', startDate: '2026-11-10' });
      expect((await patch(id, row.id, { owner: 'Sam', endDate: '2026-11-11' })).statusCode).toBe(200);
      expect((await byId(id)).get(row.id)).toMatchObject({ owner: 'Sam', kind: 'review', reviewColor: 'red' });
      expect(day((await byId(id)).get(row.id)!.endDate)).toBe('2026-11-11');

      expect((await patch(id, row.id, { reviewColor: 'white_glove' })).statusCode).toBe(200);
      expect((await byId(id)).get(row.id)).toMatchObject({ reviewColor: 'white_glove' });
      // Leaving 'review' clears the color; a color on another kind is refused.
      expect((await patch(id, row.id, { kind: 'production' })).statusCode).toBe(200);
      expect((await byId(id)).get(row.id)).toMatchObject({ kind: 'production', reviewColor: null });
      expect((await patch(id, row.id, { reviewColor: 'red' })).statusCode).toBe(400);
      expect((await patch(id, row.id, { kind: 'review', reviewColor: 'green' })).statusCode).toBe(200);
      expect((await byId(id)).get(row.id)).toMatchObject({ kind: 'review', reviewColor: 'green' });
      expect((await patch(id, row.id, { kind: 'bogus' })).statusCode).toBe(400);
      expect((await patch(id, row.id, { endDate: '2026-11-01' })).statusCode).toBe(400);
      expect((await patch(id, row.id, { startDate: 'tomorrow' })).statusCode).toBe(400);
    });

    it('answers 409 for a date move on a locked row and leaves it where it was', async () => {
      const id = await bid();
      const row = await add(id, { label: 'Proposal due', startDate: '2026-11-20', locked: true });
      for (const fields of [{ startDate: '2026-11-23' }, { endDate: '2026-11-23' }, { startDate: null }, { startDate: '2026-11-23', locked: true }]) {
        const refused = await patch(id, row.id, fields);
        expect(refused.statusCode, JSON.stringify(fields)).toBe(409);
        expect(refused.json()).toEqual({ error: 'This activity is locked. Unlock it before you move its dates.', code: 'activity_locked' });
      }
      const stored = (await byId(id)).get(row.id)!;
      expect([day(stored.startDate), day(stored.endDate), stored.locked]).toEqual(['2026-11-20', '2026-11-20', true]);

      // The stored date again is not a move; other fields still change.
      expect((await patch(id, row.id, { startDate: '2026-11-20', owner: 'Amaan' })).statusCode).toBe(200);
      expect((await byId(id)).get(row.id)!.owner).toBe('Amaan');
      // Unlocking in the same patch allows the move; so does locking an unlocked row while moving it.
      expect((await patch(id, row.id, { locked: false, startDate: '2026-11-23', endDate: '2026-11-23' })).statusCode).toBe(200);
      expect((await patch(id, row.id, { locked: true, startDate: '2026-11-24', endDate: '2026-11-24' })).statusCode).toBe(200);
      expect((await byId(id)).get(row.id)).toMatchObject({ locked: true, startDate: '2026-11-24T00:00:00.000Z' });
    });
  });

  describe('adjust', () => {
    async function planned(bidId: string) {
      const draft = await add(bidId, { label: 'Draft', startDate: '2026-11-16', endDate: '2026-11-18' });
      const pink = await add(bidId, { label: 'Pink team', startDate: '2026-11-19' });
      const due = await add(bidId, { label: 'Proposal due', startDate: '2026-11-20', locked: true });
      const undated = await add(bidId, { label: 'Lunch' });
      return { draft, pink, due, undated };
    }

    const dates = async (bidId: string, ids: string[]) => {
      const rows = await byId(bidId);
      return ids.map((rowId) => [day(rows.get(rowId)!.startDate), day(rows.get(rowId)!.endDate)]);
    };

    it('shifts in workdays with the bid setting on; locked rows stay but the due date itself follows', async () => {
      const id = await bid({ startDate: '2026-11-02', dueDate: '2026-11-20' });
      const { draft, pink, due, undated } = await planned(id);
      const questions = await add(id, { label: 'Questions due', startDate: '2026-11-20', locked: true });
      const earlier = await add(id, { label: 'Submit volume 1', startDate: '2026-11-13', locked: true });
      expect([due.kind, questions.kind, earlier.kind]).toEqual(['submission', 'milestone', 'submission']);
      const response = await asA('POST', `/api/bids/${id}/schedule/adjust`, { mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-30' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true, requestedMode: 'shift', mode: 'shift', workdaysOnly: true, unit: 'workdays', delta: 5, moved: 3,
      });
      expect(response.json<{ moves: { id: string; followsDue: boolean }[] }>().moves.find((move) => move.id === due.id))
        .toMatchObject({ start: '2026-11-30', end: '2026-11-30', followsDue: true });
      // Thanksgiving (26 Nov) and the weekend are skipped.
      expect(await dates(id, [draft.id, pink.id, due.id, undated.id, questions.id, earlier.id])).toEqual([
        ['2026-11-23', '2026-11-25'], ['2026-11-27', '2026-11-27'], ['2026-11-30', '2026-11-30'], [null, null],
        ['2026-11-20', '2026-11-20'], ['2026-11-13', '2026-11-13'],
      ]);
      expect((await byId(id)).get(due.id)!.locked).toBe(true);
    });

    it('moves the due date submission on keep (alone) and on scale', async () => {
      const id = await bid({ startDate: '2026-11-02', dueDate: '2026-11-20' });
      const { draft, due } = await planned(id);
      const kept = await asA('POST', `/api/bids/${id}/schedule/adjust`, { mode: 'keep', previousDue: '2026-11-20', nextDue: '2026-12-04' });
      expect(kept.json()).toMatchObject({ mode: 'keep', moved: 1, moves: [{ id: due.id, start: '2026-12-04', followsDue: true }] });
      expect(await dates(id, [due.id, draft.id])).toEqual([['2026-12-04', '2026-12-04'], ['2026-11-16', '2026-11-18']]);
      const scaled = await asA('POST', `/api/bids/${id}/schedule/adjust`, { mode: 'scale', previousDue: '2026-12-04', nextDue: '2026-12-18' });
      expect(scaled.json()).toMatchObject({ mode: 'scale', moved: 3 });
      expect(await dates(id, [due.id])).toEqual([['2026-12-18', '2026-12-18']]);
    });

    it('shifts in calendar days when the request overrides the setting', async () => {
      const id = await bid({ startDate: '2026-11-02', dueDate: '2026-11-20' });
      const { draft, pink } = await planned(id);
      const response = await asA('POST', `/api/bids/${id}/schedule/adjust`, {
        mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-30', workdaysOnly: false,
      });
      expect(response.json()).toMatchObject({ mode: 'shift', workdaysOnly: false, unit: 'days', delta: 10, moved: 3 });
      expect(await dates(id, [draft.id, pink.id])).toEqual([['2026-11-26', '2026-11-28'], ['2026-11-29', '2026-11-29']]);
      expect((await tab(id)).workdaysOnly).toBe(true);
    });

    it('uses the bid setting when it is off', async () => {
      const id = await bid({ startDate: '2026-11-02', dueDate: '2026-11-20' });
      await asA('PATCH', `/api/bids/${id}`, { scheduleWorkdaysOnly: false });
      const { draft } = await planned(id);
      const response = await asA('POST', `/api/bids/${id}/schedule/adjust`, { mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-30' });
      expect(response.json()).toMatchObject({ workdaysOnly: false, delta: 10 });
      expect(await dates(id, [draft.id])).toEqual([['2026-11-26', '2026-11-28']]);
      // ...and an override can turn workdays back on for one call.
      const back = await asA('POST', `/api/bids/${id}/schedule/adjust`, {
        mode: 'shift', previousDue: '2026-11-30', nextDue: '2026-11-20', workdaysOnly: true,
      });
      expect(back.json()).toMatchObject({ workdaysOnly: true, delta: -5 });
    });

    it('scales from the bid start date, and shifts when the bid has none', async () => {
      // Start Mon 2 Mar 2026, due Fri 13 Mar (9 workdays later) moves to Fri 27 Mar (19).
      const id = await bid({ startDate: '2026-03-02', dueDate: '2026-03-13' });
      const row = await add(id, { label: 'Draft', startDate: '2026-03-05', endDate: '2026-03-06' });
      const scaled = await asA('POST', `/api/bids/${id}/schedule/adjust`, { mode: 'scale', previousDue: '2026-03-13', nextDue: '2026-03-27' });
      expect(scaled.json()).toMatchObject({ requestedMode: 'scale', mode: 'scale', moved: 1 });
      expect(await dates(id, [row.id])).toEqual([['2026-03-10', '2026-03-12']]);

      const bare = await bid({ dueDate: '2026-03-13' });
      const other = await add(bare, { label: 'Draft', startDate: '2026-03-05', endDate: '2026-03-06' });
      const shifted = await asA('POST', `/api/bids/${bare}/schedule/adjust`, { mode: 'scale', previousDue: '2026-03-13', nextDue: '2026-03-27' });
      expect(shifted.json()).toMatchObject({ requestedMode: 'scale', mode: 'shift', delta: 10 });
      expect(await dates(bare, [other.id])).toEqual([['2026-03-19', '2026-03-20']]);
    });

    it('keeps on keep, and refuses bad requests', async () => {
      const id = await bid({ startDate: '2026-11-02', dueDate: '2026-11-20' });
      const { draft } = await planned(id);
      expect((await asA('POST', `/api/bids/${id}/schedule/adjust`, { mode: 'keep' })).json()).toMatchObject({ ok: true, moved: 0, moves: [] });
      expect((await asA('POST', `/api/bids/${id}/schedule/adjust`, { mode: 'keep', previousDue: '2026-11-20', nextDue: '2026-11-30' })).json())
        .toMatchObject({ mode: 'keep', moved: 1 }); // only the locked due date itself
      const post = (body: Record<string, unknown>) => asA('POST', `/api/bids/${id}/schedule/adjust`, body);
      expect((await post({ mode: 'stretch', previousDue: '2026-11-20', nextDue: '2026-11-30' })).statusCode).toBe(400);
      expect((await post({ mode: 'shift' })).statusCode).toBe(400);
      expect((await post({ mode: 'shift', previousDue: '2026-11-20' })).statusCode).toBe(400);
      expect((await post({ mode: 'shift', previousDue: '2026-11-20', nextDue: 'later' })).json()).toMatchObject({ code: 'invalid_date' });
      expect((await post({ mode: 'shift', previousDue: '2026-11-20', nextDue: '9999-01-01' })).statusCode).toBe(400);
      expect((await post({ mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-30', workdaysOnly: 'yes' })).statusCode).toBe(400);
      expect(await dates(id, [draft.id])).toEqual([['2026-11-16', '2026-11-18']]);
    });
  });

  describe('templates', () => {
    const seed = (bidId: string, body: Record<string, unknown>, call = asA) => call('POST', `/api/bids/${bidId}/tabs/schedule/seed`, body);

    it('needs a due date', async () => {
      const id = await bid();
      const response = await seed(id, { template: 'task-order' });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Set the due date in Bid settings first. Templates count back from it.', code: 'due_date_required' });
    });

    it('counts back from the due date as origin template, adds or replaces, and keeps locked rows', async () => {
      const id = await bid({ dueDate: '2026-11-25' });
      const locked = await add(id, { label: 'Proposal due', startDate: '2026-11-25', locked: true });
      const mine = await add(id, { label: 'Data call', startDate: '2026-11-02' });

      const first = await seed(id, { template: 'task-order' });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ ok: true, template: 'task-order', added: 4, replaced: 0 });
      const rows = (await tab(id)).activities;
      expect(rows).toHaveLength(6);
      const templated = rows.filter((row) => row.origin === 'template');
      expect(templated.map((row) => [row.label, row.kind, row.reviewColor, day(row.startDate), day(row.endDate)])).toEqual([
        // 8 workdays before Wed 25 Nov, skipping Veterans Day.
        ['Kickoff meeting', 'milestone', null, '2026-11-13', '2026-11-13'],
        ['First draft writing', 'writing', null, '2026-11-16', '2026-11-18'],
        ['Red team review', 'review', 'red', '2026-11-19', '2026-11-19'],
        ['Production and packaging', 'production', null, '2026-11-23', '2026-11-23'],
      ]);

      const replaced = await seed(id, { template: 'federal-fast', replace: true });
      expect(replaced.json()).toMatchObject({ template: 'federal-fast', added: 6, replaced: 5 });
      const after = (await tab(id)).activities;
      expect(after.map((row) => row.id)).toContain(locked.id);
      expect(after.map((row) => row.id)).not.toContain(mine.id);
      expect(after.filter((row) => row.origin === 'template')).toHaveLength(6);
    });

    it('keeps AI rows when replacing', async () => {
      const id = await bid({ dueDate: '2026-11-25' });
      const ai = await withOrg(a.orgId, async (db) => (await db.insert(schema.scheduleActivities).values({
        orgId: a.orgId, bidId: id, label: 'Date from solicitation', kind: 'milestone', origin: 'ai', locked: false,
        startDate: new Date('2026-11-10T00:00:00Z'), sourcePage: 3, sourceQuote: 'Questions are due November 10, 2026.',
      }).returning())[0]);
      const mine = await add(id, { label: 'Data call', startDate: '2026-11-02' });
      await seed(id, { template: 'task-order' });
      const replaced = await seed(id, { template: 'federal-fast', replace: true });
      expect(replaced.json()).toMatchObject({ added: 6, replaced: 5 });
      const ids = (await tab(id)).activities.map((row) => row.id);
      expect(ids).toContain(ai.id);
      expect(ids).not.toContain(mine.id);
      expect(ids).toHaveLength(7);
    });

    it('counts calendar days with the setting off, maps the legacy ids, and refuses unknown ones', async () => {
      const id = await bid({ dueDate: '2026-11-25' });
      await asA('PATCH', `/api/bids/${id}`, { scheduleWorkdaysOnly: false });
      await seed(id, { template: 'task-order' });
      expect(day((await tab(id)).activities[0].startDate)).toBe('2026-11-17');

      const legacy = await bid({ dueDate: '2026-11-25' });
      expect((await seed(legacy, { template: 'standard' })).json()).toMatchObject({ template: 'federal-standard', added: 10 });
      expect((await seed(legacy, { template: 'color-reviews' })).json()).toMatchObject({ template: 'federal-fast', added: 6 });
      expect((await seed(legacy, {})).json()).toMatchObject({ template: 'federal-standard' });
      expect((await seed(legacy, { template: 'nope' })).statusCode).toBe(400);
      expect((await seed(legacy, { template: 'task-order', replace: 'yes' })).statusCode).toBe(400);
    });
  });

  describe('cross-tenant', () => {
    it('refuses another organization’s bid on every schedule write and leaves its rows alone', async () => {
      const theirs = await asB('POST', '/api/bids', { name: 'B schedule', bidType: 'sled' });
      const bidB = theirs.json<{ id: string }>().id;
      await asB('PATCH', `/api/bids/${bidB}`, { startDate: '2026-11-02', dueDate: '2026-11-20' });
      const rowB = await add(bidB, { label: 'Draft', startDate: '2026-11-16', endDate: '2026-11-18' }, asB);
      const before = await tab(bidB, asB);

      const ownBid = await bid({ dueDate: '2026-11-20' });
      expect((await asA('GET', `/api/bids/${bidB}/tabs/schedule`)).statusCode).toBe(404);
      expect((await asA('POST', `/api/bids/${bidB}/schedule/adjust`, { mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-30' })).statusCode).toBe(404);
      expect((await asA('POST', `/api/bids/${bidB}/schedule/adjust`, { mode: 'scale', previousDue: '2026-11-20', nextDue: '2026-11-30', workdaysOnly: false })).statusCode).toBe(404);
      expect((await asA('PATCH', `/api/bids/${bidB}`, { scheduleWorkdaysOnly: false })).statusCode).toBe(404);
      expect((await asA('POST', `/api/bids/${bidB}/tabs/schedule/seed`, { template: 'task-order', replace: true })).statusCode).toBe(404);
      expect((await asA('POST', `/api/bids/${bidB}/tabs/schedule/rows`, { label: 'Planted' })).statusCode).toBe(404);
      for (const through of [bidB, ownBid]) {
        expect((await patch(through, rowB.id, { startDate: '2026-12-01', kind: 'review', reviewColor: 'red' })).statusCode).toBe(404);
      }
      // A's own adjust and seed never reach B's rows.
      expect((await asA('POST', `/api/bids/${ownBid}/schedule/adjust`, { mode: 'shift', previousDue: '2026-11-20', nextDue: '2026-11-30' })).json()).toMatchObject({ moved: 0 });
      expect((await asA('POST', `/api/bids/${ownBid}/tabs/schedule/seed`, { template: 'task-order', replace: true })).json()).toMatchObject({ replaced: 0 });

      expect(await tab(bidB, asB)).toEqual(before);
      expect((await asB('GET', `/api/bids/${bidB}`)).json<{ scheduleWorkdaysOnly: boolean }>().scheduleWorkdaysOnly).toBe(true);
    });
  });
});

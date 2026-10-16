/**
 * The worker's dates step (apps/worker/src/ai-jobs.ts processDates) writes AI date rows keyed and
 * dated in code (packages/core classifyDateHit, PR5), labelled by their key, and of the label's
 * kind, else 'milestone' as migration 0010 backfilled existing ones.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { createTenant, type Tenant } from './helpers.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

vi.mock('../../worker/src/enqueue.js', () => ({
  enqueue: vi.fn(async () => undefined),
}));

const unavailable = inject('dbUnavailable');

describe.skipIf(Boolean(unavailable))('worker dates step', () => {
  let app: FastifyInstance;
  let worker: typeof import('../../worker/src/ai-jobs.js');
  let a: Tenant;

  beforeAll(async () => {
    process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'pd-api-dates-'));
    delete process.env.PD_ALLOW_BYPASS_RLS;
    getPool({ connectionString: inject('appUrl'), max: 8 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    worker = await import('../../worker/src/ai-jobs.js');
    a = await createTenant(app, 'wd');
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  it('writes locked AI date rows, keyed, dated, and of their label\'s kind', async () => {
    const documentId = await withOrg(a.orgId, async (db) => {
      const [document] = await db.insert(schema.documents).values({
        orgId: a.orgId,
        bidId: a.bidId,
        fileName: 'dates.pdf',
        mime: 'application/pdf',
        sizeBytes: 10,
        sha256: `sha-${randomUUID()}`,
        kind: 'solicitation',
        liveStatus: 'live',
      }).returning();
      await db.insert(schema.pages).values({
        orgId: a.orgId, documentId: document.id, pageNo: 2,
        text: 'Offers are open until 2026-12-15.\nQuestions are due November 1, 2026.\nThe kickoff is 2027-01-04.\nSubmit no later than noon.',
      });
      return document.id;
    });
    await worker.processDates({
      orgId: a.orgId, bidId: a.bidId, documentId, jobId: randomUUID(), storagePath: '', kind: 'solicitation',
    });
    const rows = await withOrg(a.orgId, (db) => db.select().from(schema.scheduleActivities)
      .where(eq(schema.scheduleActivities.documentId, documentId)));
    const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
    expect(rows.map((row) => [row.label, row.kind, row.reviewColor, row.dateKey, day(row.startDate), day(row.endDate), row.origin, row.locked, row.sourcePage])
      .sort((x, y) => String(x[3]).localeCompare(String(y[3])) || String(x[4]).localeCompare(String(y[4])))).toEqual([
      ['Date from solicitation', 'milestone', null, 'other', '2027-01-04', '2027-01-04', 'ai', true, 2],
      // A sentence with no day is never keyed: only a dated row can replace another.
      ['Date from solicitation', 'milestone', null, 'other', null, null, 'ai', true, 2],
      ['Proposal due', 'submission', null, 'proposal_due', '2026-12-15', '2026-12-15', 'ai', true, 2],
      ['Questions due', 'milestone', null, 'questions_due', '2026-11-01', '2026-11-01', 'ai', true, 2],
    ]);
  });
});

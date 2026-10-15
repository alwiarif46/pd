/**
 * The worker's dates step (apps/worker/src/ai-jobs.ts processDates) writes AI date rows with a
 * kind, as migration 0010 backfilled existing ones: the label's kind, else 'milestone'.
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

  it('writes locked AI date rows of kind milestone', async () => {
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
        orgId: a.orgId, documentId: document.id, pageNo: 2, text: 'Offers are open until 2026-12-15.',
      });
      return document.id;
    });
    await worker.processDates({
      orgId: a.orgId, bidId: a.bidId, documentId, jobId: randomUUID(), storagePath: '', kind: 'solicitation',
    });
    const rows = await withOrg(a.orgId, (db) => db.select().from(schema.scheduleActivities)
      .where(eq(schema.scheduleActivities.documentId, documentId)));
    expect(rows.map((row) => [row.label, row.kind, row.reviewColor, row.origin, row.locked, row.sourcePage])).toEqual([
      ['Date from solicitation', 'milestone', null, 'ai', true, 2],
    ]);
  });
});

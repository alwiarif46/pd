import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { closeDb, getPool, schema, withOrg } from '@pd/core';
import { createTenant, type Tenant } from './helpers.js';

vi.mock('../src/queue.js', () => ({
  enqueueScan: vi.fn(async () => undefined),
  enqueueClassify: vi.fn(async () => undefined),
  enqueueAmendment: vi.fn(async () => undefined),
}));

const unavailable = inject('dbUnavailable');

describe.skipIf(Boolean(unavailable))('upload complete', () => {
  let app: FastifyInstance;
  let tenant: Tenant;
  let dataDir: string;
  const bytes = Buffer.from('%PDF-1.4 test');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pd-api-files-'));
    process.env.DATA_DIR = dataDir;
    getPool({ connectionString: inject('appUrl'), max: 4 });
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    tenant = await createTenant(app, 'up');
  });

  afterAll(async () => {
    await app?.close();
    await closeDb();
  });

  async function openSession(fileName: string): Promise<string> {
    return withOrg(tenant.orgId, async (db) => {
      const [session] = await db.insert(schema.uploadSessions).values({
        orgId: tenant.orgId,
        bidId: tenant.bidId,
        userId: tenant.userId,
        fileName,
        kind: 'attachment',
        declaredSize: bytes.length,
        sha256,
        chunkCount: 1,
        status: 'open',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }).returning();
      return session.id;
    });
  }

  async function sendChunk(sessionId: string) {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/uploads/${sessionId}/chunks/0`,
      headers: { authorization: `Bearer ${tenant.token}`, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(response.statusCode).toBe(200);
  }

  function complete(sessionId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/uploads/${sessionId}/complete`,
      headers: { authorization: `Bearer ${tenant.token}` },
    });
  }

  it('stores the file under a server-generated name, whatever the client called it', async () => {
    const sessionId = await openSession('../../../outside.pdf');
    await sendChunk(sessionId);
    const response = await complete(sessionId);
    expect(response.statusCode).toBe(201);
    const { documentId } = response.json<{ documentId: string }>();
    const document = await withOrg(tenant.orgId, async (db) => {
      const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
      return row;
    });
    expect(document.storagePath).toBe(`docs/${sessionId}.pdf`);
    expect(document.fileName).toBe('../../../outside.pdf');
    expect(await readdir(join(dataDir, tenant.orgId, 'docs'))).toContain(`${sessionId}.pdf`);
    expect(await readdir(dataDir)).toEqual([tenant.orgId]);
  });

  it('completes a session once; a second complete gets 409 and creates nothing', async () => {
    const sessionId = await openSession('second.pdf');
    await sendChunk(sessionId);
    expect((await complete(sessionId)).statusCode).toBe(201);
    expect((await complete(sessionId)).statusCode).toBe(409);
    const documents = await withOrg(tenant.orgId, (db) => db.select().from(schema.documents).where(eq(schema.documents.storagePath, `docs/${sessionId}.pdf`)));
    expect(documents).toHaveLength(1);
  });

  it('lets only one of two concurrent completes succeed', async () => {
    const sessionId = await openSession('race.pdf');
    await sendChunk(sessionId);
    // Hold the session row from another connection so both requests are provably waiting
    // on the claim at the same time, then let them go.
    const holder = new pg.Client({ connectionString: inject('appUrl') });
    await holder.connect();
    await holder.query('begin');
    await holder.query("select set_config('app.org_id', $1, true)", [tenant.orgId]);
    await holder.query('select id from upload_sessions where id = $1 for update', [sessionId]);
    const pending = Promise.all([complete(sessionId), complete(sessionId)]);
    const deadline = Date.now() + 10_000;
    let waiting = 0;
    while (waiting < 2 && Date.now() < deadline) {
      // pg_stat_activity is a per-transaction snapshot unless cleared.
      await holder.query('select pg_stat_clear_snapshot()');
      const result = await holder.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'",
      );
      waiting = result.rows[0].n;
    }
    await holder.query('commit');
    await holder.end();
    expect(waiting).toBe(2);
    const results = await pending;
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    const documents = await withOrg(tenant.orgId, (db) => db.select().from(schema.documents).where(eq(schema.documents.storagePath, `docs/${sessionId}.pdf`)));
    expect(documents).toHaveLength(1);
  });

  it('will not serve a stored path outside the organization folder', async () => {
    const documentId = await withOrg(tenant.orgId, async (db) => {
      const [row] = await db.insert(schema.documents).values({
        orgId: tenant.orgId,
        bidId: tenant.bidId,
        fileName: 'x.pdf',
        mime: 'application/pdf',
        sizeBytes: 1,
        sha256: 'traversal',
        kind: 'attachment',
        storagePath: '../../outside.pdf',
        liveStatus: 'live',
      }).returning();
      return row.id;
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/file`,
      headers: { authorization: `Bearer ${tenant.token}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Document not found' });
  });

  it('puts the session back to open when the bytes do not match', async () => {
    const sessionId = await withOrg(tenant.orgId, async (db) => {
      const [session] = await db.insert(schema.uploadSessions).values({
        orgId: tenant.orgId,
        bidId: tenant.bidId,
        userId: tenant.userId,
        fileName: 'bad.pdf',
        kind: 'attachment',
        declaredSize: bytes.length,
        sha256: 'not-the-hash',
        chunkCount: 1,
        status: 'open',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }).returning();
      return session.id;
    });
    await sendChunk(sessionId);
    expect((await complete(sessionId)).statusCode).toBe(400);
    const [session] = await withOrg(tenant.orgId, (db) => db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, sessionId)));
    expect(session.status).toBe('open');
  });
});

// After the database block, so the module first loads once DATA_DIR points at the temp folder.
describe('storedExtension', () => {
  it('keeps only a known extension and nothing else from the client name', async () => {
    const { storedExtension } = await import('../src/uploads.js');
    expect(storedExtension('rfp.PDF')).toBe('.pdf');
    expect(storedExtension('../../etc/passwd')).toBe('');
    expect(storedExtension('..\\..\\evil.docx')).toBe('.docx');
    expect(storedExtension('x.pdf/../../y')).toBe('');
    expect(storedExtension('payload.exe')).toBe('');
  });
});

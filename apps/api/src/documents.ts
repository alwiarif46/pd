import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { and, asc, eq, gte, inArray, isNull, lt, lte, max, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  canRestore,
  type DocumentLiveStatus,
  documentLiveUntil,
  keyOverridesLeft,
  keyOverridesPerBid,
  type Plan,
  resolveOrgPath,
  restoreSettings,
  schema,
  SETTING_KEY_OVERRIDES_PER_BID,
  SETTING_RESTORE_FREE_ALLOWED,
  SETTING_RESTORE_WINDOW_DAYS,
  withOrg,
} from '@pd/core';
import { requireAuth } from './context.js';
import { lockBid, releaseBidCredit } from './credits.js';
import { apiError } from './errors.js';
import { type Db, findBid, inOrg, findDocument, type Outcome, queueAfterCommit } from './scope.js';
import { enqueueClassify } from './queue.js';
import { newToken } from './security.js';

const dataDir = process.env.DATA_DIR || '/data/files';

const HOUR = 60 * 60 * 1000;
const viewTokens = new Map<string, { documentId: string; sessionId: string; expiresAt: number }>();

/**
 * app_settings values for `keys` (a missing key is absent from the result). app_settings is not
 * a tenant table; the core helpers apply the defaults (packages/core retention.ts, credits.ts).
 */
export async function readSettings(db: Db, keys: string[]): Promise<Record<string, string>> {
  const rows = await db.select({ key: schema.appSettings.key, value: schema.appSettings.value })
    .from(schema.appSettings).where(inArray(schema.appSettings.key, keys));
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/** The per-bid amendment key override limit (app_settings `key_overrides_per_bid`, default 2). */
export async function readKeyOverrideLimit(db: Db): Promise<number> {
  const settings = await readSettings(db, [SETTING_KEY_OVERRIDES_PER_BID]);
  return keyOverridesPerBid(settings[SETTING_KEY_OVERRIDES_PER_BID]);
}

/** The organization's plan (the caller's org; row-level security shows only that one). */
export async function orgPlan(db: Db, orgId: string): Promise<Plan> {
  const [org] = await db.select({ plan: schema.organizations.plan }).from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  return (org?.plan ?? 'free') as Plan;
}

export type KeyCheck = 'not_applicable' | 'ok' | 'mismatch' | 'overridden';

/**
 * The amendment key check for a document (5.11): only amendments are checked. An amendment row
 * whose solicitation number was not found and is not overridden is a mismatch; an override is
 * shown as such; otherwise (matched, or not processed yet) it is ok.
 */
export function keyCheckFor(
  kind: string,
  amendments: { solicitationKeyFound: boolean; keyOverride: boolean }[],
): KeyCheck {
  if (kind !== 'amendment') {
    return 'not_applicable';
  }
  if (amendments.some((row) => !row.solicitationKeyFound && !row.keyOverride)) {
    return 'mismatch';
  }
  if (amendments.some((row) => row.keyOverride)) {
    return 'overridden';
  }
  return 'ok';
}

const RESTORE_PENDING: readonly DocumentLiveStatus[] = ['restore_requested', 'restoring', 'restored'];

function isRestorePending(status: string | null): status is 'restore_requested' | 'restoring' | 'restored' {
  return status !== null && (RESTORE_PENDING as readonly string[]).includes(status);
}

export async function registerDocuments(app: FastifyInstance): Promise<void> {
  /**
   * The bid's documents, each with what the Documents tab shows (5.11): `liveUntil` computed by
   * the 03 s39 rule (the stored column is not written yet; null for a deleted file),
   * `restoredUntil` (the latest restored, unpurged archive copy), `markingPage`, and `keyCheck`.
   */
  app.get('/api/bids/:id/documents', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, bidId);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      const plan = await orgPlan(db, orgId);
      const documents = await db.select().from(schema.documents).where(and(eq(schema.documents.bidId, bidId), eq(schema.documents.orgId, orgId)));
      const ids = documents.map((document) => document.id);
      const restored = ids.length === 0 ? [] : await db.select({
        documentId: schema.archiveObjects.documentId,
        restoredUntil: max(schema.archiveObjects.restoredUntil),
      }).from(schema.archiveObjects).where(and(
        eq(schema.archiveObjects.orgId, orgId),
        inArray(schema.archiveObjects.documentId, ids),
        eq(schema.archiveObjects.restoreStatus, 'restored'),
        isNull(schema.archiveObjects.purgedAt),
      )).groupBy(schema.archiveObjects.documentId);
      const amendments = await db.select({
        documentId: schema.amendments.documentId,
        solicitationKeyFound: schema.amendments.solicitationKeyFound,
        keyOverride: schema.amendments.keyOverride,
      }).from(schema.amendments).where(and(eq(schema.amendments.bidId, bidId), eq(schema.amendments.orgId, orgId)));
      return documents.map((document) => ({
        ...document,
        liveUntil: document.liveStatus === 'deleted' ? null : documentLiveUntil({
          plan,
          kind: document.kind,
          uploadedAt: document.createdAt,
          dueDate: bid.dueDate,
          retentionExtendedUntil: bid.retentionExtendedUntil,
        }),
        restoredUntil: restored.find((row) => row.documentId === document.id)?.restoredUntil ?? null,
        keyCheck: keyCheckFor(document.kind, amendments.filter((row) => row.documentId === document.id)),
      }));
    });
  });

  app.get('/api/documents/:id/view-token', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      const token = newToken();
      viewTokens.set(token, {
        documentId,
        sessionId: request.auth!.sessionId,
        expiresAt: Date.now() + HOUR,
      });
      return { token, expiresInSeconds: 3600 };
    });
  });

  app.post('/api/documents/:id/confirm-marking', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    const outcome = await withOrg(orgId, async (db): Promise<Outcome> => {
      const document = await findDocument(db, orgId, documentId);
      if (!document || !document.storagePath) {
        return { code: 404, body: { error: 'Document not found' } };
      }
      if (document.extractStatus === 'rejected') {
        return { code: 409, body: { error: 'Classified files are not accepted' } };
      }
      if (document.markingStatus !== 'blocked') {
        return { code: 409, body: { error: 'This file is not waiting for confirmation' } };
      }
      const storagePath = document.storagePath;
      await db.update(schema.documents).set({ markingStatus: 'confirmed', updatedAt: new Date() }).where(and(eq(schema.documents.id, documentId), eq(schema.documents.orgId, orgId)));
      await db.insert(schema.auditLog).values({
        orgId,
        userId: request.auth!.userId,
        action: 'confirm_marking',
        targetType: 'document',
        targetId: documentId,
      });
      const [job] = await db.insert(schema.jobs).values({
        orgId,
        bidId: document.bidId,
        documentId,
        type: 'classify',
        status: 'pending',
      }).returning();
      return {
        code: 200,
        body: { ok: true },
        queue: {
          jobId: job.id,
          enqueue: () => enqueueClassify({
            orgId,
            bidId: document.bidId,
            documentId,
            jobId: job.id,
            storagePath,
            kind: document.kind,
          }),
        },
      };
    });
    await queueAfterCommit(orgId, outcome);
    return reply.code(outcome.code).send(outcome.body);
  });

  app.post('/api/documents/:id/key-override', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    if (auth.role !== 'owner') {
      return reply.code(403).send({ error: 'Only the owner can override a solicitation key' });
    }
    const reason = ((request.body as { reason?: string }).reason ?? '').trim();
    if (!reason) {
      return reply.code(400).send({ error: 'A reason is required' });
    }
    const documentId = (request.params as { id: string }).id;
    const orgId = auth.orgId!;
    return inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      if (document.liveStatus === 'deleted') {
        return respond(409, apiError('document_deleted'));
      }
      if (document.kind !== 'amendment') {
        return respond(409, apiError('not_an_amendment'));
      }
      // Lock order (credits.ts): the bid before its amendments, as a bid delete (which locks the
      // bid, then cascades into amendments) does.
      if ((await lockBid(db, orgId, document.bidId)).length === 0) {
        return respond(404, { error: 'Bid not found' });
      }
      // The amendment whose solicitation number did not match, not yet accepted. Locked until
      // COMMIT, so two overrides of one amendment cannot both pass and spend two overrides.
      const [amendment] = await db.select().from(schema.amendments).where(and(
        eq(schema.amendments.documentId, documentId),
        eq(schema.amendments.orgId, orgId),
        eq(schema.amendments.solicitationKeyFound, false),
        eq(schema.amendments.keyOverride, false),
      )).limit(1).for('update');
      if (!amendment) {
        return respond(409, apiError('override_not_needed'));
      }
      // Spend one of the bid's overrides with a conditional increment, so concurrent overrides
      // of different amendments cannot exceed the limit (app_settings key_overrides_per_bid).
      const limit = await readKeyOverrideLimit(db);
      const [bid] = await db.update(schema.bids).set({
        keyOverridesUsed: sql`${schema.bids.keyOverridesUsed} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.bids.id, document.bidId),
        eq(schema.bids.orgId, orgId),
        lt(schema.bids.keyOverridesUsed, limit),
      )).returning({ keyOverridesUsed: schema.bids.keyOverridesUsed });
      if (!bid) {
        return respond(409, apiError('override_limit'));
      }
      await db.update(schema.amendments).set({
        keyOverride: true,
        overrideReason: reason,
        updatedAt: new Date(),
      }).where(and(eq(schema.amendments.id, amendment.id), eq(schema.amendments.orgId, orgId)));
      await db.insert(schema.auditLog).values({
        orgId,
        userId: auth.userId,
        action: 'key_override',
        targetType: 'document',
        targetId: documentId,
        detail: { reason, amendmentId: amendment.id },
      });
      return { ok: true, amendmentId: amendment.id, remaining: keyOverridesLeft(limit, bid.keyOverridesUsed) };
    });
  });

  app.get('/api/documents/view/:token', { preHandler: requireAuth }, async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const entry = viewTokens.get(token);
    if (!entry || entry.expiresAt < Date.now() || entry.sessionId !== request.auth!.sessionId) {
      return reply.code(404).send({ error: 'View token not found' });
    }
    return { documentId: entry.documentId };
  });

  app.get('/api/documents/:id/pages', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    const query = request.query as { from?: string; to?: string };
    const from = Number(query.from ?? 1);
    const to = Number(query.to ?? from);
    return inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      const rows = await db.select().from(schema.pages).where(and(
        eq(schema.pages.documentId, documentId),
        eq(schema.pages.orgId, orgId),
        gte(schema.pages.pageNo, from),
        lte(schema.pages.pageNo, to),
      )).orderBy(asc(schema.pages.pageNo));
      return {
        fileName: document.fileName,
        liveStatus: document.liveStatus,
        pagesEstimated: document.pagesEstimated,
        extractMethod: document.extractMethod,
        pages: rows,
      };
    });
  });

  app.get('/api/documents/:id/file', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const documentId = (request.params as { id: string }).id;
    const found = await inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      if (document.liveStatus === 'deleted') {
        // A deleted file has no server copy; its page text and the rows it produced stay.
        return respond(410, { error: document.kind === 'resume' ? 'Resume deleted after 90 days' : 'This file was deleted' });
      }
      if (document.liveStatus === 'archived') {
        return respond(409, { error: 'This file is archived. Restore it to open the full page.' });
      }
      if (document.liveStatus === 'restore_requested' || document.liveStatus === 'restoring') {
        return respond(409, { error: 'This file is being restored. It opens once the restore is done.' });
      }
      if (!document.storagePath) {
        return respond(404, { error: 'Document not found' });
      }
      // A stored path must stay inside this organization's folder.
      const absolute = resolveOrgPath(dataDir, orgId, document.viewerPath || document.storagePath);
      if (!absolute) {
        return respond(404, { error: 'Document not found' });
      }
      try {
        await stat(absolute);
      } catch {
        return respond(404, { error: 'The viewer copy is not on this server' });
      }
      return { file: absolute };
    });
    if (!('file' in found)) {
      return reply;
    }
    // Stream after COMMIT; the stream does not need the transaction.
    return reply.type('application/pdf').send(createReadStream((found as { file: string }).file));
  });

  /**
   * Asks for an archived file back (07 s2, 5.11). The document moves from `archived` to
   * `restore_requested` with a conditional UPDATE, its archive copies are marked requested for
   * the restore worker, and the request is audited. A request while a restore is already
   * pending (or done) changes nothing and answers with the current state, so a double click or
   * a concurrent request records one restore. Free organizations may restore only while
   * app_settings `restore_free_allowed` is true (the default).
   */
  app.post('/api/documents/:id/restore', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    const orgId = auth.orgId!;
    const documentId = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      if (isRestorePending(document.liveStatus)) {
        return { status: document.liveStatus };
      }
      if (document.liveStatus !== 'archived') {
        return respond(409, { error: 'This file is not archived' });
      }
      const settings = restoreSettings(await readSettings(db, [SETTING_RESTORE_FREE_ALLOWED, SETTING_RESTORE_WINDOW_DAYS]));
      if (!canRestore(await orgPlan(db, orgId), settings)) {
        return respond(402, apiError('plan_required', 'Restoring archived files needs a Starter or Growth plan.'));
      }
      const now = new Date();
      const [moved] = await db.update(schema.documents).set({
        liveStatus: 'restore_requested',
        updatedAt: now,
      }).where(and(
        eq(schema.documents.id, documentId),
        eq(schema.documents.orgId, orgId),
        eq(schema.documents.liveStatus, 'archived'),
      )).returning({ id: schema.documents.id });
      if (!moved) {
        // Another request changed the file first (this UPDATE waited for it and re-checked).
        const current = await findDocument(db, orgId, documentId);
        if (current && isRestorePending(current.liveStatus)) {
          return { status: current.liveStatus };
        }
        return respond(409, { error: 'This file is not archived' });
      }
      // The document is locked before its archive_objects rows, as document and bid deletes do.
      await db.update(schema.archiveObjects).set({
        restoreStatus: 'requested',
        restoreRequestedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.archiveObjects.documentId, documentId),
        eq(schema.archiveObjects.orgId, orgId),
        isNull(schema.archiveObjects.purgedAt),
      ));
      await db.insert(schema.auditLog).values({
        orgId,
        userId: auth.userId,
        action: 'restore_request',
        targetType: 'document',
        targetId: documentId,
        detail: { windowDays: settings.windowDays },
      });
      return { status: 'restore_requested' as const };
    });
  });

  /**
   * Deletes a file (05 s3.10): the server copies go and its MB is freed, but the document row,
   * its page text, and the tab rows and quotes it produced stay, so every source link still
   * opens the page text (07 s2 keeps page text until the bid is deleted). The row is marked
   * `live_status = 'deleted'`. A second delete is a no-op. Deleting the bid's last
   * solicitation while its credit is still reserved releases that credit.
   */
  app.delete('/api/documents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    const orgId = auth.orgId!;
    const documentId = (request.params as { id: string }).id;
    const files: string[] = [];
    const result = await inOrg(reply, orgId, async (db, respond) => {
      const document = await findDocument(db, orgId, documentId);
      if (!document) {
        return respond(404, { error: 'Document not found' });
      }
      const [deleted] = await db.update(schema.documents).set({
        liveStatus: 'deleted',
        storagePath: null,
        viewerPath: null,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.documents.id, documentId),
        eq(schema.documents.orgId, orgId),
        sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
      )).returning({ id: schema.documents.id });
      if (!deleted) {
        return { ok: true };
      }
      // The bid's last solicitation is gone before its compliance matrix settled the credit:
      // release the reservation (the worker skips a deleted document, so it will not consume).
      // releaseBidCredit flips credit_status conditionally, so a concurrent consume or release
      // by the worker settles it at most once.
      // Its archive copies go too: the purge job deletes expired copies (07 s2).
      await db.update(schema.archiveObjects).set({ expiresAt: new Date(), updatedAt: new Date() }).where(and(
        eq(schema.archiveObjects.documentId, documentId),
        eq(schema.archiveObjects.orgId, orgId),
        isNull(schema.archiveObjects.purgedAt),
      ));
      let creditReleased = false;
      if (document.kind === 'solicitation') {
        // Lock the bid (after this document, the same order as the worker) before counting, so
        // two deletes of the bid's last two solicitations cannot both see the other as live.
        await lockBid(db, orgId, document.bidId);
        const [remaining] = await db.select({ id: schema.documents.id }).from(schema.documents).where(and(
          eq(schema.documents.bidId, document.bidId),
          eq(schema.documents.orgId, orgId),
          eq(schema.documents.kind, 'solicitation'),
          sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
        )).limit(1);
        if (!remaining) {
          creditReleased = await releaseBidCredit(db, orgId, document.bidId);
        }
      }
      for (const path of [document.storagePath, document.viewerPath]) {
        const absolute = path ? resolveOrgPath(dataDir, orgId, path) : null;
        if (absolute) {
          files.push(absolute);
        }
      }
      await db.insert(schema.auditLog).values({
        orgId,
        userId: auth.userId,
        action: 'delete_document',
        targetType: 'document',
        targetId: documentId,
        detail: { kind: document.kind, creditReleased },
      });
      return { ok: true, creditReleased };
    });
    await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => undefined)));
    return result;
  });
}

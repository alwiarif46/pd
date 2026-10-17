import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isUuid, schema } from '@pd/core';
import { requireAuth } from './context.js';
import { findBid, inOrg } from './scope.js';

/*
 * "Check these" (05 s3.4, 09 s5.4): requirement-like sentences the pre-scan found that no
 * compliance row quotes. The worker writes them (services/worker/src/ai-jobs.ts processCompliance);
 * the user promotes one to a compliance row or dismisses it.
 *
 * Locking: check_these rows are locked after the document row and before the bid row, in
 * line with the credit lock order (credits.ts): the worker locks the document FOR UPDATE, then
 * replaces that document's open hits, then settles the bid's credit. Promote therefore takes
 * the document row FOR SHARE before it claims the hit, and only then inserts the compliance row
 * (whose foreign keys take KEY SHARE on the bid). FOR SHARE, not FOR KEY SHARE: it also waits
 * for a soft delete (an UPDATE of live_status, which takes only FOR NO KEY UPDATE), so a hit is
 * never promoted from a document deleted in the same instant. Claiming the hit is a
 * conditional UPDATE on status 'open': of two concurrent promotes, one wins and the other
 * gets 409, so a hit becomes at most one row.
 */

/** The req type a sentence states, as the pre-scan detects it. */
function reqTypeOf(sentence: string): 'shall' | 'must' | 'will' | 'should' | 'other' {
  const match = /\b(shall|must|will|should)\b/i.exec(sentence);
  return match ? (match[1].toLowerCase() as 'shall' | 'must' | 'will' | 'should') : 'other';
}

export async function registerCheckThese(app: FastifyInstance): Promise<void> {
  app.get('/api/bids/:id/check-these', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      if (!await findBid(db, orgId, bidId)) {
        return respond(404, { error: 'Bid not found' });
      }
      // Open hits of documents the user has not deleted.
      return db.select({
        id: schema.checkThese.id,
        documentId: schema.checkThese.documentId,
        sentence: schema.checkThese.sentence,
        page: schema.checkThese.pageNo,
      }).from(schema.checkThese)
        .innerJoin(schema.documents, and(
          eq(schema.documents.id, schema.checkThese.documentId),
          eq(schema.documents.orgId, orgId),
        ))
        .where(and(
          eq(schema.checkThese.bidId, bidId),
          eq(schema.checkThese.orgId, orgId),
          eq(schema.checkThese.status, 'open'),
          sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
        ))
        .orderBy(asc(schema.documents.createdAt), asc(schema.checkThese.pageNo), asc(schema.checkThese.createdAt), asc(schema.checkThese.id));
    });
  });

  app.post('/api/check-these/:id/promote', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const userId = request.auth!.userId;
    const id = (request.params as { id: string }).id;
    if (!isUuid(id)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return inOrg(reply, orgId, async (db, respond) => {
      const [hit] = await db.select().from(schema.checkThese)
        .where(and(eq(schema.checkThese.id, id), eq(schema.checkThese.orgId, orgId)));
      if (!hit) {
        return respond(404, { error: 'Not found' });
      }
      // Document before hit (see the header). A deleted document's hits are not shown or promoted.
      const [document] = await db.select({ liveStatus: schema.documents.liveStatus }).from(schema.documents)
        .where(and(eq(schema.documents.id, hit.documentId), eq(schema.documents.orgId, orgId)))
        .for('share');
      if (!document || document.liveStatus === 'deleted') {
        return respond(404, { error: 'Not found' });
      }
      // The row quotes the sentence as its source, so the sentence must still be on that page.
      const pages = await db.select({ text: schema.pages.text }).from(schema.pages).where(and(
        eq(schema.pages.documentId, hit.documentId),
        eq(schema.pages.orgId, orgId),
        eq(schema.pages.pageNo, hit.pageNo),
      ));
      if (!pages.some((page) => page.text.includes(hit.sentence))) {
        return respond(409, { error: 'That sentence is no longer on its page' });
      }
      const now = new Date();
      const [claimed] = await db.update(schema.checkThese).set({
        status: 'promoted',
        decidedBy: userId,
        decidedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.checkThese.id, id),
        eq(schema.checkThese.orgId, orgId),
        eq(schema.checkThese.status, 'open'),
      )).returning();
      if (!claimed) {
        // Decided meanwhile, or replaced by a rerun of the matrix.
        return respond(409, { error: 'That sentence was already added or dismissed' });
      }
      const [row] = await db.insert(schema.complianceRows).values({
        orgId,
        bidId: claimed.bidId,
        reqId: `user-${now.getTime()}`,
        requirementText: claimed.sentence,
        documentId: claimed.documentId,
        sourcePage: claimed.pageNo,
        // The pre-scan sentence is cut verbatim from the page text.
        sourceQuote: claimed.sentence,
        quoteVerified: true,
        reqType: reqTypeOf(claimed.sentence),
        status: 'open',
        origin: 'user',
      }).returning();
      await db.update(schema.checkThese).set({ promotedRowId: row.id })
        .where(and(eq(schema.checkThese.id, id), eq(schema.checkThese.orgId, orgId)));
      return respond(201, row);
    });
  });

  app.post('/api/check-these/:id/dismiss', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const userId = request.auth!.userId;
    const id = (request.params as { id: string }).id;
    if (!isUuid(id)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return inOrg(reply, orgId, async (db, respond) => {
      const now = new Date();
      const [dismissed] = await db.update(schema.checkThese).set({
        status: 'dismissed',
        decidedBy: userId,
        decidedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.checkThese.id, id),
        eq(schema.checkThese.orgId, orgId),
        eq(schema.checkThese.status, 'open'),
      )).returning({ id: schema.checkThese.id });
      if (dismissed) {
        return { ok: true };
      }
      const [hit] = await db.select({ id: schema.checkThese.id }).from(schema.checkThese)
        .where(and(eq(schema.checkThese.id, id), eq(schema.checkThese.orgId, orgId)));
      return hit
        ? respond(409, { error: 'That sentence was already added or dismissed' })
        : respond(404, { error: 'Not found' });
    });
  });
}

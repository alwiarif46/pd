import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isUuid, schema } from '@pd/core';
import { requireAuth } from './context.js';
import { confirmTabLink, isTabRowTable } from './amendment-tabs.js';
import { lockBid, shareOrg } from './credits.js';
import { apiError } from './errors.js';
import { findBid, inOrg } from './scope.js';

export async function registerAmendments(app: FastifyInstance): Promise<void> {
  /**
   * The bid's amendment links, each with its amendment's number, the rows it names (null when a
   * row is gone), and sourcePage and sourceQuote: the amendment text behind a supersede or
   * withdraw (null on add links and on links written before migration 0009). Links of the bid
   * facts and the schedule (step 8, PR5) name their rows too: a fact as its field and value, an
   * activity as its label and start day.
   */
  app.get('/api/bids/:id/amendment-links', { preHandler: requireAuth }, async (request, reply) => {
    const orgId = request.auth!.orgId!;
    const bidId = (request.params as { id: string }).id;
    return inOrg(reply, orgId, async (db, respond) => {
      const bid = await findBid(db, orgId, bidId);
      if (!bid) {
        return respond(404, { error: 'Bid not found' });
      }
      const amendments = await db.select({ id: schema.amendments.id, amendmentNo: schema.amendments.amendmentNo }).from(schema.amendments).where(and(
        eq(schema.amendments.bidId, bidId),
        eq(schema.amendments.orgId, orgId),
      ));
      if (amendments.length === 0) {
        return [];
      }
      const links = await db.select().from(schema.amendmentLinks).where(and(
        inArray(schema.amendmentLinks.amendmentId, amendments.map((amendment) => amendment.id)),
        eq(schema.amendmentLinks.orgId, orgId),
      ));
      const idsOf = (table: string) => [...new Set(links.flatMap((link) => (
        link.rowTable === table ? [link.oldRowId, link.newRowId] : []
      )).filter((id): id is string => Boolean(id)))];
      const rowIds = idsOf('compliance_rows');
      // Only rows of this organization and this bid: a link that names any other row gets null.
      const rows = rowIds.length === 0 ? [] : await db.select({
        id: schema.complianceRows.id,
        reqId: schema.complianceRows.reqId,
        requirementText: schema.complianceRows.requirementText,
        sourcePage: schema.complianceRows.sourcePage,
      }).from(schema.complianceRows).where(and(
        inArray(schema.complianceRows.id, rowIds),
        eq(schema.complianceRows.bidId, bidId),
        eq(schema.complianceRows.orgId, orgId),
      ));
      const byId = new Map(rows.map((row) => [`compliance_rows:${row.id}`, {
        rowId: row.id,
        label: row.reqId,
        text: row.requirementText,
        sourcePage: row.sourcePage,
      }]));
      const factIds = idsOf('bid_facts');
      const facts = factIds.length === 0 ? [] : await db.select({
        id: schema.bidFacts.id,
        field: schema.bidFacts.field,
        value: schema.bidFacts.value,
        sourcePage: schema.bidFacts.sourcePage,
      }).from(schema.bidFacts).where(and(
        inArray(schema.bidFacts.id, factIds),
        eq(schema.bidFacts.bidId, bidId),
        eq(schema.bidFacts.orgId, orgId),
      ));
      for (const fact of facts) {
        byId.set(`bid_facts:${fact.id}`, { rowId: fact.id, label: fact.field, text: fact.value, sourcePage: fact.sourcePage });
      }
      const activityIds = idsOf('schedule_activities');
      const activities = activityIds.length === 0 ? [] : await db.select({
        id: schema.scheduleActivities.id,
        label: schema.scheduleActivities.label,
        startDate: schema.scheduleActivities.startDate,
        sourcePage: schema.scheduleActivities.sourcePage,
      }).from(schema.scheduleActivities).where(and(
        inArray(schema.scheduleActivities.id, activityIds),
        eq(schema.scheduleActivities.bidId, bidId),
        eq(schema.scheduleActivities.orgId, orgId),
      ));
      for (const activity of activities) {
        byId.set(`schedule_activities:${activity.id}`, {
          rowId: activity.id,
          label: activity.label,
          text: activity.startDate ? activity.startDate.toISOString().slice(0, 10) : '',
          sourcePage: activity.sourcePage,
        });
      }
      const numbers = new Map(amendments.map((amendment) => [amendment.id, amendment.amendmentNo]));
      const lookup = (link: { rowTable: string }, id: string | null) => (id ? byId.get(`${link.rowTable}:${id}`) ?? null : null);
      return links.map((link) => ({
        ...link,
        amendmentNo: numbers.get(link.amendmentId) ?? null,
        oldRow: lookup(link, link.oldRowId),
        newRow: lookup(link, link.newRowId),
      }));
    });
  });

  app.post('/api/amendment-links/:id/confirm', { preHandler: requireAuth }, async (request, reply) => {
    return decide(request, reply, 'confirmed');
  });

  app.post('/api/amendment-links/:id/reject', { preHandler: requireAuth }, async (request, reply) => {
    return decide(request, reply, 'rejected');
  });
}

async function decide(
  request: FastifyRequest,
  reply: FastifyReply,
  status: 'confirmed' | 'rejected',
) {
  const orgId = request.auth!.orgId!;
  const linkId = (request.params as { id: string }).id;
  if (!isUuid(linkId)) {
    return reply.code(404).send({ error: 'Amendment link not found' });
  }
  const userId = request.auth!.userId;
  return inOrg(reply, orgId, async (db, respond) => {
    const notFound = () => respond(404, { error: 'Amendment link not found' });
    // Unlocked reads find the bid; everything is read again under the locks below.
    const [found] = await db.select({ amendmentId: schema.amendmentLinks.amendmentId }).from(schema.amendmentLinks).where(and(
      eq(schema.amendmentLinks.id, linkId),
      eq(schema.amendmentLinks.orgId, orgId),
    ));
    const [owner] = found ? await db.select({ bidId: schema.amendments.bidId }).from(schema.amendments).where(and(
      eq(schema.amendments.id, found.amendmentId),
      eq(schema.amendments.orgId, orgId),
    )) : [];
    if (!owner) {
      return notFound();
    }
    // Lock order: organization (key share, for the history rows), bid, amendment, link, rows by id
    // (apps/api/src/credits.ts), the same as the worker's amendment write.
    await shareOrg(db, orgId);
    const [bid] = await lockBid(db, orgId, owner.bidId);
    const [amendment] = bid ? await db.select().from(schema.amendments).where(and(
      eq(schema.amendments.id, found.amendmentId),
      eq(schema.amendments.orgId, orgId),
    )).for('update') : [];
    const [link] = amendment ? await db.select().from(schema.amendmentLinks).where(and(
      eq(schema.amendmentLinks.id, linkId),
      eq(schema.amendmentLinks.orgId, orgId),
    )).for('update') : [];
    if (!bid || !amendment || !link) {
      return notFound();
    }
    // Decisions are final: the same decision again is a no-op; the other one is refused.
    if (link.status === status) {
      return { ok: true, status: link.status, amendmentStatus: amendment.status };
    }
    if (link.status !== 'proposed') {
      return respond(409, apiError('link_already_decided'));
    }
    const now = new Date();
    if (status === 'confirmed' && isTabRowTable(link.rowTable) && link.action === 'supersede') {
      // Insert of an amendment's proposed fact or date (step 8): the proposed row joins the tab.
      const confirmed = await confirmTabLink(db, orgId, userId, bid.id, link.rowTable, link, amendment.amendmentNo);
      if (confirmed !== 'ok') {
        return respond(409, apiError(confirmed));
      }
    } else if (status === 'confirmed' && link.rowTable === 'compliance_rows' && link.oldRowId && (link.action === 'supersede' || link.action === 'withdraw')) {
      const ids = [link.oldRowId, ...(link.action === 'supersede' && link.newRowId ? [link.newRowId] : [])];
      const rows = await db.select({
        id: schema.complianceRows.id,
        supersedeStatus: schema.complianceRows.supersedeStatus,
        supersededByRowId: schema.complianceRows.supersededByRowId,
        changedByAmendment: schema.complianceRows.changedByAmendment,
      }).from(schema.complianceRows).where(and(
        inArray(schema.complianceRows.id, ids),
        eq(schema.complianceRows.bidId, bid.id),
        eq(schema.complianceRows.orgId, orgId),
      )).orderBy(asc(schema.complianceRows.id)).for('update');
      const old = rows.find((row) => row.id === link.oldRowId);
      if (!old || (old.supersedeStatus !== null && old.supersedeStatus !== 'active')) {
        return respond(409, apiError('row_already_closed'));
      }
      if (link.action === 'supersede' && !rows.some((row) => row.id === link.newRowId)) {
        return respond(409, apiError('new_row_missing'));
      }
      const next = {
        supersedeStatus: link.action === 'supersede' ? 'superseded' as const : 'withdrawn' as const,
        supersededByRowId: link.action === 'supersede' ? link.newRowId : null,
        changedByAmendment: amendment.amendmentNo,
      };
      await db.update(schema.complianceRows).set({ ...next, updatedAt: now }).where(and(
        eq(schema.complianceRows.id, old.id),
        eq(schema.complianceRows.orgId, orgId),
      ));
      const history = ([
        ['supersede_status', old.supersedeStatus ?? 'active', next.supersedeStatus],
        ['superseded_by_row_id', old.supersededByRowId, next.supersededByRowId],
        ['changed_by_amendment', old.changedByAmendment === null ? null : String(old.changedByAmendment),
          next.changedByAmendment === null ? null : String(next.changedByAmendment)],
      ] as const).filter(([, before, after]) => before !== after);
      if (history.length > 0) {
        await db.insert(schema.rowHistory).values(history.map(([field, oldValue, newValue]) => ({
          orgId, rowTable: 'compliance_rows', rowId: old.id, userId, field, oldValue, newValue, changedAt: now,
        })));
      }
    }
    await db.update(schema.amendmentLinks).set({ status, decidedBy: userId, updatedAt: now })
      .where(and(eq(schema.amendmentLinks.id, linkId), eq(schema.amendmentLinks.orgId, orgId)));
    // The last open proposal decided: the amendment is applied.
    let amendmentStatus = amendment.status;
    if (amendment.status === 'needs_confirmation') {
      const [open] = await db.select({ id: schema.amendmentLinks.id }).from(schema.amendmentLinks).where(and(
        eq(schema.amendmentLinks.amendmentId, amendment.id),
        eq(schema.amendmentLinks.orgId, orgId),
        eq(schema.amendmentLinks.status, 'proposed'),
      )).limit(1);
      if (!open) {
        amendmentStatus = 'applied';
        await db.update(schema.amendments).set({ status: 'applied', updatedAt: now })
          .where(and(eq(schema.amendments.id, amendment.id), eq(schema.amendments.orgId, orgId)));
      }
    }
    return { ok: true, status, amendmentStatus };
  });
}

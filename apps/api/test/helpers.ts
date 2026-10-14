import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getDb, schema, withOrg } from '@pd/core';
import { hashToken, newToken } from '../src/security.js';

export const ROW_TABLES = [
  'bid_facts',
  'kickoff_items',
  'schedule_activities',
  'compliance_rows',
  'outline_items',
  'personnel_requirements',
  'candidates',
  'resume_matches',
  'reviews',
  'review_assignments',
  'review_findings',
  'production_items',
  'orals_items',
  'lessons',
] as const;

export type RowTableName = (typeof ROW_TABLES)[number];

export const TABS = ['overview', 'schedule', 'compliance', 'outline', 'resumes', 'reviews', 'production', 'orals', 'lessons'] as const;

/** A verified user with a live session. `users` and `sessions` have no row-level security. */
export async function createUser(label: string): Promise<{ userId: string; token: string }> {
  const db = getDb();
  const userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `${label}-${userId}@example.com`,
    passwordHash: 'x:y',
    emailVerifiedAt: new Date(),
    phoneVerifiedAt: new Date(),
  });
  const token = newToken();
  await db.insert(schema.sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { userId, token };
}

export interface Tenant {
  userId: string;
  token: string;
  orgId: string;
  bidId: string;
  rows: Record<RowTableName, string>;
  /** A second compliance row, so merge has two rows to work with. */
  compliance2: string;
  documentId: string;
  jobId: string;
  amendmentId: string;
  amendmentLinkId: string;
  uploadSessionId: string;
  rowHistoryId: string;
  memberUserId: string;
}

export function as(app: FastifyInstance, token: string) {
  return (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/**
 * One organization with an owner, a second member, a bid, one row in every row table,
 * a document, a failed job, an amendment with a link, an open upload session, and a
 * row-history entry. The org and bid go through the api; the rest is written as pd_app
 * under `withOrg`, so every insert passes the row-level security check.
 */
export async function createTenant(app: FastifyInstance, label: string): Promise<Tenant> {
  const owner = await createUser(`${label}-owner`);
  const call = as(app, owner.token);
  const orgResponse = await call('POST', '/api/org', { name: `Org ${label}` });
  if (orgResponse.statusCode !== 201) {
    throw new Error(`POST /api/org failed: ${orgResponse.statusCode} ${orgResponse.body}`);
  }
  const orgId = orgResponse.json<{ id: string }>().id;
  const bidResponse = await call('POST', '/api/bids', { name: `Bid ${label}`, bidType: 'federal', solicitationNumber: `SOL-${label}` });
  if (bidResponse.statusCode !== 201) {
    throw new Error(`POST /api/bids failed: ${bidResponse.statusCode} ${bidResponse.body}`);
  }
  const bidId = bidResponse.json<{ id: string }>().id;
  const member = await createUser(`${label}-member`);

  const ids = await withOrg(orgId, async (db) => {
    await db.insert(schema.memberships).values({ orgId, userId: member.userId, role: 'member' });
    const base = { orgId, bidId };
    const [fact] = await db.insert(schema.bidFacts).values({ ...base, field: 'agency', value: `Agency ${label}` }).returning();
    const [kickoff] = await db.insert(schema.kickoffItems).values({ ...base, label: 'Roles' }).returning();
    const [activity] = await db.insert(schema.scheduleActivities).values({ ...base, label: 'Draft', startDate: new Date() }).returning();
    const [compliance] = await db.insert(schema.complianceRows).values({ ...base, reqId: 'L.1', requirementText: `The offeror shall ${label}.` }).returning();
    const [compliance2] = await db.insert(schema.complianceRows).values({ ...base, reqId: 'L.2', requirementText: `The offeror shall also ${label}.` }).returning();
    const [outline] = await db.insert(schema.outlineItems).values({ ...base, title: 'Technical' }).returning();
    const [requirement] = await db.insert(schema.personnelRequirements).values({ ...base, role: 'PM', requirement: 'PMP' }).returning();
    const [candidate] = await db.insert(schema.candidates).values({ ...base, name: 'Pat', role: 'PM' }).returning();
    const [match] = await db.insert(schema.resumeMatches).values({ orgId, candidateId: candidate.id, requirementId: requirement.id, result: 'meets' }).returning();
    const [review] = await db.insert(schema.reviews).values({ ...base, type: 'red' }).returning();
    const [assignment] = await db.insert(schema.reviewAssignments).values({ orgId, reviewId: review.id, reviewerName: 'Sam' }).returning();
    const [finding] = await db.insert(schema.reviewFindings).values({ orgId, reviewId: review.id, kind: 'strength', text: 'Clear' }).returning();
    const [production] = await db.insert(schema.productionItems).values({ ...base, category: 'Fonts', rule: '12pt' }).returning();
    const [oral] = await db.insert(schema.oralsItems).values({ ...base, category: 'Rules', item: '30 minutes' }).returning();
    const [lesson] = await db.insert(schema.lessons).values({ ...base, question: 'What worked?', answer: '' }).returning();
    const [document] = await db.insert(schema.documents).values({
      ...base,
      fileName: 'rfp.pdf',
      mime: 'application/pdf',
      sizeBytes: 10,
      sha256: `sha-${label}`,
      kind: 'solicitation',
      storagePath: 'docs/rfp.pdf',
      markingStatus: 'blocked',
      liveStatus: 'archived',
    }).returning();
    await db.insert(schema.pages).values({ orgId, documentId: document.id, pageNo: 1, text: `Page of ${label}` });
    const [job] = await db.insert(schema.jobs).values({ ...base, documentId: document.id, type: 'scan', status: 'failed' }).returning();
    const [amendment] = await db.insert(schema.amendments).values({
      ...base,
      documentId: document.id,
      amendmentNo: 1,
      solicitationKeyFound: true,
      status: 'needs_confirmation',
    }).returning();
    const [link] = await db.insert(schema.amendmentLinks).values({
      orgId,
      amendmentId: amendment.id,
      rowTable: 'compliance_rows',
      oldRowId: compliance.id,
      action: 'withdraw',
      status: 'proposed',
    }).returning();
    const [upload] = await db.insert(schema.uploadSessions).values({
      ...base,
      userId: owner.userId,
      fileName: 'a.pdf',
      kind: 'attachment',
      declaredSize: 3,
      sha256: 'x',
      chunkCount: 1,
      status: 'open',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }).returning();
    const [history] = await db.insert(schema.rowHistory).values({
      orgId,
      rowTable: 'compliance_rows',
      rowId: compliance.id,
      field: 'status',
      newValue: 'open',
      changedAt: new Date(),
    }).returning();
    return {
      rows: {
        bid_facts: fact.id,
        kickoff_items: kickoff.id,
        schedule_activities: activity.id,
        compliance_rows: compliance.id,
        outline_items: outline.id,
        personnel_requirements: requirement.id,
        candidates: candidate.id,
        resume_matches: match.id,
        reviews: review.id,
        review_assignments: assignment.id,
        review_findings: finding.id,
        production_items: production.id,
        orals_items: oral.id,
        lessons: lesson.id,
      } satisfies Record<RowTableName, string>,
      compliance2: compliance2.id,
      documentId: document.id,
      jobId: job.id,
      amendmentId: amendment.id,
      amendmentLinkId: link.id,
      uploadSessionId: upload.id,
      rowHistoryId: history.id,
    };
  });

  return {
    userId: owner.userId,
    token: owner.token,
    orgId,
    bidId,
    memberUserId: member.userId,
    ...ids,
    rows: { ...ids.rows },
  };
}

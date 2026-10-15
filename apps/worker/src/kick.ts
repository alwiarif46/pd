import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { amendmentKickJobId, nextAmendmentToRun, schema, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
import { recordQueueFailure, shareOrg } from './key-check.js';
import type { JobPayload } from './redis.js';
import { HELD_FOR_CREDIT, markJobFailed, SOLICITATION_CREDIT_RELEASED } from './rows.js';

/**
 * Queues ai:amendment for the bid's next amendment (04 s3.1): the lowest-numbered one in
 * processing whose document is not deleted. Called after COMMIT whenever an amendment may have
 * stopped waiting: an amendment run applied or failed, the solicitation's matrix consumed the
 * credit, or (from the api) an amendment was deleted. The BullMQ id is fresh each time, since an
 * id BullMQ has seen is ignored. A failed queue call is logged and recorded as a failed classify
 * step the user can retry; it never fails the caller.
 */
export async function kickAmendments(orgId: string, bidId: string): Promise<void> {
  let payload: JobPayload | null = null;
  try {
    const next = await withOrg(orgId, (db) => nextAmendmentToRun(db, orgId, bidId));
    if (!next) {
      return;
    }
    payload = {
      orgId,
      bidId,
      documentId: next.documentId,
      jobId: randomUUID(),
      storagePath: next.storagePath ?? '',
      kind: 'amendment',
    };
    await enqueue('ai:amendment', payload, { jobId: amendmentKickJobId(next.documentId) });
  } catch (error) {
    console.error(`Could not queue the next amendment of bid ${bidId}`, error);
    if (payload) {
      await recordQueueFailure(payload);
    }
  }
}

/**
 * Reruns classify for the bid's held files after the solicitation's matrix consumed the credit
 * (06 s4): live attachments and amendments whose latest job is the failed classify row
 * HELD_FOR_CREDIT, and solicitations whose latest is SOLICITATION_CREDIT_RELEASED (credit-gate.ts,
 * the key check, or a matrix run wrote it while the credit was released). Each gets a pending
 * classify row and a classify job; classify checks the credit again under the bid lock. Called
 * after COMMIT. A failed queue call fails that row (the user retries it); nothing here throws.
 */
export async function kickHeldDocuments(orgId: string, bidId: string): Promise<void> {
  let held: JobPayload[] = [];
  try {
    held = await withOrg(orgId, async (db) => {
      // Lock order (credits.ts): organization key share (for the job inserts), then the bid's
      // candidate documents FOR UPDATE by id. The retry route takes the same document lock before
      // it adds a job, so a manual retry and this kick never both rerun one file: whichever comes
      // second sees the other's newer job row.
      await shareOrg(db, orgId);
      const documents = await db.select({
        id: schema.documents.id,
        kind: schema.documents.kind,
        storagePath: schema.documents.storagePath,
      }).from(schema.documents).where(and(
        eq(schema.documents.bidId, bidId),
        eq(schema.documents.orgId, orgId),
        inArray(schema.documents.kind, ['solicitation', 'attachment', 'amendment']),
        sql`${schema.documents.liveStatus} is distinct from 'deleted'`,
      )).orderBy(asc(schema.documents.id)).for('update');
      if (documents.length === 0) {
        return [];
      }
      const jobs = await db.select({
        documentId: schema.jobs.documentId,
        type: schema.jobs.type,
        status: schema.jobs.status,
        error: schema.jobs.error,
      }).from(schema.jobs).where(and(
        eq(schema.jobs.orgId, orgId),
        inArray(schema.jobs.documentId, documents.map((document) => document.id)),
      )).orderBy(desc(schema.jobs.createdAt), desc(schema.jobs.id));
      const latest = new Map<string, (typeof jobs)[number]>();
      for (const job of jobs) {
        if (job.documentId && !latest.has(job.documentId)) {
          latest.set(job.documentId, job);
        }
      }
      const payloads: JobPayload[] = [];
      for (const document of documents) {
        const job = latest.get(document.id);
        // A solicitation stopped because a sibling's failure released the credit runs too: the
        // set's credit is consumed now, so its matrix joins the set's.
        const marker = document.kind === 'solicitation' ? SOLICITATION_CREDIT_RELEASED : HELD_FOR_CREDIT;
        if (job?.type !== 'classify' || job.status !== 'failed' || job.error !== marker) {
          continue;
        }
        const [created] = await db.insert(schema.jobs).values({
          orgId,
          bidId,
          documentId: document.id,
          type: 'classify',
          status: 'pending',
        }).returning({ id: schema.jobs.id });
        payloads.push({
          orgId,
          bidId,
          documentId: document.id,
          jobId: created.id,
          storagePath: document.storagePath ?? '',
          kind: document.kind as JobPayload['kind'],
        });
      }
      return payloads;
    });
  } catch (error) {
    console.error(`Could not look up the held files of bid ${bidId}`, error);
    return;
  }
  for (const payload of held) {
    try {
      await enqueue('classify', payload);
    } catch (error) {
      console.error(`Could not queue held file ${payload.documentId}`, error);
      await markJobFailed(payload, 'The step could not be queued. Retry it.');
    }
  }
}

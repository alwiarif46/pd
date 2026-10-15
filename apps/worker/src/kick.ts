import { randomUUID } from 'node:crypto';
import { amendmentKickJobId, nextAmendmentToRun, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
import { recordQueueFailure } from './key-check.js';
import type { JobPayload } from './redis.js';

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

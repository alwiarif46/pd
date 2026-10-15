import { withOrg } from '@pd/core';
import { settleCreditIn } from './ai-jobs.js';
import { shareOrg } from './key-check.js';
import { MARKING_REJECTED } from './marking-job.js';
import type { JobPayload } from './redis.js';
import { failStepIn } from './rows.js';

/** The queues whose failures guardStep records. */
export type GuardedQueue = 'scan' | 'file' | 'marking' | 'classify' | 'ai:compliance';

/**
 * The failed job row each queue leaves, and its message. A scan, file or marking failure leaves a
 * `scan` row, since the retry restarts from the stored file (scan, then file, marking, classify);
 * a classify or matrix failure leaves a `classify` row (the retry queues classify, which queues
 * the matrix again). Messages are fixed: an exception's text can name internals.
 */
const FAILED_STEP: Record<GuardedQueue, { type: 'scan' | 'classify'; error: string }> = {
  scan: { type: 'scan', error: 'The virus scan could not be completed' },
  file: { type: 'scan', error: 'The text could not be read from this file. Retry it.' },
  marking: { type: 'scan', error: 'The marking check could not be completed. Retry it.' },
  classify: { type: 'classify', error: 'Processing failed. Retry it.' },
  'ai:compliance': { type: 'classify', error: 'The compliance matrix could not be built. Retry it.' },
};

/**
 * A step of the file pipeline threw (06 s4: "If processing fails, the reservation is released").
 * In one transaction: a failed job row the user can retry from the Processing panel, and, for a
 * solicitation, the bid's reservation released (a conditional update, so a reservation already
 * consumed or released is left alone, and the retry reserves again). A marking block is not a
 * failure: processMarking returns without throwing, and the file keeps its reservation until the
 * user confirms or deletes it (owner decision, 16 Oct 2026).
 *
 * Lock order (credits.ts): organization (key share, for the job insert), then the bid and the
 * credit inside settleCreditIn. Logged, never thrown: the caller rethrows the original error.
 */
export async function recordStepFailure(queue: GuardedQueue, payload: JobPayload, error: unknown): Promise<void> {
  const step = FAILED_STEP[queue];
  const message = queue === 'marking' && error instanceof Error && error.message === MARKING_REJECTED
    ? MARKING_REJECTED
    : step.error;
  try {
    await withOrg(payload.orgId, async (db) => {
      await shareOrg(db, payload.orgId);
      await failStepIn(db, payload, step.type, message);
      if (payload.kind === 'solicitation') {
        await settleCreditIn(db, payload.orgId, payload.bidId, 'release');
      }
    });
  } catch (recordError) {
    console.error(`Could not record the failed ${queue} step of document ${payload.documentId}`, recordError);
  }
}

/** Wraps a queue handler: a throw is recorded by recordStepFailure, then rethrown to BullMQ. */
export function guardStep(queue: GuardedQueue, handler: (payload: JobPayload) => Promise<unknown>) {
  return async (payload: JobPayload): Promise<void> => {
    try {
      await handler(payload);
    } catch (error) {
      await recordStepFailure(queue, payload, error);
      throw error;
    }
  };
}

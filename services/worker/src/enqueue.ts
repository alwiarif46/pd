import { Queue } from 'bullmq';
import { queueJobId } from '@pd/core';
import { redisOptions, type JobPayload } from './redis.js';

const queues = new Map<string, Queue<JobPayload>>();

export function getQueue(name: string): Queue<JobPayload> {
  const existing = queues.get(name);
  if (existing) {
    return existing;
  }
  const queue = new Queue<JobPayload>(name, { connection: redisOptions });
  queues.set(name, queue);
  return queue;
}

/**
 * Queues a job. The BullMQ id is queueJobId(name, payload.jobId) (colon-free, packages/core
 * job-ids.ts) unless `options.jobId` overrides it. Jobs are kept after they finish (no
 * removeOnComplete), so a second add under an id BullMQ has seen is silently ignored: a job that
 * must run again under one payload (the amendment kick) passes a fresh id.
 */
export async function enqueue(name: string, payload: JobPayload, options: { jobId?: string } = {}): Promise<void> {
  await getQueue(name).add(name, payload, { jobId: options.jobId ?? queueJobId(name, payload.jobId) });
}

import { Queue } from 'bullmq';
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

export async function enqueue(name: string, payload: JobPayload): Promise<void> {
  await getQueue(name).add(name, payload, { jobId: `${name}:${payload.jobId}` });
}

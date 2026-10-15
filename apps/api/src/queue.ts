import { Queue } from 'bullmq';
import { queueJobId } from '@pd/core';

export interface ScanJob {
  orgId: string;
  bidId: string;
  documentId: string;
  jobId: string;
  storagePath: string;
  kind: 'solicitation' | 'amendment' | 'attachment' | 'resume' | 'draft';
}

let scanQueue: Queue<ScanJob> | null = null;

export function getScanQueue(): Queue<ScanJob> {
  if (!scanQueue) {
    scanQueue = new Queue<ScanJob>('scan', {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
    });
  }
  return scanQueue;
}

export async function enqueueScan(payload: ScanJob): Promise<void> {
  await getScanQueue().add('scan', payload, { jobId: queueJobId('scan', payload.jobId) });
}

/**
 * Queues the worker's amendment step (04 s3.1) under a BullMQ id the caller makes unique: an id
 * BullMQ has seen before is ignored.
 */
export async function enqueueAmendment(payload: ScanJob, jobId: string): Promise<void> {
  const queue = new Queue<ScanJob>('ai:amendment', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
    },
  });
  await queue.add('ai:amendment', payload, { jobId });
  await queue.close();
}

export async function enqueueClassify(payload: ScanJob): Promise<void> {
  const queue = new Queue<ScanJob>('classify', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
    },
  });
  await queue.add('classify', payload, { jobId: queueJobId('classify', payload.jobId) });
  await queue.close();
}

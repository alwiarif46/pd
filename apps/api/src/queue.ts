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

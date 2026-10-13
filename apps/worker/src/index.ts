import { Worker } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
});

console.log('Worker starting...');

// Scan job
const scanWorker = new Worker(
  'scan',
  async (job) => {
    console.log('Processing scan job:', job.id);
    // TODO: Implement ClamAV scan
    return { success: true };
  },
  { connection }
);

// File processing job
const fileWorker = new Worker(
  'file',
  async (job) => {
    console.log('Processing file job:', job.id);
    // TODO: Implement file processing via sandbox
    return { success: true };
  },
  { connection }
);

console.log('Worker running');

process.on('SIGTERM', async () => {
  await scanWorker.close();
  await fileWorker.close();
  await connection.quit();
});

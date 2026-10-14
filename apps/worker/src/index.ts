import { Worker } from 'bullmq';
import { assertTenantRole } from '@pd/core';
import { processAmendmentJob, processCompliance, processDates, processOverview } from './ai-jobs.js';
import { processClassify } from './classify-job.js';
import { processFile } from './file-job.js';
import { processMarking } from './marking-job.js';
import { redisOptions, type JobPayload } from './redis.js';
import { processScan } from './scan.js';

function start(name: string, handler: (payload: JobPayload) => Promise<void>): Worker<JobPayload> {
  return new Worker<JobPayload>(name, async (job) => {
    await handler(job.data);
  }, { connection: redisOptions });
}

const workers = [
  start('scan', processScan),
  start('file', processFile),
  start('marking', processMarking),
  start('classify', processClassify),
  start('ai:compliance', processCompliance),
  start('ai:dates', processDates),
  start('ai:overview', processOverview),
  start('ai:amendment', processAmendmentJob),
];

console.log('Worker running');

// Tenant isolation depends on row-level security, which a superuser or BYPASSRLS role
// skips. Stop in production when connected as such a role; warn elsewhere.
assertTenantRole().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.NODE_ENV === 'production') {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
});

async function shutdown(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
}

process.on('SIGTERM', () => {
  shutdown().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
});

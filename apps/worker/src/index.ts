import { Worker } from 'bullmq';
import { enforceTenantRole } from '@pd/core';
import { processCompliance, processDates, processOverview } from './ai-jobs.js';
import { processAmendmentJob } from './amendment-job.js';
import { processClassify } from './classify-job.js';
import { processFile } from './file-job.js';
import { processMarking } from './marking-job.js';
import { redisOptions, type JobPayload } from './redis.js';
import { processScan } from './scan.js';
import { guardStep } from './steps.js';

// Tenant isolation depends on row-level security, which a superuser or BYPASSRLS role
// skips. Check before taking any job; only PD_ALLOW_BYPASS_RLS=1 turns the refusal into
// a warning.
try {
  await enforceTenantRole();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function start(name: string, handler: (payload: JobPayload) => Promise<void>): Worker<JobPayload> {
  return new Worker<JobPayload>(name, async (job) => {
    await handler(job.data);
  }, { connection: redisOptions });
}

const workers = [
  // A throw in these steps leaves a failed job row the user can retry and releases a
  // solicitation's reservation (steps.ts). The AI steps for overview and dates settle no credit.
  start('scan', guardStep('scan', processScan)),
  start('file', guardStep('file', processFile)),
  start('marking', guardStep('marking', processMarking)),
  start('classify', guardStep('classify', processClassify)),
  start('ai:compliance', guardStep('ai:compliance', processCompliance)),
  start('ai:dates', processDates),
  start('ai:overview', processOverview),
  start('ai:amendment', async (payload) => {
    await processAmendmentJob(payload);
  }),
];

console.log('Worker running');

async function shutdown(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
}

process.on('SIGTERM', () => {
  shutdown().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
});

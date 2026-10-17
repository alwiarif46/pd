import { unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { resolveOrgPath, schema, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
import { expectOneRow, markJobFailed } from './rows.js';
import { dataDir, type JobPayload } from './redis.js';

/**
 * Asks clamd to scan a path. The worker does not read the file bytes.
 */
export function scanPath(filePath: string): Promise<string> {
  const host = process.env.CLAMD_HOST || '127.0.0.1';
  const port = Number(process.env.CLAMD_PORT) || 3310;
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let response = '';
    socket.setTimeout(120_000);
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('ClamAV scan timed out'));
    });
    socket.on('error', reject);
    socket.on('end', () => resolve(response.trim()));
    socket.write(`nSCAN ${filePath}\n`);
  });
}

export async function processScan(payload: JobPayload): Promise<void> {
  // The stored path must stay inside this organization's folder; otherwise fail the job.
  const filePath = resolveOrgPath(dataDir, payload.orgId, payload.storagePath);
  if (!filePath) {
    await markJobFailed(payload, 'The stored file path is not valid');
    throw new Error(`Stored path outside the organization folder for job ${payload.jobId}`);
  }
  let infected = false;
  try {
    const response = await scanPath(filePath);
    infected = response.includes('FOUND');
    await recordScan(payload, infected);
  } catch (error) {
    // recordScan rolls back as a whole (expectOneRow, a lost connection), and a clamd failure
    // never reaches it; either way the job row would stay pending. Fail it on its own.
    await markJobFailed(payload, 'The virus scan could not be completed');
    throw error;
  }
  if (infected) {
    await unlink(filePath).catch(() => undefined);
    throw new Error('File failed the virus scan');
  }
  await enqueue('file', payload);
}

async function recordScan(payload: JobPayload, infected: boolean): Promise<void> {
  await withOrg(payload.orgId, async (db) => {
    expectOneRow('document', await db.update(schema.documents).set({
      scanStatus: infected ? 'infected' : 'clean',
      updatedAt: new Date(),
    }).where(and(eq(schema.documents.id, payload.documentId), eq(schema.documents.orgId, payload.orgId))).returning({ id: schema.documents.id }));
    expectOneRow('job', await db.update(schema.jobs).set({
      status: infected ? 'failed' : 'completed',
      error: infected ? 'File failed the virus scan' : null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(schema.jobs.id, payload.jobId), eq(schema.jobs.orgId, payload.orgId))).returning({ id: schema.jobs.id }));
  });
}

import { unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { eq } from 'drizzle-orm';
import { schema, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
import { dataDir, type JobPayload } from './redis.js';
import { join } from 'node:path';

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
  const filePath = join(dataDir, payload.orgId, payload.storagePath);
  const response = await scanPath(filePath);
  const infected = response.includes('FOUND');
  await withOrg(payload.orgId, async (db) => {
    await db.update(schema.documents).set({
      scanStatus: infected ? 'infected' : 'clean',
      updatedAt: new Date(),
    }).where(eq(schema.documents.id, payload.documentId));
    await db.update(schema.jobs).set({
      status: infected ? 'failed' : 'completed',
      error: infected ? 'File failed the virus scan' : null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.jobs.id, payload.jobId));
  });
  if (infected) {
    await unlink(filePath).catch(() => undefined);
    throw new Error('File failed the virus scan');
  }
  await enqueue('file', payload);
}

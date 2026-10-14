import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
import { expectOneRow } from './rows.js';
import { dataDir, type JobPayload } from './redis.js';

interface SandboxPage {
  pageNo: number;
  text: string;
  ocrUsed: boolean;
}

interface SandboxResult {
  success: boolean;
  error?: string;
  pages: SandboxPage[];
  metadata: {
    pageCount: number;
    encryption: 'none' | 'owner_password' | 'user_password';
    pagesEstimated: boolean;
    extractMethod: 'pdf_text' | 'ocr' | 'docx_pdf' | 'docx_text_fallback' | 'xlsx';
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readSandboxResult(value: unknown): SandboxResult {
  if (!isRecord(value) || typeof value.success !== 'boolean' || !isRecord(value.metadata) || !Array.isArray(value.pages)) {
    throw new Error('Sandbox result JSON is invalid');
  }
  const pages: SandboxPage[] = value.pages.map((page) => {
    if (!isRecord(page) || typeof page.pageNo !== 'number' || typeof page.text !== 'string' || typeof page.ocrUsed !== 'boolean') {
      throw new Error('Sandbox page JSON is invalid');
    }
    return { pageNo: page.pageNo, text: page.text, ocrUsed: page.ocrUsed };
  });
  const metadata = value.metadata;
  const encryption = metadata.encryption;
  const extractMethod = metadata.extractMethod;
  if (encryption !== 'none' && encryption !== 'owner_password' && encryption !== 'user_password') {
    throw new Error('Sandbox encryption value is invalid');
  }
  if (
    extractMethod !== 'pdf_text'
    && extractMethod !== 'ocr'
    && extractMethod !== 'docx_pdf'
    && extractMethod !== 'docx_text_fallback'
    && extractMethod !== 'xlsx'
  ) {
    throw new Error('Sandbox extract method is invalid');
  }
  return {
    success: value.success,
    error: typeof value.error === 'string' ? value.error : undefined,
    pages,
    metadata: {
      pageCount: typeof metadata.pageCount === 'number' ? metadata.pageCount : pages.length,
      encryption,
      pagesEstimated: metadata.pagesEstimated === true,
      extractMethod,
    },
  };
}

export async function processFile(payload: JobPayload): Promise<void> {
  const outputDir = `out/${payload.documentId}`;
  const response = await fetch(process.env.SANDBOX_RUNNER_URL || 'http://127.0.0.1:3002/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: payload.jobId,
      orgId: payload.orgId,
      inputPath: payload.storagePath,
      outputDir,
    }),
  });
  if (!response.ok) {
    throw new Error(`Sandbox runner failed: ${response.status}`);
  }
  const resultPath = join(dataDir, payload.orgId, outputDir, 'result.json');
  const parsed = readSandboxResult(JSON.parse(readFileSync(resultPath, 'utf-8')) as unknown);
  if (!parsed.success) {
    throw new Error(parsed.error || 'Sandbox processing failed');
  }

  await withOrg(payload.orgId, async (db) => {
    await db.insert(schema.pages).values(parsed.pages.map((page) => ({
      orgId: payload.orgId,
      documentId: payload.documentId,
      pageNo: page.pageNo,
      text: page.text,
      ocrUsed: page.ocrUsed,
    })));
    expectOneRow('document', await db.update(schema.documents).set({
      extractStatus: 'ready',
      pageCount: parsed.metadata.pageCount,
      encryption: parsed.metadata.encryption,
      extractMethod: parsed.metadata.extractMethod,
      pagesEstimated: parsed.metadata.pagesEstimated ? 1 : 0,
      viewerPath: payload.storagePath,
      updatedAt: new Date(),
    }).where(and(eq(schema.documents.id, payload.documentId), eq(schema.documents.orgId, payload.orgId))).returning({ id: schema.documents.id }));
  });
  await enqueue('marking', payload);
}

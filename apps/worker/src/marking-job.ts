import { eq } from 'drizzle-orm';
import { schema, withOrg } from '@pd/core';
import { checkDocumentForMarkings } from '@pd/ai';
import { enqueue } from './enqueue.js';
import type { JobPayload } from './redis.js';

export async function processMarking(payload: JobPayload): Promise<void> {
  const decision = await withOrg(payload.orgId, async (db) => {
    const pageRows = await db.select().from(schema.pages).where(eq(schema.pages.documentId, payload.documentId));
    const result = checkDocumentForMarkings(pageRows.map((page) => ({ text: page.text, pageNo: page.pageNo })));
    if (result.shouldReject) {
      await db.update(schema.documents).set({
        markingStatus: 'blocked',
        markingFound: result.markings.map((marking) => marking.marking),
        extractStatus: 'rejected',
        updatedAt: new Date(),
      }).where(eq(schema.documents.id, payload.documentId));
      return 'reject' as const;
    }
    if (result.shouldBlock) {
      await db.update(schema.documents).set({
        markingStatus: 'blocked',
        markingFound: result.markings.map((marking) => marking.marking),
        updatedAt: new Date(),
      }).where(eq(schema.documents.id, payload.documentId));
      return 'block' as const;
    }
    await db.update(schema.documents).set({
      markingStatus: 'none',
      updatedAt: new Date(),
    }).where(eq(schema.documents.id, payload.documentId));
    return 'clear' as const;
  });

  if (decision === 'reject') {
    throw new Error('Classified marking found. The file was rejected.');
  }
  if (decision === 'clear') {
    await enqueue('classify', payload);
  }
}

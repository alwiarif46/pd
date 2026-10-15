import { and, eq } from 'drizzle-orm';
import { schema, withOrg } from '@pd/core';
import { checkDocumentForMarkings } from '@pd/ai';
import { enqueue } from './enqueue.js';
import { expectOneRow } from './rows.js';
import type { JobPayload } from './redis.js';

/** The lowest page among the markings found, or null when there are none (5.11 MarkingState). */
export function lowestMarkingPage(markings: { page: number }[]): number | null {
  return markings.length === 0 ? null : Math.min(...markings.map((marking) => marking.page));
}

export async function processMarking(payload: JobPayload): Promise<void> {
  const decision = await withOrg(payload.orgId, async (db) => {
    const pageRows = await db.select().from(schema.pages).where(eq(schema.pages.documentId, payload.documentId));
    const result = checkDocumentForMarkings(pageRows.map((page) => ({ text: page.text, pageNo: page.pageNo })));
    const markingPage = lowestMarkingPage(result.markings);
    if (result.shouldReject) {
      expectOneRow('document', await db.update(schema.documents).set({
        markingStatus: 'blocked',
        markingFound: result.markings.map((marking) => marking.marking),
        markingPage,
        extractStatus: 'rejected',
        updatedAt: new Date(),
      }).where(and(eq(schema.documents.id, payload.documentId), eq(schema.documents.orgId, payload.orgId))).returning({ id: schema.documents.id }));
      return 'reject' as const;
    }
    if (result.shouldBlock) {
      expectOneRow('document', await db.update(schema.documents).set({
        markingStatus: 'blocked',
        markingFound: result.markings.map((marking) => marking.marking),
        markingPage,
        updatedAt: new Date(),
      }).where(and(eq(schema.documents.id, payload.documentId), eq(schema.documents.orgId, payload.orgId))).returning({ id: schema.documents.id }));
      return 'block' as const;
    }
    expectOneRow('document', await db.update(schema.documents).set({
      markingStatus: 'none',
      markingPage: null,
      updatedAt: new Date(),
    }).where(and(eq(schema.documents.id, payload.documentId), eq(schema.documents.orgId, payload.orgId))).returning({ id: schema.documents.id }));
    return 'clear' as const;
  });

  if (decision === 'reject') {
    throw new Error('Classified marking found. The file was rejected.');
  }
  if (decision === 'clear') {
    await enqueue('classify', payload);
  }
}

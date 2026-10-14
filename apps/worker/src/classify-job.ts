import { and, eq } from 'drizzle-orm';
import { classifyPages } from '@pd/ai';
import { schema, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
import type { JobPayload } from './redis.js';

/** True when the bid's solicitation holds a reserved or consumed credit. */
export async function bidHoldsCredit(payload: Pick<JobPayload, 'orgId' | 'bidId'>): Promise<boolean> {
  const [bid] = await withOrg(payload.orgId, (db) => db.select({ creditStatus: schema.bids.creditStatus })
    .from(schema.bids)
    .where(and(eq(schema.bids.id, payload.bidId), eq(schema.bids.orgId, payload.orgId))));
  return bid?.creditStatus === 'reserved' || bid?.creditStatus === 'consumed';
}

export async function processClassify(payload: JobPayload): Promise<void> {
  await withOrg(payload.orgId, async (db) => {
    const pageRows = await db.select().from(schema.pages).where(eq(schema.pages.documentId, payload.documentId));
    const classified = classifyPages(pageRows.map((page) => ({
      pageNo: page.pageNo,
      text: page.text,
      ocrUsed: page.ocrUsed,
    })));
    for (const page of classified) {
      const row = pageRows.find((item) => item.pageNo === page.pageNo);
      if (!row) {
        continue;
      }
      await db.update(schema.pages).set({
        sectionTag: page.role,
        updatedAt: new Date(),
      }).where(eq(schema.pages.id, row.id));
    }
  });

  // Attachments and amendments are processed free only as part of a solicitation set that has
  // a credit behind it (06 s4); otherwise an RFP labelled "attachment" would get a free matrix.
  if ((payload.kind === 'attachment' || payload.kind === 'amendment') && !await bidHoldsCredit(payload)) {
    return;
  }
  if (payload.kind === 'amendment') {
    await enqueue('ai:amendment', payload);
    return;
  }
  // The free tabs read the solicitation set: the solicitation and its attachments (00 s3).
  // Resumes and draft volumes feed the paid resume and review tabs, whose AI steps are not
  // built yet; they must not add compliance rows or bid facts.
  if (payload.kind !== 'solicitation' && payload.kind !== 'attachment') {
    return;
  }
  await enqueue('ai:overview', payload);
  await enqueue('ai:dates', payload);
  await enqueue('ai:compliance', payload);
}

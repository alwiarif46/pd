import { eq } from 'drizzle-orm';
import { classifyPages } from '@pd/ai';
import { schema, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
import { checkCredit } from './credit-gate.js';
import { runKeyCheck } from './key-check.js';
import { completeClassifyJob } from './rows.js';
import type { JobPayload } from './redis.js';

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

  if (payload.kind === 'amendment') {
    // The solicitation-number check decides, under the bid lock, whether ai:amendment runs
    // (04 s3.1 step 1). It checks the credit under the same lock: without one the amendment is
    // held visibly and rerun when the solicitation's matrix consumes a credit (kickHeldDocuments).
    await runKeyCheck(payload);
    return;
  }
  // The solicitation set is processed only while the bid's solicitation holds a credit (06 s4):
  // attachments are free as part of a set with a credit behind it (otherwise an RFP labelled
  // "attachment" would get a free matrix), and a solicitation whose credit was released (a
  // sibling file failed) needs its retry to reserve one. Without a credit the file is stopped
  // visibly, not dropped: a held attachment reruns when the solicitation's matrix consumes a
  // credit (credit-gate.ts, kickHeldDocuments).
  if ((payload.kind === 'solicitation' || payload.kind === 'attachment')
    && await checkCredit(payload) !== 'go') {
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
  // The matrix step is queued now and settles the credit itself: a failure from here on must not
  // fail classify (guardStep would release the credit the queued matrix is about to use).
  try {
    await completeClassifyJob(payload);
  } catch (error) {
    console.error(`Could not close classify job ${payload.jobId}`, error);
  }
}

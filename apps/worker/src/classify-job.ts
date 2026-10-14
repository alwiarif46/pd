import { eq } from 'drizzle-orm';
import { classifyPages } from '@pd/ai';
import { schema, withOrg } from '@pd/core';
import { enqueue } from './enqueue.js';
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
    await enqueue('ai:amendment', payload);
    return;
  }
  await enqueue('ai:overview', payload);
  await enqueue('ai:dates', payload);
  await enqueue('ai:compliance', payload);
}

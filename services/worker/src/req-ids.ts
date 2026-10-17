import { and, eq } from 'drizzle-orm';
import { schema, withOrg } from '@pd/core';

type Db = Parameters<Parameters<typeof withOrg>[1]>[0];

/** The req_id prefix of a row: its section reference, or REQ. */
export function reqIdPrefix(sectionRef: string | null | undefined): string {
  const trimmed = sectionRef?.trim();
  return trimmed ? trimmed : 'REQ';
}

/**
 * Req ids for `rows`, in order, that continue the bid's existing ones (04 s3 pass 2, C.3.1-01
 * style): per prefix, the highest numeric suffix already on the bid plus 1, 2, ... A req id that
 * is not `<prefix>-<digits>` (a user row, a split "-b" row) does not count. Pure.
 */
export function nextReqIds(existing: readonly string[], rows: readonly { sectionRef?: string | null }[]): string[] {
  const top = new Map<string, number>();
  for (const reqId of existing) {
    const dash = reqId.lastIndexOf('-');
    if (dash <= 0) {
      continue;
    }
    const suffix = reqId.slice(dash + 1);
    if (!/^\d+$/.test(suffix)) {
      continue;
    }
    const prefix = reqId.slice(0, dash);
    top.set(prefix, Math.max(top.get(prefix) ?? 0, Number(suffix)));
  }
  return rows.map((row) => {
    const prefix = reqIdPrefix(row.sectionRef);
    const next = (top.get(prefix) ?? 0) + 1;
    top.set(prefix, next);
    return `${prefix}-${String(next).padStart(2, '0')}`;
  });
}

/**
 * Req ids for new compliance rows of the bid, continuing the existing ones. The caller holds the
 * bid row FOR UPDATE, so two writers on one bid (the matrix run of an attachment, an amendment
 * run) never hand out the same id.
 */
export async function allocateReqIds(db: Db, orgId: string, bidId: string, rows: readonly { sectionRef?: string | null }[]): Promise<string[]> {
  if (rows.length === 0) {
    return [];
  }
  const existing = await db.select({ reqId: schema.complianceRows.reqId }).from(schema.complianceRows).where(and(
    eq(schema.complianceRows.bidId, bidId),
    eq(schema.complianceRows.orgId, orgId),
  ));
  return nextReqIds(existing.map((row) => row.reqId), rows);
}

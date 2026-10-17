import { request, seg, type CallOptions } from './http';
import type { Ok, RowDetailDto, RowPatchMap, RowTable } from './types';

function rowPath(bidId: string, table: RowTable, rowId: string): string {
  return `/api/bids/${seg(bidId)}/rows/${seg(table)}/${seg(rowId)}`;
}

/** One row with its change history. */
export function getRow<T extends RowTable>(
  bidId: string,
  table: T,
  rowId: string,
  opts?: CallOptions,
): Promise<RowDetailDto<T>> {
  return request(rowPath(bidId, table, rowId), { signal: opts?.signal });
}

/** Updates the given fields; the server records each change in the row history. */
export function updateRow<T extends RowTable>(
  bidId: string,
  table: T,
  rowId: string,
  fields: RowPatchMap[T],
  opts?: CallOptions,
): Promise<Ok> {
  return request(rowPath(bidId, table, rowId), { method: 'PATCH', json: { fields }, signal: opts?.signal });
}

export function deleteRow(bidId: string, table: RowTable, rowId: string, opts?: CallOptions): Promise<Ok> {
  return request(rowPath(bidId, table, rowId), { method: 'DELETE', signal: opts?.signal });
}

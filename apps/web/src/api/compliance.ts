import { request, seg, type CallOptions } from './http';
import { deleteRow, updateRow } from './rows';
import { createTabRow, getTab } from './tabs';
import type { ComplianceRowDto, ComplianceRowPatch, CreateComplianceRowInput, Ok } from './types';

export async function listComplianceRows(bidId: string, opts?: CallOptions): Promise<ComplianceRowDto[]> {
  const payload = await getTab(bidId, 'compliance', opts);
  return payload.rows;
}

export function addComplianceRow(
  bidId: string,
  input: CreateComplianceRowInput,
  opts?: CallOptions,
): Promise<ComplianceRowDto> {
  return createTabRow(bidId, 'compliance', input, opts);
}

export function updateComplianceRow(
  bidId: string,
  rowId: string,
  fields: ComplianceRowPatch,
  opts?: CallOptions,
): Promise<Ok> {
  return updateRow(bidId, 'compliance_rows', rowId, fields, opts);
}

export function deleteComplianceRow(bidId: string, rowId: string, opts?: CallOptions): Promise<Ok> {
  return deleteRow(bidId, 'compliance_rows', rowId, opts);
}

/** Merges two or more rows into the first; returns the kept row id. */
export function mergeComplianceRows(bidId: string, ids: string[], opts?: CallOptions): Promise<{ id: string }> {
  return request(`/api/bids/${seg(bidId)}/compliance/merge`, { method: 'POST', json: { ids }, signal: opts?.signal });
}

/** Splits a row's requirement text at character `at`; returns the new second row. */
export function splitComplianceRow(
  bidId: string,
  rowId: string,
  at: number,
  opts?: CallOptions,
): Promise<ComplianceRowDto> {
  return request(`/api/bids/${seg(bidId)}/compliance/split`, {
    method: 'POST',
    json: { rowId, at },
    signal: opts?.signal,
  });
}

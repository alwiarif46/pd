import * as api from '@/api';
import type { ComplianceRowDto, CreateComplianceRowInput, ComplianceRowPatch } from '@/api';
import type { AmendmentMark, ComplianceFilters, ComplianceRow, ComplianceRowEdit, NewComplianceRow } from '@/types';
import { amendmentMark } from '@/features/shared/amendment-mark';
import { toFlags } from '@/features/shared/messages';
import { amendmentText } from '@/schedule/labels';
import { pageText } from '@/schedule/format';

/** The calls the Compliance container makes; tests pass fakes. */
export interface ComplianceApi {
  getTab: typeof api.getTab;
  addComplianceRow: typeof api.addComplianceRow;
  updateComplianceRow: typeof api.updateComplianceRow;
  deleteComplianceRow: typeof api.deleteComplianceRow;
  mergeComplianceRows: typeof api.mergeComplianceRows;
  splitComplianceRow: typeof api.splitComplianceRow;
  listCheckThese: typeof api.listCheckThese;
  promoteCheckThese: typeof api.promoteCheckThese;
  dismissCheckThese: typeof api.dismissCheckThese;
}

export const complianceApi: ComplianceApi = api;

export const NO_FILTERS: ComplianceFilters = {
  section: null,
  type: null,
  status: null,
  owner: null,
  amendment: null,
  flaggedOnly: false,
  hideClosed: false,
  checkThese: false,
  search: '',
};

/** A stored row as v0's matrix shows it (09 s5.4). A row with no origin is the AI's. */
export function toComplianceRow(dto: ComplianceRowDto, rowIds: ReadonlySet<string>): ComplianceRow {
  return {
    id: dto.id,
    reqId: dto.reqId,
    sectionRef: dto.sectionRef,
    requirement: dto.requirementText,
    type: dto.reqType,
    instrRef: dto.instrRef,
    evalRef: dto.evalRef,
    responseSection: dto.responseSection,
    owner: dto.owner,
    status: dto.status,
    sourcePage: dto.sourcePage,
    sourcePageEnd: dto.sourcePageEnd,
    sourceQuote: dto.sourceQuote,
    quoteVerified: dto.quoteVerified,
    origin: dto.origin ?? 'ai',
    flags: toFlags(dto),
    amendment: amendmentMark(dto, rowIds),
  };
}

const closed = (mark: AmendmentMark) => mark.kind === 'superseded' || mark.kind === 'withdrawn';

/**
 * The rows the filters keep. Section is exact; the amendment filter is `original` or an amendment number (added,
 * superseded or withdrawn by it); the search is case-insensitive over ID, requirement and section. `checkThese`
 * filters nothing: the tab swaps the table for the pre-scan list.
 */
export function filterRows(rows: readonly ComplianceRow[], f: ComplianceFilters): ComplianceRow[] {
  const needle = f.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (f.section !== null && row.sectionRef !== f.section) return false;
    if (f.type !== null && row.type !== f.type) return false;
    if (f.status !== null && row.status !== f.status) return false;
    if (f.owner !== null && row.owner !== f.owner) return false;
    if (f.amendment === 'original' && row.amendment.kind !== 'original') return false;
    if (typeof f.amendment === 'number' && (row.amendment.kind === 'original' || row.amendment.amendmentNo !== f.amendment)) return false;
    if (f.flaggedOnly && row.flags.length === 0) return false;
    if (f.hideClosed && closed(row.amendment)) return false;
    if (needle) {
      const hay = `${row.reqId}\n${row.requirement}\n${row.sectionRef ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** The values the filter menus offer: sections in natural order, owners sorted, amendment numbers ascending. */
export function deriveLists(rows: readonly ComplianceRow[]): { sections: string[]; owners: string[]; amendments: number[] } {
  const sections = new Set<string>();
  const owners = new Set<string>();
  const amendments = new Set<number>();
  for (const row of rows) {
    if (row.sectionRef) sections.add(row.sectionRef);
    if (row.owner) owners.add(row.owner);
    if (row.amendment.kind !== 'original') amendments.add(row.amendment.amendmentNo);
  }
  return {
    sections: [...sections].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    owners: [...owners].sort((a, b) => a.localeCompare(b)),
    amendments: [...amendments].sort((a, b) => a - b),
  };
}

export const NO_REF_HEADING = 'No instruction reference';

/**
 * The export (09 s5.4): one heading row per instruction reference (Section L on a federal bid), in the order the
 * references first appear, with its rows under it, then the table's columns plus the amendment status.
 * Superseded and withdrawn rows are included with their status.
 */
export function exportSheet(rows: readonly ComplianceRow[], federal: boolean): string[][] {
  const header = [
    'ID',
    'Section',
    'Requirement',
    'Type',
    federal ? 'L ref' : 'Instruction ref',
    federal ? 'M factor' : 'Evaluation factor',
    'Response section',
    'Owner',
    'Status',
    'Source page',
    'Amendment',
  ];
  const groups = new Map<string, ComplianceRow[]>();
  for (const row of rows) {
    const key = row.instrRef ?? '';
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const out: string[][] = [header];
  for (const [ref, list] of groups) {
    out.push([ref ? `${federal ? 'Section L' : 'Instruction'} ${ref}` : NO_REF_HEADING, ...header.slice(1).map(() => '')]);
    for (const row of list) {
      out.push([
        row.reqId,
        row.sectionRef ?? '',
        row.requirement,
        row.type ?? '',
        row.instrRef ?? '',
        row.evalRef ?? '',
        row.responseSection ?? '',
        row.owner ?? '',
        row.status,
        pageText(row.sourcePage, row.sourcePageEnd),
        row.origin === 'user' && row.amendment.kind === 'original' ? 'Added by user' : (amendmentText(row.amendment) ?? 'Original'),
      ]);
    }
  }
  return out;
}

/** "va-ehr-support-compliance.xlsx"; an empty name gives "compliance.xlsx". */
export function complianceFileName(bidName: string, ext: string): string {
  const slug = bidName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug ? `${slug}-compliance.${ext}` : `compliance.${ext}`;
}

/** The body for a new requirement; an empty optional field is left out. */
export function toCreateBody(row: NewComplianceRow): CreateComplianceRowInput {
  const body: CreateComplianceRowInput = { requirementText: row.requirement.trim() };
  if (row.sectionRef?.trim()) body.sectionRef = row.sectionRef.trim();
  if (row.type) body.reqType = row.type;
  if (row.owner?.trim()) body.owner = row.owner.trim();
  return body;
}

/** The PATCH for an inline edit: `requirement` is `requirementText`; an emptied owner or response section is null. */
export function toRowPatch(edit: ComplianceRowEdit): ComplianceRowPatch {
  const patch: ComplianceRowPatch = {};
  if (edit.requirement !== undefined) patch.requirementText = edit.requirement;
  if (edit.owner !== undefined) patch.owner = edit.owner;
  if (edit.status !== undefined) patch.status = edit.status;
  if (edit.responseSection !== undefined) patch.responseSection = edit.responseSection;
  return patch;
}

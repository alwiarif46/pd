import * as client from '@/api';
import type { BidFactDto, ComplianceRowDto, DocumentDto, RowDetailDto, RowHistoryDto, RowPatchMap, ScheduleActivityDto } from '@/api';
import type { RowDetailData, RowEditField, RowHistoryEntry } from '@/types';
import { amendmentMark } from '@/features/shared/amendment-mark';
import { toFlags } from '@/features/shared/messages';
import type { SourceRef } from '@/features/source-viewer/controller';
import { toConfidence } from '@/features/tab-frame/derive';

/** The tables whose rows open in v0's RowDetail (09 s5.17). `bid_facts` is ready for v0's Overview. */
export type DetailTable = 'compliance_rows' | 'schedule_activities' | 'bid_facts';

export interface DetailRowMap {
  compliance_rows: ComplianceRowDto;
  schedule_activities: ScheduleActivityDto;
  bid_facts: BidFactDto;
}

/** The calls the RowDetail container makes; tests pass fakes. */
export interface RowDetailApi {
  getRow<T extends DetailTable>(bidId: string, table: T, rowId: string, opts?: client.CallOptions): Promise<RowDetailDto<T>>;
  updateRow<T extends DetailTable>(bidId: string, table: T, rowId: string, fields: RowPatchMap[T], opts?: client.CallOptions): Promise<client.Ok>;
}

export const rowDetailApi: RowDetailApi = { getRow: client.getRow, updateRow: client.updateRow };

/** Where a row's source is, for the source viewer. */
export type RowSourceRef = SourceRef;

export const COMPLIANCE_STATUS_OPTIONS: { value: ComplianceRowDto['status']; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'drafted', label: 'Drafted' },
  { value: 'done', label: 'Done' },
];

const complianceStatusLabel = (status: string) => COMPLIANCE_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;

type AnyDetailRow = DetailRowMap[DetailTable];

/** A template activity is neither the AI's nor typed by a user: no origin is shown. */
function originOf(origin: string | null): 'ai' | 'user' | null {
  return origin === 'ai' || origin === 'user' ? origin : null;
}

/**
 * A row as v0's RowDetail shows it (09 s5.17). A value the row does not have is null, so the ui hides it:
 * the requirement fields on anything but a compliance row, `confirmed` on anything but a bid fact, and
 * `quoteVerified` on a row with no quote (a row added by hand has nothing to verify).
 */
export function toRowDetailData<T extends DetailTable>(
  table: T,
  dto: DetailRowMap[T],
  docs: readonly DocumentDto[],
  rowIds: ReadonlySet<string>,
): RowDetailData {
  const row: AnyDetailRow = dto;
  const origin = originOf(row.origin);
  // A compliance row with no origin is the AI's, as in the matrix; other tables keep a null origin (a template row).
  const rowOrigin = table === 'compliance_rows' ? (origin ?? 'ai') : origin;
  const common = {
    id: row.id,
    sourceQuote: row.sourceQuote,
    documentName: row.documentId ? (docs.find((d) => d.id === row.documentId)?.fileName ?? null) : null,
    sourcePage: row.sourcePage,
    sourcePageEnd: row.sourcePageEnd,
    amendment: amendmentMark(row, rowIds),
    confidence: toConfidence(row.confidence),
    flags: toFlags({ flags: row.flags, origin: rowOrigin, quoteVerified: row.quoteVerified }),
    quoteVerified: row.sourceQuote ? row.quoteVerified : null,
    origin: rowOrigin,
  };
  if (table === 'compliance_rows') {
    const c = row as ComplianceRowDto;
    return {
      ...common,
      kind: 'compliance',
      title: c.reqId,
      sectionRef: c.sectionRef,
      reqType: c.reqType,
      instrRef: c.instrRef,
      evalRef: c.evalRef,
      confirmed: null,
      owner: c.owner,
      status: complianceStatusLabel(c.status),
    };
  }
  if (table === 'schedule_activities') {
    const a = row as ScheduleActivityDto;
    return {
      ...common,
      kind: 'schedule',
      title: a.label,
      sectionRef: null,
      reqType: null,
      instrRef: null,
      evalRef: null,
      confirmed: null,
      owner: a.owner,
      status: a.status,
    };
  }
  const f = row as BidFactDto;
  return {
    ...common,
    kind: 'bid_fact',
    title: f.field,
    sectionRef: null,
    reqType: null,
    instrRef: null,
    evalRef: null,
    confirmed: f.confirmed,
    owner: null,
    status: null,
  };
}

/**
 * The fields the slider's Edit form offers. Schedule rows edit no dates (09-ui-workflow.md decision log, 17 Oct 2026: no date fields in the Schedule slider): dates move
 * through the calendar's per-row queue, and a second writer could interleave with a queued move.
 */
export function editFieldsFor<T extends DetailTable>(table: T, dto: DetailRowMap[T]): RowEditField[] {
  if (table === 'compliance_rows') {
    const c = dto as ComplianceRowDto;
    return [
      { key: 'requirementText', label: 'Requirement', kind: 'longtext', value: c.requirementText, options: null },
      { key: 'owner', label: 'Owner', kind: 'text', value: c.owner ?? '', options: null },
      { key: 'status', label: 'Status', kind: 'select', value: c.status, options: COMPLIANCE_STATUS_OPTIONS },
      { key: 'responseSection', label: 'Response section', kind: 'text', value: c.responseSection ?? '', options: null },
    ];
  }
  if (table === 'schedule_activities') {
    const a = dto as ScheduleActivityDto;
    return [
      { key: 'label', label: 'Label', kind: 'text', value: a.label, options: null },
      { key: 'owner', label: 'Owner', kind: 'text', value: a.owner ?? '', options: null },
      { key: 'status', label: 'Status', kind: 'text', value: a.status ?? '', options: null },
    ];
  }
  return [{ key: 'value', label: 'Value', kind: 'longtext', value: (dto as BidFactDto).value, options: null }];
}

/** The keys each table's PATCH takes from the slider, and whether an emptied value is sent as null. */
const PATCH_KEYS: Record<DetailTable, Record<string, { nullable: boolean }>> = {
  compliance_rows: {
    requirementText: { nullable: false },
    owner: { nullable: true },
    status: { nullable: false },
    responseSection: { nullable: true },
  },
  schedule_activities: { label: { nullable: false }, owner: { nullable: true }, status: { nullable: true } },
  bid_facts: { value: { nullable: false } },
};

/**
 * The PATCH body for a save: only the keys whose value differs from the field's loaded value, and only keys
 * the table takes; an emptied nullable field is sent as null. Empty when nothing changed.
 */
export function rowPatchFor<T extends DetailTable>(
  table: T,
  values: Readonly<Record<string, string>>,
  fields: readonly RowEditField[],
): RowPatchMap[T] {
  const allowed = PATCH_KEYS[table];
  const patch: Record<string, string | null> = {};
  for (const field of fields) {
    const rule = allowed[field.key];
    const next = values[field.key];
    if (!rule || next === undefined || next === field.value) continue;
    patch[field.key] = next === '' && rule.nullable ? null : next;
  }
  return patch as RowPatchMap[T];
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  requirementText: 'Requirement',
  owner: 'Owner',
  status: 'Status',
  responseSection: 'Response section',
  label: 'Label',
  startDate: 'Start',
  endDate: 'End',
  locked: 'Locked',
  kind: 'Kind',
  reviewColor: 'Review color',
  value: 'Value',
  confirmed: 'Confirmed',
};

/** The row's change history for the slider: who (the user's name, or System), the field's label, from, to, when. */
export function toHistory(dtos: readonly RowHistoryDto[]): RowHistoryEntry[] {
  return dtos.map((h) => ({
    id: h.id,
    who: h.userName ?? 'System',
    field: FIELD_LABELS[h.field] ?? h.field,
    from: h.oldValue,
    to: h.newValue,
    at: h.changedAt,
  }));
}

/** The row's source for the viewer, or null when it has no document or no page. */
export function rowSourceOf(dto: AnyDetailRow): RowSourceRef | null {
  if (!dto.documentId || dto.sourcePage === null) return null;
  return { documentId: dto.documentId, page: dto.sourcePage, pageEnd: dto.sourcePageEnd, quote: dto.sourceQuote };
}

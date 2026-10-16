import type { BidFactDto, ScheduleActivityDto, TabProposalDto } from '@/api';
import type { ProposalOldRow, ProposalSubject, TabProposal } from '@/types';
import { dayOf } from '@/features/schedule/derive';

/** The source columns a proposed or replaced row carries. */
interface SourceRow {
  id: string;
  documentId: string | null;
  sourcePage: number | null;
  sourcePageEnd: number | null;
  sourceQuote: string | null;
}

/** Where the viewer opens for a row: its document, page range and quote. */
export interface ProposalSourceRef {
  documentId: string;
  page: number;
  pageEnd: number | null;
  quote: string | null;
}

/**
 * The proposal's own source (the amendment text behind the change) wins over the proposed row's. The
 * page end belongs to the row's page, so it goes when the proposal's page is used.
 */
function sourceOf<T extends SourceRow>(dto: TabProposalDto<T>) {
  return {
    sourcePage: dto.sourcePage ?? dto.row.sourcePage,
    sourcePageEnd: dto.sourcePage !== null ? null : dto.row.sourcePageEnd,
    sourceQuote: dto.sourceQuote ?? dto.row.sourceQuote,
  };
}

function toProposals<T extends SourceRow>(
  dtos: readonly TabProposalDto<T>[],
  rows: readonly T[],
  subject: (row: T) => ProposalSubject,
  isAi: (row: T) => boolean,
): TabProposal[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return dtos.map((dto) => {
    const replaces: ProposalOldRow[] = [];
    for (const id of dto.oldRowIds) {
      const old = byId.get(id);
      if (!old) continue; // removed meanwhile, or not in this tab's list
      replaces.push({
        rowId: old.id,
        subject: subject(old),
        isAi: isAi(old),
        sourcePage: old.sourcePage,
        sourcePageEnd: old.sourcePageEnd,
      });
    }
    return { id: dto.linkId, rowId: dto.row.id, amendmentNo: dto.amendmentNo, next: subject(dto.row), replaces, ...sourceOf(dto) };
  });
}

const factSubject = (f: BidFactDto): ProposalSubject => ({ kind: 'fact', label: f.field, value: f.value });

function activitySubject(a: ScheduleActivityDto): ProposalSubject {
  const start = dayOf(a.startDate);
  return { kind: 'activity', label: a.label, start, end: dayOf(a.endDate) ?? start };
}

/** The Overview tab's proposals, with the facts they replace. */
export function factProposals(dtos: readonly TabProposalDto<BidFactDto>[], facts: readonly BidFactDto[]): TabProposal[] {
  return toProposals(dtos, facts, factSubject, (f) => f.origin === 'ai');
}

/** The Schedule tab's proposals, with the activities they replace (an AI row from before origins counts by its page). */
export function activityProposals(
  dtos: readonly TabProposalDto<ScheduleActivityDto>[],
  activities: readonly ScheduleActivityDto[],
): TabProposal[] {
  return toProposals(dtos, activities, activitySubject, (a) => a.origin === 'ai' || (a.origin === null && a.sourcePage !== null));
}

/**
 * The source of a proposed row (its document is the amendment, as the rows an amendment adds carry it)
 * or of a row a proposal replaces; null when it has no document or page.
 */
export function proposalSource<T extends SourceRow>(
  dtos: readonly TabProposalDto<T>[],
  rows: readonly T[],
  rowId: string,
): ProposalSourceRef | null {
  const dto = dtos.find((d) => d.row.id === rowId);
  const row = dto?.row ?? rows.find((r) => r.id === rowId);
  if (!row?.documentId) return null;
  const s = dto ? sourceOf(dto) : row;
  if (s.sourcePage === null) return null;
  return { documentId: row.documentId, page: s.sourcePage, pageEnd: s.sourcePageEnd, quote: s.sourceQuote };
}

import type { SourceColumnsDto } from '@/api/types';
import type { AmendmentMark } from '@/types';

type MarkSource = Pick<SourceColumnsDto, 'amendmentNo' | 'supersedeStatus' | 'supersededByRowId' | 'changedByAmendment'>;

/**
 * A row's AmendmentMark (09 s5.12), container mapping: a superseded row names the amendment that
 * replaced it and the replacing row (null when that row is gone from `rowIds`, so the ui shows no
 * jump); a withdrawn row names the amendment that withdrew it; a row an amendment created is
 * added; anything else is original. A closed row with no recorded amendment (rows written before
 * migration 0009 that no link explains) shows as original, never as "Amd 0".
 */
export function amendmentMark(row: MarkSource, rowIds: ReadonlySet<string>): AmendmentMark {
  if (row.supersedeStatus === 'superseded' && row.changedByAmendment) {
    const target = row.supersededByRowId;
    return { kind: 'superseded', amendmentNo: row.changedByAmendment, replacedById: target && rowIds.has(target) ? target : null };
  }
  if (row.supersedeStatus === 'withdrawn' && row.changedByAmendment) {
    return { kind: 'withdrawn', amendmentNo: row.changedByAmendment };
  }
  if (row.amendmentNo > 0) {
    return { kind: 'added', amendmentNo: row.amendmentNo };
  }
  return { kind: 'original' };
}

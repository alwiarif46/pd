// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RowDetailProps } from '@/types';
import { complianceRowDto, docDto, rowHistoryDto } from '@/test/fixtures';
import type { RowDetailApi } from './controller';
import { RowDetailContainer } from './RowDetailContainer';

// The v0 RowDetail sends only the keys it saw change; this file drives the container's own guard, for a save
// whose keys the table's PATCH does not take (so nothing would be sent).
const seen: RowDetailProps[] = [];
vi.mock('@/ui/compliance/RowDetail', () => ({
  RowDetail: (props: RowDetailProps) => {
    seen.push(props);
    return null;
  },
}));
vi.mock('./use-detail-portal', () => ({ useDetailPortal: (node: unknown) => node }));

describe('RowDetailContainer: a save with nothing to send', () => {
  it('reports done, so the form closes, and sends no request', async () => {
    const api: RowDetailApi = {
      getRow: vi.fn(async () => ({ row: complianceRowDto(), history: [rowHistoryDto()] })) as unknown as RowDetailApi['getRow'],
      updateRow: vi.fn(async () => ({ ok: true as const })) as unknown as RowDetailApi['updateRow'],
    };
    render(
      <RowDetailContainer
        bidId="bid-1"
        table="compliance_rows"
        rowId="req-1"
        federal
        docs={[docDto()]}
        rowIds={new Set(['req-1'])}
        onOpenSource={vi.fn()}
        onSaved={vi.fn()}
        onJumpToRow={vi.fn()}
        onClose={vi.fn()}
        api={api}
      />,
    );
    await waitFor(() => expect(seen.at(-1)?.row).not.toBeNull());
    act(() => seen.at(-1)!.onSave({ notAField: 'x' }));
    await waitFor(() => expect(seen.at(-1)?.saveStatus).toEqual({ state: 'done', message: 'No changes.' }));
    expect(api.updateRow).not.toHaveBeenCalled();
  });
});

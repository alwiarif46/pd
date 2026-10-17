import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isAbortError, type CheckTheseDto, type ComplianceRowDto } from '@/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadCsv, downloadXlsx } from '@/export';
import type { CheckThese, ComplianceFilters } from '@/types';
import { csvSafe } from '@/schedule/export';
import { ComplianceMatrixTab } from '@/ui/compliance/ComplianceMatrixTab';
import { messageOf } from '@/features/shared/messages';
import { useRequiredShell } from '@/features/shell/bid-context';
import { jobsKey } from '@/features/shell/controller';
import type { TabScreenProps } from '@/features/shell/registry';
import type { RowDetailApi } from '@/features/row-detail/controller';
import { RowDetailContainer } from '@/features/row-detail/RowDetailContainer';
import type { SourceApi, SourceRef } from '@/features/source-viewer/controller';
import { SourceViewerContainer } from '@/features/source-viewer/SourceViewerContainer';
import { TabFrameContainer } from '@/features/tab-frame/TabFrameContainer';
import {
  complianceApi,
  complianceFileName,
  deriveLists,
  exportSheet,
  filterRows,
  NO_FILTERS,
  toComplianceRow,
  toCreateBody,
  toRowPatch,
  type ComplianceApi,
} from './controller';

/** The two downloads the export menu makes; tests pass fakes. */
export interface ComplianceExporter {
  csv(name: string, rows: string[][]): void;
  xlsx(name: string, rows: string[][]): void;
}

const complianceExporter: ComplianceExporter = { csv: downloadCsv, xlsx: downloadXlsx };

interface Props extends TabScreenProps {
  /** Test seams; default to the typed client and the browser downloads. */
  api?: ComplianceApi;
  exporter?: ComplianceExporter;
  rowApi?: RowDetailApi;
  sourceApi?: SourceApi;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: ComplianceRowDto[]; checkThese: CheckTheseDto[] };

const LOADING: LoadState = { kind: 'loading' };
const NO_DTOS: ComplianceRowDto[] = [];
const NO_CHECK: CheckThese[] = [];

/** The Compliance tab (05 s3.3, 09 s5.4): loads the bid's requirements and pre-scan list, and wires v0's matrix. */
export function ComplianceContainer({ bidId, selectedRowId, api = complianceApi, exporter = complianceExporter, rowApi, sourceApi }: Props) {
  const shell = useRequiredShell();
  const [load, setLoad] = useState<{ bidId: string; state: LoadState } | null>(null);
  const [version, setVersion] = useState(0);
  /** Filters belong to the bid they were set on: another bid starts with none. */
  const [filterState, setFilterState] = useState<{ bidId: string; filters: ComplianceFilters } | null>(null);
  const [sourceState, setSourceState] = useState<{ bidId: string; ref: SourceRef } | null>(null);
  /** The bid whose rows are on screen (set when a load succeeds): a failed reload keeps them. */
  const shownRef = useRef<string | null>(null);
  /** "Check these" sentences with a promote or dismiss in flight: a second click is ignored. */
  const checkBusyRef = useRef(new Set<string>());
  const wrapRef = useRef<HTMLDivElement>(null);
  const jobKey = jobsKey({ jobs: shell.jobs });

  useEffect(() => {
    const abort = new AbortController();
    const opts = { signal: abort.signal };
    // The rows decide the tab; the pre-scan list is an extra: its failure leaves the list empty, with a toast.
    void Promise.allSettled([api.getTab(bidId, 'compliance', opts), api.listCheckThese(bidId, opts)]).then(([tab, check]) => {
      if (abort.signal.aborted) return;
      if (tab.status === 'rejected') {
        if (isAbortError(tab.reason)) return;
        if (shownRef.current === bidId) toast.error(messageOf(tab.reason));
        else setLoad({ bidId, state: { kind: 'error', message: messageOf(tab.reason) } });
        return;
      }
      let checkThese: CheckTheseDto[] = [];
      if (check.status === 'fulfilled') checkThese = check.value;
      else if (!isAbortError(check.reason)) toast.error(messageOf(check.reason));
      shownRef.current = bidId;
      setLoad({ bidId, state: { kind: 'ready', rows: tab.value.rows, checkThese } });
    });
    return () => abort.abort();
  }, [api, bidId, version, jobKey]);

  const state: LoadState = load?.bidId === bidId ? load.state : LOADING;
  const dtos = state.kind === 'ready' ? state.rows : NO_DTOS;
  const checkDtos = state.kind === 'ready' ? state.checkThese : null;
  const filters = filterState?.bidId === bidId ? filterState.filters : NO_FILTERS;
  const bid = shell.bid;
  const federal = bid?.bidType === 'federal';

  const rowIds = useMemo(() => new Set(dtos.map((d) => d.id)), [dtos]);
  const rows = useMemo(() => dtos.map((d) => toComplianceRow(d, rowIds)), [dtos, rowIds]);
  const shown = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const lists = useMemo(() => deriveLists(rows), [rows]);
  const checkThese = useMemo<CheckThese[]>(
    () => (checkDtos ? checkDtos.map((c) => ({ id: c.id, sentence: c.sentence, page: c.page })) : NO_CHECK),
    [checkDtos],
  );
  const hasAiRows = rows.some((r) => r.origin === 'ai');
  const source = sourceState?.bidId === bidId ? sourceState.ref : null;

  const reload = () => setVersion((n) => n + 1);
  const afterSave = () => {
    reload();
    shell.refresh();
  };
  const fail = (error: unknown) => {
    toast.error(messageOf(error));
    reload();
  };
  const mutate = (call: () => Promise<unknown>, after: () => void = afterSave) => {
    call().then(after, fail);
  };
  const decideCheck = (id: string, call: () => Promise<unknown>) => {
    if (checkBusyRef.current.has(id)) return;
    checkBusyRef.current.add(id);
    call()
      .then(afterSave, fail)
      .finally(() => checkBusyRef.current.delete(id));
  };

  const onOpenSource = (id: string) => {
    const dto = dtos.find((d) => d.id === id);
    if (!dto || !dto.documentId || dto.sourcePage === null) {
      toast.info('No source page for this row.');
      return;
    }
    setSourceState({
      bidId,
      ref: { documentId: dto.documentId, page: dto.sourcePage, pageEnd: dto.sourcePageEnd, quote: dto.sourceQuote },
    });
  };

  const onExport = (format: 'xlsx' | 'csv') => {
    const sheet = exportSheet(rows, federal);
    const name = complianceFileName(bid?.name ?? '', format);
    if (format === 'csv') exporter.csv(name, csvSafe(sheet));
    else exporter.xlsx(name, sheet);
  };

  // v0's rows carry no data-row, and requirement IDs repeat (a split names its new row `${reqId}-b`, and users
  // type any ID), so a row is found by its place among the shown rows, which are the table's body rows in order.
  const shownIds = useMemo(() => shown.map((r) => r.id), [shown]);
  const shownIdsRef = useRef(shownIds);
  useEffect(() => {
    shownIdsRef.current = shownIds;
  });
  const matrixRegion = () => wrapRef.current?.querySelector<HTMLElement>('[role="region"][aria-label="Compliance matrix"]') ?? null;
  /** The ID button of the shown row at `index`: the row's first button that is not its select checkbox. */
  const idButtonAt = (index: number): HTMLElement | null => {
    const tr = matrixRegion()?.querySelectorAll('tbody tr')[index];
    return tr?.querySelector<HTMLElement>('button:not([role="checkbox"])') ?? null;
  };
  // The ID button of a row, for returning focus when the slider closes and the opener is gone (a reload
  // remounted it) or the slider moved to another row. A row the filters hide gives the table region.
  const findRowElement = (rowId: string): HTMLElement | null => {
    const index = shownIdsRef.current.indexOf(rowId);
    return (index >= 0 ? idButtonAt(index) : null) ?? matrixRegion();
  };
  // After the shown row is deleted: the next row's ID button, else the previous one, else the table region.
  const focusNeighbour = (rowId: string) => {
    const index = shownIdsRef.current.indexOf(rowId);
    if (index < 0) return;
    (idButtonAt(index + 1) ?? (index > 0 ? idButtonAt(index - 1) : null) ?? matrixRegion())?.focus();
  };

  let body;
  if (state.kind === 'loading') {
    body = (
      <div role="status" aria-label="Loading compliance matrix">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-64 w-full" />
      </div>
    );
  } else if (state.kind === 'error') {
    body = (
      <div role="alert" className="flex max-w-md flex-col items-start gap-3 text-ink">
        <p className="text-sm text-due">{state.message}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setLoad(null);
            reload();
          }}
        >
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <ComplianceMatrixTab
        rows={shown}
        totalRows={rows.length}
        checkThese={checkThese}
        filters={filters}
        federal={federal}
        sections={lists.sections}
        owners={lists.owners}
        amendments={lists.amendments}
        selectedRowId={selectedRowId}
        onFiltersChange={(f) => setFilterState({ bidId, filters: f })}
        onEditRow={(id, edit) => mutate(() => api.updateComplianceRow(bidId, id, toRowPatch(edit)))}
        onAddRow={(row) => mutate(() => api.addComplianceRow(bidId, toCreateBody(row)))}
        onMergeRows={(ids) => mutate(() => api.mergeComplianceRows(bidId, ids))}
        onSplitRow={(id, at) => mutate(() => api.splitComplianceRow(bidId, id, at))}
        onDeleteRow={(id) =>
          mutate(
            () => api.deleteComplianceRow(bidId, id),
            () => {
              if (selectedRowId === id) {
                focusNeighbour(id);
                shell.openRow(null);
              }
              afterSave();
            },
          )
        }
        onPromoteCheckThese={(id) => decideCheck(id, () => api.promoteCheckThese(id))}
        onDismissCheckThese={(id) => decideCheck(id, () => api.dismissCheckThese(id))}
        onOpenRow={(id) => shell.openRow(id)}
        onOpenSource={onOpenSource}
        onJumpToRow={(id) => shell.openRow(id)}
        onExport={onExport}
      />
    );
  }

  return (
    <>
      <div ref={wrapRef} className="contents">
        <TabFrameContainer tab="compliance" title="Compliance" hasAiRows={hasAiRows}>
          {body}
        </TabFrameContainer>
      </div>
      {selectedRowId && (
        // Portalled into the shell's row detail slot (route flag `rowDetail`), outside `.app-shell`.
        <RowDetailContainer
          bidId={bidId}
          table="compliance_rows"
          rowId={selectedRowId}
          federal={federal}
          docs={shell.docs}
          rowIds={rowIds}
          onOpenSource={(ref) => setSourceState({ bidId, ref })}
          onSaved={afterSave}
          onJumpToRow={(id) => shell.openRow(id)}
          onClose={() => shell.openRow(null)}
          findRowElement={findRowElement}
          reloadKey={`${version}/${jobKey}`}
          api={rowApi}
        />
      )}
      <SourceViewerContainer source={source} docs={shell.docs} onClose={() => setSourceState(null)} api={sourceApi} />
    </>
  );
}

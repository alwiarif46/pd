import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isAbortError, type DocumentDto, type RowHistoryDto } from '@/api';
import type { FormStatus } from '@/types';
import { RowDetail } from '@/ui/compliance/RowDetail';
import { messageOf, toFormStatus } from '@/features/shared/messages';
import {
  editFieldsFor,
  rowDetailApi,
  rowPatchFor,
  rowSourceOf,
  toHistory,
  toRowDetailData,
  type DetailRowMap,
  type DetailTable,
  type RowDetailApi,
  type RowSourceRef,
} from './controller';
import { useDetailPortal } from './use-detail-portal';

export interface RowDetailContainerProps<T extends DetailTable> {
  bidId: string;
  table: T;
  rowId: string;
  federal: boolean;
  docs: readonly DocumentDto[];
  /** The ids of the tab's rows: a "Superseded by" jump is offered only to a row that is there. */
  rowIds: ReadonlySet<string>;
  /** Opens the source viewer on the row's source. Not called for a row with no document or page (a toast says so). */
  onOpenSource: (ref: RowSourceRef) => void;
  /** After a save: the tab reloads its rows (and the shell). */
  onSaved: () => void;
  /** Selects another row of the tab (the "Superseded by" jump). */
  onJumpToRow: (id: string) => void;
  /** Closes the slider (clears `?row=`); the tab returns focus to the row. */
  onClose: () => void;
  /** Test seam; defaults to the typed client. */
  api?: RowDetailApi;
}

type Loaded<T extends DetailTable> = { key: string; dto: DetailRowMap[T]; history: RowHistoryDto[] };

const IDLE: FormStatus = { state: 'idle' };
const keyOf = (bidId: string, table: DetailTable, rowId: string) => `${bidId}/${table}/${rowId}`;

/**
 * The row detail slider (09 s5.17) for one row of a tab that opted into the shell's slot (`rowDetail`): loads
 * the row and its history, maps them to v0's RowDetail, saves the changed fields, and renders the slider into
 * the shell's detail host (useDetailPortal). Everything is keyed by bid, table and row: an answer for a row
 * (or bid) no longer selected is dropped, and a save's status shows only on the row it was made on.
 */
export function RowDetailContainer<T extends DetailTable>({
  bidId,
  table,
  rowId,
  federal,
  docs,
  rowIds,
  onOpenSource,
  onSaved,
  onJumpToRow,
  onClose,
  api = rowDetailApi,
}: RowDetailContainerProps<T>) {
  const key = keyOf(bidId, table, rowId);
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const [version, setVersion] = useState(0);
  const [save, setSave] = useState<{ key: string; status: FormStatus } | null>(null);
  /** The row whose data is on screen (set when a load succeeds): a failed reload of it keeps it. */
  const shownRef = useRef<string | null>(null);
  /** Rows with a save in flight: a second submit is ignored. */
  const savingRef = useRef(new Set<string>());
  // The latest onClose, for a load that fails after a re-render; written only in an effect.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const abort = new AbortController();
    const loadKey = keyOf(bidId, table, rowId);
    api.getRow(bidId, table, rowId, { signal: abort.signal }).then(
      (payload) => {
        if (abort.signal.aborted) return;
        shownRef.current = loadKey;
        setLoaded({ key: loadKey, dto: payload.row as DetailRowMap[T], history: payload.history });
      },
      (error: unknown) => {
        if (abort.signal.aborted || isAbortError(error)) return;
        toast.error(messageOf(error));
        // A failed first load closes the slider; a failed reload keeps the row shown.
        if (shownRef.current !== loadKey) closeRef.current();
      },
    );
    return () => abort.abort();
  }, [api, bidId, table, rowId, version]);

  const current = loaded?.key === key ? loaded : null;
  const row = useMemo(() => (current ? toRowDetailData(table, current.dto, docs, rowIds) : null), [current, table, docs, rowIds]);
  const editFields = useMemo(() => (current ? editFieldsFor(table, current.dto) : []), [current, table]);
  const history = useMemo(() => (current ? toHistory(current.history) : []), [current]);
  const saveStatus = save?.key === key ? save.status : IDLE;

  const openSource = () => {
    const ref = current ? rowSourceOf(current.dto) : null;
    if (!ref) {
      toast.info('No source page for this row.');
      return;
    }
    onOpenSource(ref);
  };

  const onSave = (values: Record<string, string>) => {
    if (!current || savingRef.current.has(key)) return;
    const patch = rowPatchFor(table, values, editFields);
    if (Object.keys(patch).length === 0) return;
    const saveKey = key;
    savingRef.current.add(saveKey);
    setSave({ key: saveKey, status: { state: 'submitting' } });
    api.updateRow(bidId, table, rowId, patch).then(
      () => {
        savingRef.current.delete(saveKey);
        setSave((prev) => (prev?.key === saveKey ? { key: saveKey, status: { state: 'done', message: 'Saved.' } } : prev));
        setVersion((n) => n + 1);
        onSaved();
      },
      (error: unknown) => {
        savingRef.current.delete(saveKey);
        setSave((prev) => (prev?.key === saveKey ? { key: saveKey, status: toFormStatus(error) } : prev));
      },
    );
  };

  return useDetailPortal(
    <RowDetail
      open
      row={row}
      history={history}
      federal={federal}
      editFields={editFields}
      saveStatus={saveStatus}
      onOpenSource={openSource}
      onSave={onSave}
      onJumpToRow={onJumpToRow}
      onClose={onClose}
    />,
  );
}

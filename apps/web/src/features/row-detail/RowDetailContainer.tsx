import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { currentOpener, returnTarget, type Opener } from './focus-return';
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
  /** Closes the slider (clears `?row=`). Focus has already been returned to the row (focus-return.ts). */
  onClose: () => void;
  /**
   * Finds the focusable element of a row (its ID button) in the tab, for a tab whose rows carry no `data-row`,
   * `data-row-id` or `data-activity`. Used when the opener is gone (the tab reloaded) or the slider jumped rows.
   */
  findRowElement?: (rowId: string) => HTMLElement | null;
  /** When the tab reloads its rows (an inline edit, a job): a new value reloads the open row too. */
  reloadKey?: string;
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
 * (or bid) no longer selected is dropped, and a save's status shows only on the row it was made on. On close
 * (X, Close or Esc) focus returns to the element that opened the slider, or to the shown row's element.
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
  findRowElement,
  reloadKey,
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
  const findRef = useRef(findRowElement);
  useEffect(() => {
    closeRef.current = onClose;
    findRef.current = findRowElement;
  });
  /**
   * The element that had focus when the slider opened. Read in a layout effect on mount, before v0's RowDetail
   * moves focus to its heading (a passive effect). Kept from the first run, so StrictMode's second run (after
   * the heading took focus) does not replace it.
   */
  const [openedFor] = useState(rowId);
  const openerRef = useRef<Opener | null>(null);
  useLayoutEffect(() => {
    openerRef.current ??= currentOpener(openedFor);
  }, [openedFor]);

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
        if (shownRef.current !== loadKey) {
          returnTarget(openerRef.current, rowId, findRef.current)?.focus();
          closeRef.current();
        }
      },
    );
    return () => abort.abort();
  }, [api, bidId, table, rowId, version, reloadKey]);

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
    const saveKey = key;
    if (Object.keys(patch).length === 0) {
      // Nothing to send: report done (after a submitting render, so v0 sees the change) and the form closes.
      setSave({ key: saveKey, status: { state: 'submitting' } });
      void Promise.resolve().then(() =>
        setSave((prev) => (prev?.key === saveKey ? { key: saveKey, status: { state: 'done', message: 'No changes.' } } : prev)),
      );
      return;
    }
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

  const close = () => {
    returnTarget(openerRef.current, rowId, findRowElement)?.focus();
    onClose();
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
      onClose={close}
    />,
  );
}

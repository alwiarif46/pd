import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/api';
import { Skeleton } from '@/components/ui/skeleton';
import type { FileKind, UploadNotice, UploadProgress } from '@/types';
import { DocumentsPanel } from '@/ui/documents/DocumentsPanel';
import { takeUploadNotices } from '@/features/bids/notices';
import type { RowDetailApi } from '@/features/row-detail/controller';
import { RowDetailContainer } from '@/features/row-detail/RowDetailContainer';
import { amendmentTabsNotice } from '@/features/shared/amendment-tabs-status';
import { messageOf, noticeFor } from '@/features/shared/messages';
import { useRequiredShell } from '@/features/shell/bid-context';
import { tabHref } from '@/features/shell/routes';
import type { TabScreenProps } from '@/features/shell/registry';
import type { SourceApi, SourceRef } from '@/features/source-viewer/controller';
import { SourceViewerContainer } from '@/features/source-viewer/SourceViewerContainer';
import { TabFrameContainer } from '@/features/tab-frame/TabFrameContainer';
import { toProposals, usedBytes } from '@/features/tab-frame/derive';
import { documentsApi, percentOf, proposalSourceRowIds, toDoc, uploadFailureNotice, type DocumentsApi } from './controller';

interface Props extends TabScreenProps {
  /** Test seams; default to the typed client. */
  api?: DocumentsApi;
  rowApi?: RowDetailApi;
  sourceApi?: SourceApi;
}

/** The Documents tab has no compliance rows of its own, so the slider offers no "Superseded by" jump. */
const NO_ROW_IDS: ReadonlySet<string> = new Set();

/** A bid's notices or progress: kept per bid, so an upload that ends after a bid switch shows on its own bid. */
interface PerBid<T> {
  bidId: string;
  items: T[];
}

/** The id of a notice the user dismissed, per bid. */
interface Dismissed {
  bidId: string;
  ids: string[];
}

/**
 * The Documents tab (05 s3.10, 09 s5.11): v0's panel over the bid's files from the shell, with uploads (one
 * file at a time, with the amendment number), the marking prompt, the key check and its override, the
 * amendment number, delete, restore, and the tabs-status notices. TabFrame draws the 05 s4 states around it
 * (its marking prompt is off here: the panel draws one under each file).
 */
export function DocumentsContainer({ bidId, selectedRowId, api = documentsApi, rowApi, sourceApi }: Props) {
  const shell = useRequiredShell();
  const [own, setOwn] = useState<PerBid<UploadNotice> | null>(null);
  const [progress, setProgress] = useState<PerBid<UploadProgress> | null>(null);
  const [dismissed, setDismissed] = useState<Dismissed | null>(null);
  const [sourceState, setSourceState] = useState<{ bidId: string; ref: SourceRef } | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const seqRef = useRef(0);
  /** Files and documents with a call in flight: a second click on the same action is ignored. */
  const busyRef = useRef(new Set<string>());
  const wrapRef = useRef<HTMLDivElement>(null);

  // The notices the new-bid screen stashed for this bid (once). Set after a microtask: React forbids a
  // synchronous setState in an effect, and StrictMode runs the effect twice (the second take finds nothing).
  useEffect(() => {
    const taken = takeUploadNotices(bidId);
    if (taken.length === 0) return;
    queueMicrotask(() => setOwn((prev) => ({ bidId, items: [...(prev?.bidId === bidId ? prev.items : []), ...taken] })));
  }, [bidId]);

  const addNotice = (forBid: string, notice: UploadNotice) =>
    setOwn((prev) => ({ bidId: forBid, items: [...(prev?.bidId === forBid ? prev.items : []), notice] }));

  const setPercent = (forBid: string, fileName: string, percent: number | null) =>
    setProgress((prev) => {
      const rest = (prev?.bidId === forBid ? prev.items : []).filter((item) => item.fileName !== fileName);
      return { bidId: forBid, items: percent === null ? rest : [...rest, { fileName, percent }] };
    });

  const runUpload = async (forBid: string, files: File[], kind: FileKind, amendmentNo: number | undefined) => {
    for (const file of files) {
      seqRef.current += 1;
      const id = `${forBid}:upload:${seqRef.current}`;
      setPercent(forBid, file.name, 0);
      try {
        const result = await api.uploadFile(forBid, file, kind, {
          ...(amendmentNo !== undefined ? { amendmentNo } : {}),
          onProgress: (p) => setPercent(forBid, file.name, percentOf(p)),
        });
        if (result.duplicate) addNotice(forBid, noticeFor('duplicate', file, id));
      } catch (error) {
        addNotice(forBid, uploadFailureNotice(error, file, id));
      } finally {
        setPercent(forBid, file.name, null);
      }
    }
    shell.refresh();
  };

  const onUpload = (files: File[], kind: FileKind, amendmentNo?: number) => {
    if (files.length === 0) return;
    queueRef.current = queueRef.current.then(() => runUpload(bidId, files, kind, amendmentNo));
  };

  /** Runs one call per key at a time; success reloads the shell, failure shows the API's message. */
  const act = (key: string, call: () => Promise<unknown>, done: () => void, fail?: (error: unknown) => void) => {
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    call()
      .then(done, (error: unknown) => {
        if (fail) fail(error);
        else toast.error(messageOf(error));
        shell.refresh();
      })
      .finally(() => busyRef.current.delete(key));
  };

  const onRestore = (id: string) =>
    act(
      `restore:${id}`,
      () => api.restoreDocument(id),
      () => {
        toast.success('Restore requested.');
        shell.refresh();
      },
      (error) => {
        if (error instanceof ApiError && error.status === 402) shell.openUpgrade('plan');
        else toast.error(messageOf(error));
      },
    );

  const onOverrideKey = (id: string, reason: string) =>
    act(
      `override:${id}`,
      () => api.overrideSolicitationKey(id, reason),
      () => {
        toast.success('Override recorded.');
        shell.refresh();
      },
      (error) => {
        if (error instanceof ApiError && error.code === 'set_bid_number_first') {
          toast.error(error.message, {
            action: {
              label: 'Open Bid settings',
              onClick: () => {
                window.location.hash = tabHref(bidId, 'settings');
              },
            },
          });
        } else toast.error(messageOf(error));
      },
    );

  const onSetAmendmentNo = (id: string, amendmentNo: number) =>
    act(
      `number:${id}`,
      () => api.setAmendmentNo(id, amendmentNo),
      () => {
        toast.success('Amendment number saved.');
        shell.refresh();
      },
    );

  const docs = useMemo(() => shell.docs.map((dto) => toDoc(dto, shell.jobs, shell.docs)), [shell.docs, shell.jobs]);
  const tabsNotices = useMemo(
    () => shell.docs.flatMap((dto) => amendmentTabsNotice(dto) ?? []),
    [shell.docs],
  );
  const hidden = dismissed?.bidId === bidId ? dismissed.ids : [];
  const notices = [...(own?.bidId === bidId ? own.items : []), ...tabsNotices].filter((n) => !hidden.includes(n.id));
  const uploads = progress?.bidId === bidId ? progress.items : [];
  const source = sourceState?.bidId === bidId ? sourceState.ref : null;
  const bid = shell.bid;
  const federal = bid?.bidType === 'federal';
  const sourceRowIds = proposalSourceRowIds(toProposals(shell.links));

  // The source button of an amendment card for a compliance row, found by the row's id (the cards' buttons
  // carry no row marker), for returning focus when the slider closes and its opener is gone.
  const findRowElement = (rowId: string): HTMLElement | null => {
    const index = sourceRowIds.indexOf(rowId);
    if (index < 0 || !wrapRef.current) return null;
    return wrapRef.current.querySelectorAll<HTMLElement>('button[aria-label^="Open source for "]')[index] ?? null;
  };

  const body = !shell.bidLoaded ? (
    <div role="status" aria-label="Loading documents">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-4 h-64 w-full" />
    </div>
  ) : (
    <DocumentsPanel
      docs={docs}
      usedBytes={usedBytes(shell.docs)}
      capMb={shell.summary.mbCap}
      plan={shell.summary.plan}
      isOwner={shell.org.role === 'owner'}
      overridesLeft={bid?.keyOverridesLeft ?? 0}
      notices={notices}
      uploads={uploads}
      onUpload={onUpload}
      onSetAmendmentNo={onSetAmendmentNo}
      onDismissNotice={(id) => setDismissed((prev) => ({ bidId, ids: [...(prev?.bidId === bidId ? prev.ids : []), id] }))}
      onOpen={(id) => setSourceState({ bidId, ref: { documentId: id, page: 1, pageEnd: null, quote: null } })}
      onDelete={(id) => act(`delete:${id}`, () => api.deleteDocument(id), () => shell.refresh())}
      onRestore={onRestore}
      onConfirmMarking={(id) => act(`marking:${id}`, () => api.confirmMarking(id), () => shell.refresh())}
      onOverrideKey={onOverrideKey}
      onUpgrade={() => shell.openUpgrade('over_cap')}
    />
  );

  return (
    <>
      <div ref={wrapRef} className="contents">
        <TabFrameContainer tab="documents" title="Documents" markings={false}>
          {body}
        </TabFrameContainer>
      </div>
      {selectedRowId && (
        // Portalled into the shell's row detail slot (route flag `rowDetail`), outside `.app-shell`: the source
        // button of a "Confirm amendment changes" card opens a compliance row here.
        <RowDetailContainer
          bidId={bidId}
          table="compliance_rows"
          rowId={selectedRowId}
          federal={federal}
          docs={shell.docs}
          rowIds={NO_ROW_IDS}
          onOpenSource={(ref) => setSourceState({ bidId, ref })}
          onSaved={() => shell.refresh()}
          onJumpToRow={(id) => shell.openRow(id)}
          onClose={() => shell.openRow(null)}
          findRowElement={findRowElement}
          api={rowApi}
        />
      )}
      <SourceViewerContainer source={source} docs={shell.docs} onClose={() => setSourceState(null)} api={sourceApi} />
    </>
  );
}

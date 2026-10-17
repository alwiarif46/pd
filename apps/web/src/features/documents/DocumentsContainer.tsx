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
import { jobsKey } from '@/features/shell/controller';
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

/** A bid's progress: kept per bid, so an upload that ends after a bid switch shows on its own bid. */
interface PerBid<T> {
  bidId: string;
  items: T[];
}

/**
 * The Documents tab (05 s3.10, 09 s5.11): v0's panel over the bid's files from the shell, with uploads (one
 * file at a time, with the amendment number), the marking prompt, the key check and its override, the
 * amendment number, delete, restore, and the tabs-status notices. TabFrame draws the 05 s4 states around it
 * (its marking prompt is off here: the panel draws one under each file).
 */
export function DocumentsContainer({ bidId, selectedRowId, api = documentsApi, rowApi, sourceApi }: Props) {
  const shell = useRequiredShell();
  /** Notices and dismissed ids, each keyed by bid: one bid's never touch another's. */
  const [own, setOwn] = useState<Record<string, UploadNotice[]>>({});
  const [progress, setProgress] = useState<PerBid<UploadProgress> | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, string[]>>({});
  const [sourceState, setSourceState] = useState<{ bidId: string; ref: SourceRef } | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  /** Whether this container is mounted and which bid it shows, for uploads that finish later. */
  const liveRef = useRef<{ mounted: boolean; bidId: string }>({ mounted: false, bidId });
  useEffect(() => {
    liveRef.current = { mounted: true, bidId };
    return () => {
      liveRef.current = { mounted: false, bidId };
    };
  }, [bidId]);
  const seqRef = useRef(0);
  /** Files and documents with a call in flight: a second click on the same action is ignored. */
  const busyRef = useRef(new Set<string>());
  const wrapRef = useRef<HTMLDivElement>(null);
  const jobKey = jobsKey({ jobs: shell.jobs });

  // The notices the new-bid screen stashed for this bid (once). Set after a microtask: React forbids a
  // synchronous setState in an effect, and StrictMode runs the effect twice (the second take finds nothing).
  useEffect(() => {
    const taken = takeUploadNotices(bidId);
    if (taken.length === 0) return;
    queueMicrotask(() => setOwn((prev) => ({ ...prev, [bidId]: [...(prev[bidId] ?? []), ...taken] })));
  }, [bidId]);

  const addNotice = (forBid: string, notice: UploadNotice) =>
    setOwn((prev) => ({ ...prev, [forBid]: [...(prev[forBid] ?? []), notice] }));

  const setPercent = (forBid: string, fileName: string, percent: number | null) =>
    setProgress((prev) => {
      const rest = (prev?.bidId === forBid ? prev.items : []).filter((item) => item.fileName !== fileName);
      return { bidId: forBid, items: percent === null ? rest : [...rest, { fileName, percent }] };
    });

  /**
   * Uploads the files one at a time. The typed amendment number goes with the first file only (the server
   * numbers the rest); it is spent whether or not that file is accepted. Uploads are never aborted: a
   * batch that ends after the tab closed or the bid changed reports each outcome by toast instead.
   */
  const runUpload = async (forBid: string, bidName: string, files: File[], kind: FileKind, amendmentNo: number | undefined) => {
    let number = amendmentNo;
    let failed = 0;
    for (const file of files) {
      seqRef.current += 1;
      const id = `${forBid}:upload:${seqRef.current}`;
      const options = {
        ...(number !== undefined ? { amendmentNo: number } : {}),
        onProgress: (p: { chunksSent: number; chunkCount: number }) => setPercent(forBid, file.name, percentOf(p)),
      };
      number = undefined;
      setPercent(forBid, file.name, 0);
      let notice: UploadNotice | null = null;
      try {
        const result = await api.uploadFile(forBid, file, kind, options);
        if (result.duplicate) notice = noticeFor('duplicate', file, id);
      } catch (error) {
        notice = uploadFailureNotice(error, file, id);
      } finally {
        setPercent(forBid, file.name, null);
      }
      if (notice?.tone === 'error') failed += 1;
      if (notice) {
        const shown = liveRef.current.mounted && liveRef.current.bidId === forBid;
        if (shown) addNotice(forBid, notice);
        else (notice.tone === 'info' ? toast.info : toast.error)(`${notice.fileName}: ${notice.message}`);
      }
    }
    if (!(liveRef.current.mounted && liveRef.current.bidId === forBid)) {
      if (failed > 0) toast.error(`Finished uploading to ${bidName}: ${failed} of ${files.length} failed.`);
      else toast.success(`Finished uploading to ${bidName}.`);
    }
    shell.refresh();
  };

  const onUpload = (files: File[], kind: FileKind, amendmentNo?: number) => {
    if (files.length === 0) return;
    const bidName = shell.bid?.name ?? 'the bid';
    queueRef.current = queueRef.current
      .then(() => runUpload(bidId, bidName, files, kind, amendmentNo))
      .catch(() => undefined);
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
    () => shell.docs.filter((dto) => dto.liveStatus !== 'deleted').flatMap((dto) => amendmentTabsNotice(dto) ?? []),
    [shell.docs],
  );
  const hidden = dismissed[bidId] ?? [];
  const notices = [...(own[bidId] ?? []), ...tabsNotices].filter((n) => !hidden.includes(n.id));
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
      onDismissNotice={(id) => setDismissed((prev) => ({ ...prev, [bidId]: [...(prev[bidId] ?? []), id] }))}
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
          reloadKey={jobKey}
          api={rowApi}
        />
      )}
      <SourceViewerContainer source={source} docs={shell.docs} onClose={() => setSourceState(null)} api={sourceApi} />
    </>
  );
}

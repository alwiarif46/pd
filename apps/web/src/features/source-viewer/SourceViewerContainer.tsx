import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, type DocumentDto } from '@/api';
import type { SourceView } from '@/types';
import { SourceViewer } from '@/ui/compliance/SourceViewer';
import { messageOf } from '@/features/shared/messages';
import { useRequiredShell } from '@/features/shell/bid-context';
import { loadSource, sourceApi, type SourceApi, type SourceRef } from './controller';

export interface SourceViewerContainerProps {
  /** The source to show, or null when the viewer is closed. */
  source: SourceRef | null;
  docs: readonly DocumentDto[];
  onClose: () => void;
  /** Test seam; defaults to the typed client. */
  api?: SourceApi;
}

/** The viewing token lasts longer than this; it is renewed quietly while the viewer is open. */
export const TOKEN_RENEWAL_MS = 10 * 60 * 1000;

const LOADING: SourceView = { mode: 'loading' };

/**
 * The source viewer (09 s5.18): loads the source (controller.ts loadSource) and renders v0's SourceViewer, a
 * Radix Dialog that portals to the body (no LegacyFrame). Renews the viewing token every 10 minutes while
 * open, as the legacy viewer did. The object URL of the viewer PDF is revoked, and the load aborted, when the
 * viewer closes or the source changes (each effect run cleans up its own, so StrictMode's double run is safe).
 * Restore is offered to everyone (plan Open question 7): the API refuses when it must, and 402 opens Upgrade.
 */
export function SourceViewerContainer({ source, docs, onClose, api = sourceApi }: SourceViewerContainerProps) {
  const shell = useRequiredShell();
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; view: SourceView; fileName: string | null } | null>(null);
  /** Documents with a restore request in flight: a second click is ignored. */
  const restoringRef = useRef(new Set<string>());

  const documentId = source?.documentId ?? null;
  const page = source?.page ?? 1;
  const pageEnd = source?.pageEnd ?? null;
  const doc = documentId ? (docs.find((d) => d.id === documentId) ?? null) : null;
  const kind = doc?.kind ?? null;
  const key = documentId ? `${documentId}/${page}/${pageEnd ?? ''}/${version}` : null;

  useEffect(() => {
    if (!documentId) return;
    const abort = new AbortController();
    const loadKey = `${documentId}/${page}/${pageEnd ?? ''}/${version}`;
    let url: string | null = null;
    loadSource(api, { documentId, page, pageEnd, quote: null }, kind, abort.signal).then(
      (result) => {
        if (abort.signal.aborted) {
          if (result.objectUrl) URL.revokeObjectURL(result.objectUrl);
          return;
        }
        url = result.objectUrl;
        setLoaded({ key: loadKey, view: result.view, fileName: result.fileName });
      },
      () => undefined, // aborted: the viewer closed or the source changed
    );
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
      url = null;
      // The view is dropped with its URL: reopening the same source shows loading, never a revoked page or an
      // old error.
      setLoaded((prev) => (prev?.key === loadKey ? null : prev));
    };
  }, [api, documentId, page, pageEnd, kind, version]);

  // Quiet token renewal while open; a failed renewal is ignored (the next load asks for a new token).
  useEffect(() => {
    if (!documentId) return;
    const timer = window.setInterval(() => {
      api.getViewToken(documentId).catch(() => undefined);
    }, TOKEN_RENEWAL_MS);
    return () => window.clearInterval(timer);
  }, [api, documentId]);

  if (!source || !documentId) return null;

  const current = loaded?.key === key ? loaded : null;
  const view = current?.view ?? LOADING;
  const fileName = doc?.fileName ?? current?.fileName ?? 'Source document';

  const onRestore = () => {
    if (restoringRef.current.has(documentId)) return;
    restoringRef.current.add(documentId);
    api.restoreDocument(documentId).then(
      () => {
        restoringRef.current.delete(documentId);
        setVersion((n) => n + 1);
        shell.refresh();
      },
      (error: unknown) => {
        restoringRef.current.delete(documentId);
        if (error instanceof ApiError && error.status === 402) shell.openUpgrade('plan');
        else toast.error(messageOf(error));
      },
    );
  };

  return (
    <SourceViewer
      open
      fileName={fileName}
      page={source.page}
      pageEnd={source.pageEnd}
      quote={source.quote}
      view={view}
      canRestore
      onRestore={onRestore}
      onRetry={() => setVersion((n) => n + 1)}
      onClose={onClose}
    />
  );
}

import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface PageText {
  pageNo: number;
  text: string;
}

export function SourceViewer({
  documentId,
  page,
  pageEnd,
  quote,
  onClose,
}: {
  documentId: string;
  page: number;
  pageEnd: number | null;
  quote: string | null;
  onClose: () => void;
}) {
  const [pages, setPages] = useState<PageText[] | null>(null);
  const [note, setNote] = useState('');
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    async function load() {
      const grant = await api<{ token: string }>(`/api/documents/${documentId}/view-token`);
      await api(`/api/documents/view/${grant.token}`);
      const to = pageEnd && pageEnd > page ? pageEnd : page;
      const payload = await api<{
        pagesEstimated: number | null;
        extractMethod: string | null;
        liveStatus: string | null;
        pages: PageText[];
      }>(`/api/documents/${documentId}/pages?from=${page}&to=${to}`);
      if (cancelled) return;
      setPages(payload.pages);
      if (payload.extractMethod === 'docx_text_fallback' || payload.pagesEstimated) {
        setNote('Page estimated');
      }
      if (payload.liveStatus === 'archived') {
        setNote('This file is archived. The stored quote and page text are shown until it is restored.');
      }
      if (payload.liveStatus === 'deleted') {
        setNote('Resume deleted after 90 days');
        return;
      }
      if (payload.liveStatus === 'live' || payload.liveStatus === 'restored' || payload.liveStatus === null) {
        const headers = new Headers();
        const current = sessionStorage.getItem('pd-token');
        if (current) headers.set('Authorization', `Bearer ${current}`);
        const file = await fetch(`/api/documents/${documentId}/file`, { headers });
        if (file.ok) {
          const blob = await file.blob();
          if (!cancelled) {
            const url = URL.createObjectURL(blob);
            urlRef.current = url;
            setFileUrl(url);
          }
        }
      }
    }
    load().catch((error: Error) => {
      if (!cancelled) setNote(error.message);
    });
    timer = window.setInterval(() => {
      api(`/api/documents/${documentId}/view-token`).catch(() => undefined);
    }, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [documentId, page, pageEnd]);

  return (
    <div className="viewer" role="dialog" aria-label="Source viewer">
      <div className="row">
        <strong>Page {page}{pageEnd && pageEnd !== page ? `–${pageEnd}` : ''}</strong>
        <span className="grow" />
        <button className="btn secondary" type="button" onClick={onClose}>Close</button>
      </div>
      <div className="stack" style={{ overflow: 'auto' }}>
        {note ? <p>{note}</p> : null}
        {quote ? <blockquote className="quote">{quote}</blockquote> : null}
        {fileUrl ? <iframe title="Document page" src={`${fileUrl}#page=${page}`} style={{ width: '100%', minHeight: '50vh', border: 0 }} /> : null}
        {pages === null ? <div className="skeleton" /> : pages.map((item) => (
          <pre key={item.pageNo}>{markQuote(item.text, quote)}</pre>
        ))}
        {pages?.length === 0 ? <p>No page text is stored for this page.</p> : null}
      </div>
    </div>
  );
}

function markQuote(text: string, quote: string | null): string {
  if (!quote) return text;
  const needle = quote.slice(0, 80);
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return `${text.slice(0, index)}[${text.slice(index, index + needle.length)}]${text.slice(index + needle.length)}`;
}

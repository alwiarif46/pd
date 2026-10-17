import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { PageText, SourceViewerProps } from './types';

function quotePattern(quote: string) {
  const escaped = quote
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return escaped;
}

function marked(text: string, quote: string | null) {
  if (!quote || !quote.trim()) return text;
  const parts = text.split(new RegExp(`(${quotePattern(quote)})`, 'i'));
  return parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

function pageList(pageTexts: PageText[], quote: string | null) {
  return (
    <div className="flex flex-col gap-4">
      {pageTexts.map((p) => {
        const found = !quote || !quote.trim() || new RegExp(quotePattern(quote), 'i').test(p.text);
        return (
          <section key={p.pageNo}>
            <h3 className="font-semibold">Page {p.pageNo}</h3>
            {!found && quote && (
              <div className="my-2">
                <blockquote className="border-l-2 border-primary bg-canvas p-3 text-sm">{quote}</blockquote>
                <p className="mt-1 text-sm text-muted-foreground">The quote could not be located on this page.</p>
              </div>
            )}
            <p className="whitespace-pre-wrap rounded border border-line bg-canvas p-4 text-sm">
              {marked(p.text, quote)}
            </p>
          </section>
        );
      })}
    </div>
  );
}

export function SourceViewer({
  open,
  fileName,
  page,
  pageEnd,
  quote,
  view,
  canRestore,
  onRestore,
  onRetry,
  onClose,
}: SourceViewerProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col rounded-none sm:top-[50%] sm:left-[50%] sm:h-[min(90vh,900px)] sm:max-w-5xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg"
      >
        <DialogHeader>
          <DialogTitle>{fileName}</DialogTitle>
          <DialogDescription>
            {pageEnd !== null && pageEnd !== page ? `Pages ${page}–${pageEnd}` : `Page ${page}`}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto py-4">
          {view.mode === 'loading' && (
            <div className="flex flex-col gap-4" aria-busy="true">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          )}
          {view.mode === 'page' && (
            <div className="flex flex-col gap-4">
              {quote && (
                <div>
                  <h3 className="mb-1 text-sm font-medium">Quote</h3>
                  <blockquote className="border-l-2 border-primary bg-canvas p-3 text-sm">{quote}</blockquote>
                </div>
              )}
              <div className="max-h-full overflow-auto rounded border border-line bg-canvas p-4">{view.pageView}</div>
            </div>
          )}
          {view.mode === 'text' && (
            <div className="flex flex-col gap-3">
              <Badge variant="secondary" className="w-fit">
                Page estimated
              </Badge>
              {pageList(view.pages, quote)}
            </div>
          )}
          {view.mode === 'archived' && (
            <div className="flex flex-col gap-4">
              <p className="rounded bg-holiday p-3">This file is archived. The stored quote and page text are shown.</p>
              {view.restore === 'requested' && (
                <Button disabled className="w-fit">
                  Restore requested
                </Button>
              )}
              {view.restore === 'restoring' && (
                <Button disabled className="w-fit">
                  <Loader2 className="animate-spin" aria-hidden="true" /> Restoring (a short wait)
                </Button>
              )}
              {view.restore === 'none' &&
                (canRestore ? (
                  <Button className="w-fit" onClick={onRestore}>
                    Restore file
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">Ask the bid owner to restore this file.</p>
                ))}
              {pageList(view.pages, quote)}
            </div>
          )}
          {view.mode === 'resume_deleted' && (
            <div role="alert" className="flex flex-col gap-1">
              <p className="font-semibold">Resume deleted after 90 days</p>
              <p className="text-sm text-muted-foreground">The quote and page text were deleted with the resume.</p>
            </div>
          )}
          {view.mode === 'error' && (
            <div className="flex flex-col items-start gap-3">
              <p role="alert">{view.message}</p>
              <Button onClick={onRetry}>Try again</Button>
            </div>
          )}
        </div>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  );
}

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { SourceViewerProps } from './types'

export function SourceViewer({ open, fileName, page, pageEnd, quote, state, onClose, onRestore }: SourceViewerProps) {
  if (!open) return null
  const archived = state === 'archived' || state === 'restoring'
  return <aside aria-label="Source viewer" className="fixed inset-0 z-30 flex items-center justify-center bg-ink/40 p-4"><div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line bg-paper"><header className="flex items-center justify-between border-b border-line p-4"><div><p className="text-sm text-muted-foreground">{fileName ?? 'Source document'}</p><h2 className="font-semibold">{page ? `Page ${page}${pageEnd ? `–${pageEnd}` : ''}` : 'Source unavailable'}</h2></div><Button variant="ghost" onClick={onClose}>Close</Button></header><div className="flex flex-col gap-4 overflow-y-auto p-6">{state === 'deleted' ? <p role="alert" className="rounded-md bg-canvas p-4">Resume deleted after 90 days.</p> : archived ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-holiday p-4"><p>{state === 'restoring' ? 'Restoring this file.' : 'This file is archived. The stored quote remains available.'}</p><Button onClick={onRestore}>Restore</Button></div> : <><div className="min-h-64 rounded-md border border-dashed border-line bg-canvas p-8 text-sm text-muted-foreground">Page text preview</div><div className="rounded-md border-2 border-primary/30 bg-holiday p-4"><Badge>Matched quote</Badge><p className="mt-2">{quote ?? 'No quote stored.'}</p></div></>}</div></div></aside>
}

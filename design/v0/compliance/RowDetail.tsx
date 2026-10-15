import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SourceLink } from '../common/SourceLink'
import type { RowDetailProps } from './types'

export function RowDetail({ open, row, onClose, onEdit, onOpenSource }: RowDetailProps) {
  if (!open || !row) return null
  return <aside aria-label="Row detail" className="fixed inset-y-0 right-0 z-20 w-full max-w-xl overflow-y-auto border-l border-line bg-paper p-6 shadow-xl"><div className="flex items-start justify-between gap-4"><div><p className="text-sm text-muted-foreground">Requirement detail</p><h2 className="text-xl font-semibold">{row.title}</h2></div><Button variant="ghost" onClick={onClose}>Close</Button></div><div className="mt-6 flex flex-col gap-4"><div><h3 className="font-semibold">Verbatim source text</h3><p className="mt-1 rounded-md bg-canvas p-3 text-sm">{row.sourceQuote ?? 'No stored quote'}</p></div><div className="grid gap-3 text-sm sm:grid-cols-2"><p><span className="font-medium">Section:</span> {row.sectionRef ?? '—'}</p><p><span className="font-medium">Document:</span> {row.documentName ?? '—'}</p><p><span className="font-medium">Requirement type:</span> {row.reqType ?? '—'}</p><p><span className="font-medium">Owner:</span> {row.owner ?? 'Unassigned'}</p><p><span className="font-medium">Status:</span> {row.status ?? '—'}</p><p><span className="font-medium">Origin:</span> {row.origin ?? '—'}</p></div><Separator /><div className="flex flex-wrap gap-2">{row.flags.map((flag) => <Badge key={flag} variant="secondary">{flag}</Badge>)}{row.quoteVerified && <Badge>Quote verified</Badge>}</div><div className="flex items-center gap-3"><SourceLink page={row.sourcePage} pageEnd={row.sourcePageEnd} rowLabel={row.title} onOpen={onOpenSource} /><Button variant="outline" onClick={onOpenSource}>Open source</Button><Button onClick={onEdit}>Edit</Button></div></div></aside>
}

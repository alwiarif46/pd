import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Loader2, Pencil, Upload, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DocumentsPanelProps, Doc, FileKind } from './types';

const KIND_LABELS: Record<FileKind, string> = {
  solicitation: 'Solicitation', amendment: 'Amendment', attachment: 'Attachment', resume: 'Resume', draft: 'Draft',
};
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt';

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function formatDateOnly(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(year, month - 1, day));
}
function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} GB`;
}
function Status({ doc }: { doc: Doc }) {
  if (doc.status === 'scanning' || doc.status === 'extracting') return <Badge variant="secondary"><Loader2 className="mr-1 size-3 animate-spin" />{doc.status}</Badge>;
  if (doc.status === 'ready') return <Badge variant="outline" className="text-team-green"><CheckCircle2 className="mr-1 size-3" />Ready</Badge>;
  return <Badge variant="destructive">{doc.status}</Badge>;
}
function Marking({ doc }: { doc: Doc }) {
  if (doc.markingState === 'blocked') return <span className="text-warning">Paused: {doc.markings || 'needs review'}</span>;
  if (doc.markingState === 'confirmed') return <span>Confirmed public</span>;
  return <span>—</span>;
}
function NumberEditor({ id, initial, onSave, label = 'Amendment number', buttonLabel = 'Save number' }: { id: string; initial?: number; onSave: (value: number) => void; label?: string; buttonLabel?: string }) {
  const [value, setValue] = useState(initial?.toString() || '');
  const number = Number(value);
  const valid = Number.isInteger(number) && number >= 1 && number <= 999;
  return <div className="flex flex-wrap items-end gap-2">
    <div className="flex flex-col gap-1"><Label htmlFor={id}>{label}</Label><Input id={id} type="number" min={1} max={999} value={value} onChange={(event) => setValue(event.target.value)} className="h-9 w-28" /></div>
    <Button type="button" size="sm" disabled={!valid} onClick={() => onSave(number)}>{buttonLabel}</Button>
  </div>;
}
function DocumentRow({ doc, onOpen, onDelete, onSetAmendmentNo }: Pick<DocumentsPanelProps, 'onOpen' | 'onDelete' | 'onSetAmendmentNo'> & { doc: Doc }) {
  const [editing, setEditing] = useState(false);
  return <>
    <TableRow className="align-top">
      <TableCell className="sticky left-0 z-[1] min-w-52 bg-paper font-medium"><button type="button" onClick={() => onOpen(doc.id)} className="flex items-start gap-2 text-left text-primary underline-offset-4 hover:underline"><FileText className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span>{doc.name}</span></button><div className="mt-1 text-xs text-muted-foreground">{doc.pages ? `${doc.pages} pages · ` : ''}{formatTimestamp(doc.uploadedAt)}</div></TableCell>
      <TableCell>{KIND_LABELS[doc.kind]}</TableCell>
      <TableCell>{doc.kind === 'amendment' ? <div className="flex flex-col gap-2">{doc.amendmentNoAssumed ? <><div className="flex items-center gap-2"><span>Amd {doc.amendmentNoFound ?? '—'} (assumed)</span><Button variant="ghost" size="icon" className="size-7" aria-label="Edit amendment number" onClick={() => setEditing((current) => !current)}><Pencil className="size-3.5" /></Button></div>{editing && <NumberEditor id={`edit-${doc.id}`} initial={doc.amendmentNoFound ?? undefined} onSave={(number) => { onSetAmendmentNo(doc.id, number); setEditing(false); }} />}</> : <span>{doc.amendmentNoFound !== null ? `Amd ${doc.amendmentNoFound}` : '—'}</span>}{doc.amendmentNoFound !== null && <span className="text-xs text-muted-foreground">The file reads Amendment {doc.amendmentNoFound}</span>}</div> : '—'}</TableCell>
      <TableCell><Marking doc={doc} /></TableCell>
      <TableCell><Status doc={doc} /></TableCell>
      <TableCell className="text-right"><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => onOpen(doc.id)}>Open</Button>{doc.status !== 'deleted' && <Button variant="ghost" size="icon" aria-label={`Delete ${doc.name}`} onClick={() => onDelete(doc.id)}><X className="size-4" /></Button>}</div></TableCell>
    </TableRow>
    {doc.needsNumber && <TableRow><TableCell colSpan={6} className="bg-warning/10"><div className="flex flex-wrap items-start gap-3"><AlertTriangle className="mt-1 size-4 text-warning" aria-hidden="true" /><div className="flex flex-col gap-2"><p className="text-sm">Set the amendment number. The number in this file is already used on this bid, or the file names two numbers.</p><NumberEditor id={`needed-${doc.id}`} onSave={(number) => onSetAmendmentNo(doc.id, number)} buttonLabel="Set number" /></div></div></TableCell></TableRow>}
  </>;
}

export function DocumentsPanel({ docs, storageUsedBytes, storageLimitBytes, onUpload, onDelete, onOpen, onSetAmendmentNo }: DocumentsPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<FileKind>('attachment');
  const [amendmentNo, setAmendmentNo] = useState('');
  const [dragging, setDragging] = useState(false);
  const percent = Math.min(100, (storageUsedBytes / storageLimitBytes) * 100);
  const handleFiles = (files: FileList | File[]) => { const selected = Array.from(files); if (selected.length) onUpload(selected, kind, kind === 'amendment' && amendmentNo ? Number(amendmentNo) : undefined); };
  return <section className="flex min-w-0 flex-col gap-6 bg-canvas p-4 text-ink md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Workspace / files</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Documents</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Keep solicitation files, amendments, and working drafts together. Files are automatically scanned and retained securely.</p></div><div className="min-w-52"><div className="mb-2 flex justify-between text-xs"><span>Storage</span><span>{formatBytes(storageUsedBytes)} of {formatBytes(storageLimitBytes)}</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${percent >= 90 ? 'bg-warning' : 'bg-primary'}`} style={{ width: `${percent}%` }} /></div></div></header>
    <Alert><AlertDescription>Files are deleted 90 days after your bid closes. Download anything you need before then.</AlertDescription></Alert>
    <div onDragEnter={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setDragging(false); handleFiles(event.dataTransfer.files); }} className={`flex flex-wrap items-end justify-between gap-4 rounded-lg border-2 border-dashed p-5 ${dragging ? 'border-primary bg-primary/5' : 'border-line bg-paper'}`}><div><p className="font-medium">Add files</p><p className="mt-1 text-sm text-muted-foreground">Drop files here or choose from your device.</p></div><div className="flex flex-wrap items-end gap-2"><div className="flex flex-col gap-1"><Label htmlFor="file-kind">Kind</Label><Select value={kind} onValueChange={(value) => setKind(value as FileKind)}><SelectTrigger id="file-kind" className="w-36"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(KIND_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>{kind === 'amendment' && <div className="flex flex-col gap-1"><Label htmlFor="upload-amendment">Amendment number</Label><Input id="upload-amendment" type="number" min={1} max={999} value={amendmentNo} onChange={(event) => setAmendmentNo(event.target.value)} className="w-28" /></div>}<Button type="button" onClick={() => inputRef.current?.click()}><Upload className="mr-2 size-4" />Add amendment</Button><input ref={inputRef} type="file" multiple accept={ACCEPT} className="sr-only" onChange={(event) => { if (event.target.files) handleFiles(event.target.files); event.currentTarget.value = ''; }} /></div></div>
    {docs.length === 0 ? <div className="rounded-lg border border-dashed border-line bg-paper px-6 py-14 text-center"><FileText className="mx-auto size-8 text-muted-foreground" aria-hidden="true" /><h2 className="mt-3 font-semibold">No documents yet</h2><p className="mt-1 text-sm text-muted-foreground">Upload your solicitation to start building the bid workspace.</p></div> : <TooltipProvider><div role="region" aria-label="Files on this bid" tabIndex={0} className="overflow-x-auto rounded-lg border border-line bg-paper focus-visible:outline-2 focus-visible:outline-primary"><Table><TableHeader><TableRow><TableHead className="sticky left-0 z-[1] bg-paper">Name</TableHead><TableHead>Kind</TableHead><TableHead>Amendment</TableHead><TableHead>Marking</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{docs.map((doc) => <DocumentRow key={doc.id} doc={doc} onOpen={onOpen} onDelete={onDelete} onSetAmendmentNo={onSetAmendmentNo} />)}</TableBody></Table></div></TooltipProvider>}
    <p className="text-xs text-muted-foreground">Deleted resumes are retained for 90 days. {docs.some((doc) => doc.status === 'deleted') && 'Deleted after 90 days'}</p>
  </section>;
}

export default DocumentsPanel;

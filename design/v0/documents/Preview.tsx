import type { ReactNode } from 'react';
import { DocumentsPanel } from './DocumentsPanel';
import type { Doc, DocumentsPanelProps } from './types';

const base: Omit<Doc, 'id' | 'name' | 'status'> = {
  kind: 'attachment', uploadedAt: '2026-10-17T15:32:00.000Z', deleteOn: '2027-01-15', amendmentNoAssumed: false, amendmentNoFound: null, needsNumber: false, markingState: 'none',
};
const PREVIEW_DOCS: Doc[] = [
  { ...base, id: 'solicitation', name: 'RFP-2026-041 Solicitation.pdf', kind: 'solicitation', pages: 84, status: 'ready', markingState: 'confirmed' },
  { ...base, id: 'amendment-assumed', name: 'Amendment 2 - revised scope.pdf', kind: 'amendment', pages: 4, status: 'ready', amendmentNoAssumed: true, amendmentNoFound: 2 },
  { ...base, id: 'amendment-different', name: 'signed-amendment-final.pdf', kind: 'amendment', status: 'ready', amendmentNoFound: 4 },
  { ...base, id: 'amendment-needed', name: 'amendment-conflicting-numbers.pdf', kind: 'amendment', status: 'ready', needsNumber: true, amendmentNoFound: null },
  { ...base, id: 'extracting', name: 'price-schedule.xlsx', kind: 'attachment', status: 'extracting' },
  { ...base, id: 'scanning', name: 'draft-technical-approach.docx', kind: 'draft', status: 'scanning', markingState: 'blocked', markings: 'agency review required' },
  { ...base, id: 'failed', name: 'team-resume.pdf', kind: 'resume', status: 'failed' },
  { ...base, id: 'deleted', name: 'old-resume.pdf', kind: 'resume', status: 'deleted' },
];
const noop: DocumentsPanelProps['onUpload'] = () => {};
const noDelete: DocumentsPanelProps['onDelete'] = () => {};
const noOpen: DocumentsPanelProps['onOpen'] = () => {};
const noSetNumber: DocumentsPanelProps['onSetAmendmentNo'] = () => {};

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return <section className="border-b-4 border-ink"><div className="bg-paper px-4 py-2 font-mono text-sm text-muted-foreground">{label}</div>{children}</section>;
}

export function Preview() {
  const states: { id: string; label: string; docs: Doc[] }[] = [
    { id: 'documents-populated', label: 'Documents · all states and amendment workflows', docs: PREVIEW_DOCS },
    { id: 'documents-empty', label: 'Documents · empty state', docs: [] },
  ];
  return <div className="bg-canvas text-ink"><nav aria-label="Documents previews" className="sticky top-0 z-10 border-b border-line bg-paper px-4 py-3"><ul className="flex gap-4 overflow-x-auto whitespace-nowrap text-sm">{states.map((state) => <li key={state.id}><a href={`#${state.id}`} className="text-primary underline-offset-4 hover:underline">{state.label}</a></li>)}</ul></nav>{states.map((state) => <Frame key={state.id} label={state.label}><div id={state.id}><DocumentsPanel docs={state.docs} storageUsedBytes={state.docs.length ? 9.3 * 1024 * 1024 * 1024 : 0} storageLimitBytes={10 * 1024 * 1024 * 1024} onUpload={noop} onDelete={noDelete} onOpen={noOpen} onSetAmendmentNo={noSetNumber} /></div></Frame>)}</div>;
}

export default Preview;

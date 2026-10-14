import { useEffect, useState } from 'react';
import { api } from '../legacy-api';
import type { DocumentRow, SourceFields } from '../models';

interface HistoryRow {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
  userId: string | null;
}

export function RowDetail({
  bidId,
  table,
  rowId,
  federal,
  documents,
  onClose,
  onOpenSource,
  onSaved,
}: {
  bidId: string;
  table: string;
  rowId: string;
  federal: boolean;
  documents: DocumentRow[];
  onClose: () => void;
  onOpenSource: (row: SourceFields) => void;
  onSaved: () => void;
}) {
  const [row, setRow] = useState<SourceFields | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState('');
  const [value, setValue] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    api<{ row: SourceFields; history: HistoryRow[] }>(`/api/bids/${bidId}/rows/${table}/${rowId}`).then((payload) => {
      setRow(payload.row);
      setHistory(payload.history);
      setOwner(payload.row.owner ?? '');
      setStatus(payload.row.status ?? '');
      setValue(payload.row.value ?? payload.row.requirementText ?? '');
    }).catch(() => setRow(null));
  }, [bidId, table, rowId]);

  async function save() {
    const fields: Record<string, string> = {};
    if (table === 'bid_facts') fields.value = value;
    if (table === 'compliance_rows') {
      fields.owner = owner;
      fields.status = status;
      fields.requirementText = value;
    }
    if (row?.owner !== undefined || table === 'schedule_activities' || table === 'outline_items') {
      fields.owner = owner;
      fields.status = status;
    }
    await api(`/api/bids/${bidId}/rows/${table}/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields }),
    });
    setEditing(false);
    onSaved();
  }

  const file = documents.find((item) => item.id === row?.documentId);
  const amendment = row?.amendmentNo ? `Amd ${row.amendmentNo}` : 'Original';

  return (
    <aside className="slider" aria-label="Row detail">
      <div className="row">
        <h2>Row detail</h2>
        <span className="grow" />
        <button className="btn secondary" type="button" onClick={onClose}>Close</button>
      </div>
      {row === null ? <div className="skeleton" /> : (
        <div className="stack">
          {row.sourceQuote ? <div><strong>Verbatim source text</strong><blockquote className="quote">{row.sourceQuote}</blockquote></div> : null}
          {row.sectionRef || row.sourceRef ? <p><strong>Section reference</strong> {row.sectionRef || row.sourceRef}</p> : null}
          {file ? <p><strong>Document</strong> {file.fileName}</p> : null}
          {row.sourcePage ? <p><strong>Page</strong> <span className="num">{row.sourcePage}{row.sourcePageEnd ? `–${row.sourcePageEnd}` : ''}</span></p> : null}
          <p><strong>Amendment</strong> {amendment}{row.supersedeStatus ? ` · ${row.supersedeStatus}` : ''}</p>
          {row.reqType ? <p><strong>Requirement type</strong> {row.reqType}</p> : null}
          {row.instrRef || row.evalRef ? (
            <p><strong>{federal ? 'L ref / M factor' : 'Instruction / evaluation'}</strong> {row.instrRef || '—'} / {row.evalRef || '—'}</p>
          ) : null}
          {row.confidence ? <p><strong>Confidence</strong> <span className="num">{row.confidence}</span></p> : null}
          {row.flags && row.flags.length > 0 ? <p><strong>Flags</strong> {row.flags.join(', ')}</p> : null}
          <p><strong>Verified</strong> {row.quoteVerified || row.confirmed ? 'Yes' : 'No'}</p>
          {(row.owner !== undefined || row.status !== undefined) ? <p><strong>Owner and status</strong> {row.owner || '—'} · {row.status || '—'}</p> : null}
          {row.origin ? <p><strong>Origin</strong> {row.origin === 'user' ? 'User' : 'AI'}</p> : null}
          {editing ? (
            <div className="stack">
              <label className="field">Text
                <textarea value={value} onChange={(event) => setValue(event.target.value)} rows={4} />
              </label>
              <label className="field">Owner
                <input value={owner} onChange={(event) => setOwner(event.target.value)} />
              </label>
              <label className="field">Status
                <input value={status} onChange={(event) => setStatus(event.target.value)} />
              </label>
              <button className="btn" type="button" onClick={() => { save().catch(() => undefined); }}>Save</button>
            </div>
          ) : null}
          <h3>Edit history</h3>
          {history.length === 0 ? <p className="muted">No edits yet.</p> : (
            <ul>
              {history.map((item) => (
                <li key={item.id}>{item.field}: {item.oldValue ?? 'empty'} → {item.newValue ?? 'empty'} · <span className="num">{item.changedAt.slice(0, 16).replace('T', ' ')}</span></li>
              ))}
            </ul>
          )}
          <div className="row">
            <button className="btn" type="button" onClick={() => onOpenSource(row)} disabled={!row.documentId}>Open source</button>
            <button className="btn secondary" type="button" onClick={() => setEditing(true)}>Edit</button>
          </div>
        </div>
      )}
    </aside>
  );
}

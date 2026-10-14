import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, api, uploadFile } from '../legacy-api';
import { Dialog } from '../components/Dialog';
import { RowDetail } from '../components/RowDetail';
import { SourceViewer } from '../components/SourceViewer';
import { downloadCsv, downloadDocx, downloadIcs, downloadXlsx } from '../export';
import {
  type Bid,
  type DocumentRow,
  type JobRow,
  type OrgPayload,
  type SourceFields,
  type TabId,
  TAB_LABEL,
  capMb,
  dayKey,
  daysLeft,
  mb,
} from '../models';

const ICONS: Record<TabId, string> = {
  overview: 'Ov',
  schedule: 'Sc',
  compliance: 'Cx',
  outline: 'Ol',
  resumes: 'Rs',
  reviews: 'Rv',
  production: 'Pr',
  orals: 'Or',
  lessons: 'Ls',
  documents: 'Dc',
  settings: 'St',
};

const PAID: TabId[] = ['outline', 'resumes', 'reviews', 'production', 'orals', 'lessons'];

export function Workspace({
  bidId,
  tab,
  bids,
  org,
  onTab,
  onSwitch,
}: {
  bidId: string;
  tab: TabId;
  bids: Bid[];
  org: OrgPayload | null;
  onTab: (tab: TabId) => void;
  onSwitch: (id: string) => void;
}) {
  const [bid, setBid] = useState<Bid | null>(null);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [links, setLinks] = useState<{ id: string; status: string; action: string; oldRowId: string | null; newRowId: string | null; confidence: string | null }[]>([]);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [menu, setMenu] = useState(false);
  const [selected, setSelected] = useState<{ table: string; id: string } | null>(null);
  const [source, setSource] = useState<SourceFields | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [slow, setSlow] = useState(false);

  const plan = org?.org?.plan ?? 'free';
  const locked = plan === 'free' && PAID.includes(tab);

  function reload() {
    api<Bid>(`/api/bids/${bidId}`).then(setBid).catch((err: Error) => setError(err.message));
    api<DocumentRow[]>(`/api/bids/${bidId}/documents`).then(setDocs).catch(() => undefined);
    api<JobRow[]>(`/api/bids/${bidId}/jobs`).then(setJobs).catch(() => undefined);
    api<typeof links>(`/api/bids/${bidId}/amendment-links`).then(setLinks).catch(() => undefined);
    if (tab !== 'documents' && tab !== 'settings' && !locked) {
      const started = Date.now();
      setData(null);
      api<Record<string, unknown>>(`/api/bids/${bidId}/tabs/${tab}`).then((payload) => {
        if (Date.now() - started > 100) setSlow(false);
        setData(payload);
      }).catch((err: Error) => setError(err.message));
      const timer = window.setTimeout(() => setSlow(true), 1000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }

  useEffect(() => {
    setError('');
    setSlow(false);
    return reload();
  }, [bidId, tab, plan]);

  useEffect(() => {
    if (tab === 'overview' || tab === 'production' || tab === 'orals' || tab === 'lessons') {
      api(`/api/bids/${bidId}/tabs/${tab}/seed`, { method: 'POST', body: '{}' }).then(() => reload()).catch(() => undefined);
    }
  }, [bidId, tab]);

  const solicitation = docs.some((doc) => doc.kind === 'solicitation');
  const activeJobs = jobs.filter((job) => job.status === 'pending' || job.status === 'running');
  const failed = jobs.find((job) => job.status === 'failed');
  const blocked = docs.find((doc) => doc.markingStatus === 'blocked');
  const proposed = links.filter((link) => link.status === 'proposed');
  const credits = org?.credits;
  const creditsLeft = credits ? credits.allowed - credits.used - credits.reserved : null;
  const usedBytes = docs.reduce((sum, doc) => sum + doc.sizeBytes, 0);
  const cap = capMb(plan) * 1024 * 1024;

  const tabs: TabId[] = [
    'overview', 'schedule', 'compliance',
    'outline', 'resumes', 'reviews', 'production',
    ...(bid?.oralsEnabled ? ['orals' as const] : []),
    'lessons', 'documents', 'settings',
  ];

  function openRow(table: string, id: string) {
    setSelected({ table, id });
  }

  return (
    <div className="workspace">
      <nav className={menu ? 'sidebar open' : 'sidebar'} aria-label="Bid sections">
        {tabs.map((item, index) => (
          <span key={item}>
            {index === 3 ? <hr className="divider" /> : null}
            {item === 'documents' ? <hr className="divider" /> : null}
            <button type="button" aria-label={TAB_LABEL[item]} aria-current={item === tab ? 'page' : undefined} onClick={() => { onTab(item); setMenu(false); }}>
              <span className="icon" aria-hidden="true">{PAID.includes(item) && plan === 'free' ? 'Lk' : ICONS[item]}</span>
              <span className="nav-label">{TAB_LABEL[item]}{PAID.includes(item) && plan === 'free' ? ' (locked)' : ''}</span>
            </button>
          </span>
        ))}
      </nav>
      <div className="content stack">
        <div className="row no-print">
          <button className="menu-btn" type="button" onClick={() => setMenu((open) => !open)}>Menu</button>
          <h1>{TAB_LABEL[tab]}</h1>
          <span className="grow" />
          <label className="small">Bid
            <select value={bidId} onChange={(event) => onSwitch(event.target.value)}>
              {bids.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        </div>
        {bid?.dueDate ? <p className="num">Due {bid.dueDate.slice(0, 10)} {bid.dueTime || ''} {bid.timeZone || ''} · {daysLeft(bid.dueDate)}</p> : null}
        {error ? <p className="banner bad">{error}</p> : null}
        {notice ? <p className="banner">{notice}</p> : null}
        {creditsLeft !== null && creditsLeft <= 0 ? (
          <p className="banner warn">Out of RFP credits. {creditsLeft} left. Resets {credits?.periodEnd.slice(0, 10)}. <a href="#/org">Upgrade</a></p>
        ) : null}
        {usedBytes > cap ? <p className="banner bad">{mb(usedBytes)} used of {capMb(plan)} MB. <a href="#/org">Upgrade</a></p> : null}
        {!solicitation && tab !== 'settings' ? <p className="banner">No solicitation yet. Upload the solicitation file from Documents.</p> : null}
        {activeJobs.length > 0 ? (
          <div className="banner">
            <strong>Processing</strong>
            <ul>
              {activeJobs.map((job) => (
                <li key={job.id}>{stepName(job.type)} · {job.progress}% · queue {job.queuePosition ?? '—'} · usually a few minutes</li>
              ))}
            </ul>
          </div>
        ) : null}
        {blocked ? (
          <div className="banner warn">
            <p>This file carries the marking {(blocked.markingFound ?? []).join(', ') || 'a controlled marking'}. AI processing is paused. Confirm the file is public or approved for third-party processing.</p>
            <div className="row">
              <button className="btn" type="button" onClick={() => {
                api(`/api/documents/${blocked.id}/confirm-marking`, { method: 'POST' }).then(reload).catch((err: Error) => setError(err.message));
              }}>Confirm</button>
              <button className="btn danger" type="button" onClick={() => {
                api(`/api/documents/${blocked.id}`, { method: 'DELETE' }).then(reload).catch((err: Error) => setError(err.message));
              }}>Remove the file</button>
            </div>
          </div>
        ) : null}
        {failed ? (
          <div className="banner bad">
            <p>This step did not finish.</p>
            <button className="btn" type="button" onClick={() => {
              api(`/api/jobs/${failed.id}/retry`, { method: 'POST' }).then(reload).catch((err: Error) => setError(err.message));
            }}>Retry</button>
          </div>
        ) : null}
        {proposed.length > 0 ? (
          <div className="banner warn stack">
            <strong>Confirm amendment changes</strong>
            {proposed.map((link) => (
              <div key={link.id} className="row">
                <span>{link.action} · old {link.oldRowId ?? 'none'} · new {link.newRowId ?? 'none'} · confidence {link.confidence ?? '—'}</span>
                <button className="btn" type="button" onClick={() => api(`/api/amendment-links/${link.id}/confirm`, { method: 'POST' }).then(reload)}>Confirm</button>
                <button className="btn secondary" type="button" onClick={() => api(`/api/amendment-links/${link.id}/reject`, { method: 'POST' }).then(reload)}>Reject</button>
              </div>
            ))}
          </div>
        ) : null}
        {locked ? <Locked tab={tab} /> : slow && data === null ? <div className="stack"><div className="skeleton" /><div className="skeleton" /></div> : (
          <TabPanel
            tab={tab}
            bid={bid}
            plan={plan}
            docs={docs}
            data={data}
            onOpen={openRow}
            onNotice={setNotice}
            onError={setError}
            onReload={reload}
          />
        )}
      </div>
      {selected ? (
        <RowDetail
          bidId={bidId}
          table={selected.table}
          rowId={selected.id}
          federal={bid?.bidType === 'federal'}
          documents={docs}
          onClose={() => setSelected(null)}
          onOpenSource={(row) => setSource(row)}
          onSaved={reload}
        />
      ) : null}
      {source?.documentId ? (
        <SourceViewer
          documentId={source.documentId}
          page={source.sourcePage ?? 1}
          pageEnd={source.sourcePageEnd ?? null}
          quote={source.sourceQuote ?? null}
          onClose={() => setSource(null)}
        />
      ) : null}
    </div>
  );
}

function stepName(type: string): string {
  switch (type) {
    case 'scan': return 'Virus scan';
    case 'file': return 'Read the file';
    case 'marking': return 'Marking check';
    case 'classify': return 'Classify pages';
    case 'overview': return 'Bid facts';
    case 'dates': return 'Dates';
    case 'compliance': return 'Compliance matrix';
    case 'amendment': return 'Amendment';
    default: return 'Processing';
  }
}

function Locked({ tab }: { tab: TabId }) {
  const copy: Record<string, string> = {
    outline: 'A volume and section tree with page budgets, writers, and due dates.',
    resumes: 'Roles and requirements beside candidate resumes, with gaps called out.',
    reviews: 'Pink, red, green, and gold team findings against the evaluation factors.',
    production: 'A submission checklist drawn from the solicitation.',
    orals: 'Orals rules, a preparation checklist, and a session plan.',
    lessons: 'A short survey after submission or award.',
  };
  return (
    <section className="card stack">
      <h2>{TAB_LABEL[tab]} is on a paid plan</h2>
      <p>{copy[tab]}</p>
      <div className="sample" aria-label="Sample">
        <p className="small muted">Sample</p>
        <table>
          <thead><tr><th>Item</th><th>Status</th></tr></thead>
          <tbody><tr><td>Example row</td><td>Not started</td></tr></tbody>
        </table>
      </div>
      <a className="btn" href="#/org">Upgrade</a>
    </section>
  );
}

function TabPanel(props: {
  tab: TabId;
  bid: Bid | null;
  plan: string;
  docs: DocumentRow[];
  data: Record<string, unknown> | null;
  onOpen: (table: string, id: string) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onReload: () => void;
}) {
  const { tab, bid } = props;
  if (!bid) return <div className="skeleton" />;
  switch (tab) {
    case 'overview': return <Overview {...props} bid={bid} />;
    case 'schedule': return <Schedule {...props} bid={bid} />;
    case 'compliance': return <Compliance {...props} bid={bid} />;
    case 'outline': return <Outline {...props} bid={bid} />;
    case 'resumes': return <Resumes {...props} bid={bid} />;
    case 'reviews': return <Reviews {...props} bid={bid} />;
    case 'production': return <Production {...props} bid={bid} />;
    case 'orals': return <Orals {...props} bid={bid} />;
    case 'lessons': return <Lessons {...props} bid={bid} />;
    case 'documents': return <Documents {...props} bid={bid} />;
    case 'settings': return <Settings {...props} bid={bid} />;
    default: {
      const unreachable: never = tab;
      return unreachable;
    }
  }
}

function rowsOf<T>(data: Record<string, unknown> | null, key: string): T[] {
  const value = data?.[key];
  return Array.isArray(value) ? value as T[] : [];
}

function Overview({ bid, data, onOpen, onReload, onError }: Panel) {
  const facts = rowsOf<SourceFields & { field: string; value: string; confirmed: boolean }>(data, 'facts');
  const kickoff = rowsOf<{ id: string; label: string; done: boolean; owner: string | null; note: string | null }>(data, 'kickoff');
  return (
    <div className="stack">
      {facts.length === 0 && kickoff.length === 0 ? <p>No items found. Add a fact by hand.</p> : null}
      {activeJobsNote(facts)}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Field</th><th>Value</th><th>Source</th><th>Confirm</th></tr></thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.id} className={fact.supersedeStatus && fact.supersedeStatus !== 'active' ? 'struck' : undefined}>
                <td><button type="button" className="btn secondary" onClick={() => onOpen('bid_facts', fact.id)}>{fact.field}</button></td>
                <td>
                  {fact.supersedeStatus && fact.supersedeStatus !== 'active' ? <s>{fact.value}</s> : fact.value}
                  {fact.changedByAmendment ? <span> Superseded by Amd {fact.changedByAmendment}</span> : null}
                  {fact.supersedeStatus === 'superseded' ? <span className="tag superseded">Superseded</span> : null}
                </td>
                <td>{fact.sourcePage ? <button type="button" onClick={() => onOpen('bid_facts', fact.id)}>p. {fact.sourcePage}</button> : '—'}</td>
                <td><input aria-label={`Confirm ${fact.field}`} type="checkbox" checked={fact.confirmed} onChange={(event) => {
                  api(`/api/bids/${bid.id}/rows/bid_facts/${fact.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { confirmed: event.target.checked, value: fact.value } }) }).then(onReload).catch((err: Error) => onError(err.message));
                }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AddForm label="Add a fact" onSubmit={(body) => postRow(bid.id, 'overview', { kind: 'fact', field: body.name, value: body.extra }, onReload, onError)} />
      <h2>Kickoff</h2>
      {kickoff.length === 0 ? <p>No items found.</p> : kickoff.map((item) => (
        <label key={item.id} className="row">
          <input type="checkbox" checked={item.done} aria-label={item.label} onChange={(event) => {
            api(`/api/bids/${bid.id}/rows/kickoff_items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { done: event.target.checked } }) }).then(onReload);
          }} />
          <span>{item.label}</span>
          <input aria-label={`Owner for ${item.label}`} defaultValue={item.owner ?? ''} onBlur={(event) => {
            api(`/api/bids/${bid.id}/rows/kickoff_items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { owner: event.target.value } }) }).then(onReload);
          }} />
        </label>
      ))}
    </div>
  );
}

function activeJobsNote(facts: unknown[]): string | null {
  return facts.length > 0 ? null : null;
}

function Schedule({ bid, data, onOpen, onReload, onError }: Panel) {
  const activities = rowsOf<{ id: string; label: string; startDate: string | null; endDate: string | null; locked: boolean; owner: string | null; status: string | null; sourcePage: number | null }>(data, 'activities');
  const [mode, setMode] = useState<'calendar' | 'list'>('calendar');
  const [cursor, setCursor] = useState(() => new Date());
  const days = useMemo(() => monthDays(cursor), [cursor]);
  function move(id: string, date: string, locked: boolean) {
    if (locked) return;
    api(`/api/bids/${bid.id}/rows/schedule_activities/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { startDate: date, endDate: date } }),
    }).then(onReload).catch((err: Error) => onError(err.message));
  }
  const sheet = [['Activity', 'Start', 'End', 'Owner', 'Status', 'Locked'], ...activities.map((item) => [item.label, dayKey(item.startDate), dayKey(item.endDate), item.owner ?? '', item.status ?? '', item.locked ? 'yes' : 'no'])];
  return (
    <div className="stack">
      <div className="row no-print">
        <button className="btn secondary" type="button" onClick={() => setMode(mode === 'calendar' ? 'list' : 'calendar')}>{mode === 'calendar' ? 'Milestone list' : 'Calendar'}</button>
        <button className="btn secondary" type="button" onClick={() => api(`/api/bids/${bid.id}/tabs/schedule/seed`, { method: 'POST', body: JSON.stringify({ template: 'standard' }) }).then(onReload)}>Standard template</button>
        <button className="btn secondary" type="button" onClick={() => api(`/api/bids/${bid.id}/tabs/schedule/seed`, { method: 'POST', body: JSON.stringify({ template: 'color-reviews' }) }).then(onReload)}>Color-team template</button>
        <button className="btn secondary" type="button" onClick={() => downloadXlsx('schedule.xlsx', sheet)}>XLSX</button>
        <button className="btn secondary" type="button" onClick={() => downloadCsv('schedule.csv', sheet)}>CSV</button>
        <button className="btn secondary" type="button" onClick={() => downloadIcs('schedule.ics', activities.filter((item) => item.startDate).map((item) => ({ title: item.label, start: dayKey(item.startDate), end: dayKey(item.endDate || item.startDate) })))}>ICS</button>
        <button className="btn secondary" type="button" onClick={() => window.print()}>Print</button>
      </div>
      <AddForm label="Custom activity" onSubmit={(body) => postRow(bid.id, 'schedule', { label: body.name, startDate: body.extra || null }, onReload, onError)} />
      {activities.length === 0 ? <p>No items found. Add an activity or apply a template.</p> : null}
      {mode === 'list' ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Activity</th><th>Start</th><th>End</th><th>Lock</th></tr></thead>
            <tbody>
              {activities.map((item) => (
                <tr key={item.id}>
                  <td><button type="button" onClick={() => onOpen('schedule_activities', item.id)}>{item.label}</button>{item.locked && item.sourcePage ? ' · from the solicitation' : ''}</td>
                  <td className="num">{dayKey(item.startDate)}</td>
                  <td className="num">{dayKey(item.endDate)}</td>
                  <td><input aria-label={`Lock ${item.label}`} type="checkbox" checked={item.locked} onChange={(event) => {
                    api(`/api/bids/${bid.id}/rows/schedule_activities/${item.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { locked: event.target.checked } }) }).then(onReload);
                  }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <div className="row">
            <button className="btn secondary" type="button" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>Previous</button>
            <strong>{cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</strong>
            <button className="btn secondary" type="button" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>Next</button>
          </div>
          <div className="calendar">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name) => <div key={name} className="small muted">{name}</div>)}
            {days.map((day) => (
              <div
                key={day.key || day.label}
                className="day"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  const id = event.dataTransfer.getData('text/plain');
                  const activity = activities.find((item) => item.id === id);
                  if (activity && day.key) move(activity.id, day.key, activity.locked);
                }}
              >
                <span className="num">{day.label}{day.holiday ? ` ${day.holiday}` : ''}</span>
                {activities.filter((item) => dayKey(item.startDate) === day.key).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.locked ? 'chip locked' : 'chip'}
                    draggable={!item.locked}
                    onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
                    onClick={() => onOpen('schedule_activities', item.id)}
                  >{item.label}</button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Compliance({ bid, data, onOpen, onReload, onError }: Panel) {
  const all = rowsOf<SourceFields & { reqId: string; requirementText: string; status: string | null; owner: string | null }>(data, 'rows');
  const [section, setSection] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [owner, setOwner] = useState('');
  const [amendment, setAmendment] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [hideClosed, setHideClosed] = useState(false);
  const [checkThese, setCheckThese] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const federal = bid.bidType === 'federal';
  const rows = all.filter((row) => {
    if (section && !(row.sectionRef ?? '').toLowerCase().includes(section.toLowerCase())) return false;
    if (type && row.reqType !== type) return false;
    if (status && !(row.status ?? '').toLowerCase().includes(status.toLowerCase())) return false;
    if (owner && !(row.owner ?? '').toLowerCase().includes(owner.toLowerCase())) return false;
    if (amendment && String(row.amendmentNo ?? 0) !== amendment) return false;
    if (flagged && !(row.flags ?? []).some((flag) => flag === 'maybe_not_requirement' || flag.includes('page') || flag.includes('ocr'))) return false;
    if (hideClosed && (row.supersedeStatus === 'superseded' || row.supersedeStatus === 'withdrawn')) return false;
    if (checkThese && !(row.flags ?? []).includes('unmatched')) return false;
    return true;
  });
  const lRef = federal ? 'L ref' : 'Instruction ref';
  const mRef = federal ? 'M factor' : 'Evaluation factor';
  const sheet = [[ 'ID', 'Section', 'Requirement', 'Type', lRef, mRef, 'Response', 'Owner', 'Status', 'Amendment', 'Supersede' ], ...all.map((row) => [
    row.reqId ?? '', row.sectionRef ?? '', row.requirementText, row.reqType ?? '', row.instrRef ?? '', row.evalRef ?? '', '', row.owner ?? '', row.status ?? '', String(row.amendmentNo ?? 0), row.supersedeStatus ?? 'active',
  ])];
  return (
    <div className="stack">
      <p className="banner">Draft. Review every row before you rely on it.</p>
      <div className="row">
        <label>Section <input aria-label="Filter section" value={section} onChange={(event) => setSection(event.target.value)} /></label>
        <label>Type <input aria-label="Filter type" value={type} onChange={(event) => setType(event.target.value)} /></label>
        <label>Status <input aria-label="Filter status" value={status} onChange={(event) => setStatus(event.target.value)} /></label>
        <label>Owner <input aria-label="Filter owner" value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
        <label>Amendment <input aria-label="Filter amendment" value={amendment} onChange={(event) => setAmendment(event.target.value)} /></label>
        <label><input type="checkbox" checked={flagged} onChange={(event) => setFlagged(event.target.checked)} /> Flagged</label>
        <label><input type="checkbox" checked={hideClosed} onChange={(event) => setHideClosed(event.target.checked)} /> Hide superseded and withdrawn</label>
        <label><input type="checkbox" checked={checkThese} onChange={(event) => setCheckThese(event.target.checked)} /> Check these</label>
      </div>
      {checkThese ? <p className="small muted">Unmatched pre-scan hits appear here when a row is flagged unmatched. None are stored separately from the matrix.</p> : null}
      <div className="row no-print">
        <button className="btn secondary" type="button" onClick={() => downloadXlsx('compliance.xlsx', sheet)}>XLSX</button>
        <button className="btn secondary" type="button" onClick={() => downloadCsv('compliance.csv', sheet)}>CSV</button>
        <button className="btn secondary" type="button" disabled={picked.length < 2} onClick={() => {
          api(`/api/bids/${bid.id}/compliance/merge`, { method: 'POST', body: JSON.stringify({ ids: picked }) }).then(() => { setPicked([]); onReload(); }).catch((err: Error) => onError(err.message));
        }}>Merge selected</button>
      </div>
      <AddForm label="Add a requirement" onSubmit={(body) => postRow(bid.id, 'compliance', { requirementText: body.name, sectionRef: body.extra }, onReload, onError)} />
      {rows.length === 0 ? <p>No items found.</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              <th>ID</th><th>Section</th><th>Requirement</th><th>Type</th><th>{lRef}</th><th>{mRef}</th><th>Response</th><th>Owner</th><th>Status</th><th>Source</th><th>Amendment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const closed = row.supersedeStatus === 'superseded' || row.supersedeStatus === 'withdrawn';
              return (
                <tr key={row.id} className={closed ? 'struck' : undefined}>
                  <td><input aria-label={`Select ${row.reqId}`} type="checkbox" checked={picked.includes(row.id)} onChange={(event) => setPicked(event.target.checked ? [...picked, row.id] : picked.filter((id) => id !== row.id))} /></td>
                  <td><button type="button" onClick={() => onOpen('compliance_rows', row.id)}>{row.reqId}</button></td>
                  <td>{row.sectionRef}</td>
                  <td>
                    {closed ? <s>{row.requirementText}</s> : row.requirementText}
                    {row.supersedeStatus === 'superseded' ? <span className="tag superseded">Superseded by Amd {row.changedByAmendment ?? row.amendmentNo}</span> : null}
                    {row.supersedeStatus === 'withdrawn' ? <span className="tag withdrawn">Withdrawn by Amd {row.changedByAmendment ?? row.amendmentNo}</span> : null}
                    {!closed && row.amendmentNo ? <span className="tag added">Added by Amd {row.amendmentNo}</span> : null}
                    {row.origin === 'user' ? <span className="tag">added by user</span> : null}
                    {row.supersedeStatus === 'superseded' && row.supersededByRowId ? (
                      <button type="button" onClick={() => onOpen('compliance_rows', row.supersededByRowId!)}>Open replacement</button>
                    ) : null}
                  </td>
                  <td>{row.reqType}</td>
                  <td>{row.instrRef}</td>
                  <td>{row.evalRef}</td>
                  <td>{(row as { responseSection?: string | null }).responseSection}</td>
                  <td>{row.owner}</td>
                  <td>{row.status}</td>
                  <td>{row.sourcePage ? <button type="button" onClick={() => onOpen('compliance_rows', row.id)}>p. {row.sourcePage}</button> : '—'}</td>
                  <td className="num">{row.amendmentNo || 'Original'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Outline({ bid, data, onOpen, onReload, onError }: Panel) {
  const items = rowsOf<{ id: string; parentId: string | null; number: string | null; title: string; pageLimit: number | null; writer: string | null; status: string | null; dueDate: string | null; sourceRef: string | null }>(data, 'items');
  const volumes = items.filter((item) => !item.parentId);
  const sheet = [['Number', 'Title', 'Page limit', 'Writer', 'Status', 'Due'], ...items.map((item) => [item.number ?? '', item.title, String(item.pageLimit ?? ''), item.writer ?? '', item.status ?? '', dayKey(item.dueDate)])];
  return (
    <div className="stack">
      {volumes.map((volume) => {
        const children = items.filter((item) => item.parentId === volume.id);
        const used = children.reduce((sum, item) => sum + (item.pageLimit ?? 0), 0);
        const over = volume.pageLimit != null && used > volume.pageLimit;
        return (
          <section key={volume.id} className="card">
            <h2>{volume.number} {volume.title}</h2>
            <p className={over ? 'over num' : 'num'}>Page budget {used} of {volume.pageLimit ?? '—'}</p>
            <ul>
              {children.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => onOpen('outline_items', item.id)}>{item.number} {item.title}</button>
                  {' '}{item.writer || 'Unassigned'} · {item.status} · <span className="num">{dayKey(item.dueDate)}</span>
                  {item.sourceRef ? <button type="button" onClick={() => onOpen('outline_items', item.id)}> {item.sourceRef}</button> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {items.length === 0 ? <p>No items found. Add a section by hand.</p> : null}
      <AddForm label="Add a section" onSubmit={(body) => postRow(bid.id, 'outline', { title: body.name, number: body.extra }, onReload, onError)} />
      <div className="row">
        <button className="btn secondary" type="button" onClick={() => downloadXlsx('outline.xlsx', sheet)}>XLSX</button>
        <button className="btn secondary" type="button" onClick={() => downloadDocx('outline.docx', items.map((item) => `${item.number ?? ''} ${item.title}`))}>DOCX</button>
      </div>
    </div>
  );
}

function Resumes({ bid, data, docs, onOpen, onReload, onError }: Panel) {
  const requirements = rowsOf<{ id: string; role: string; requirement: string }>(data, 'requirements');
  const candidates = rowsOf<{ id: string; name: string; role: string; documentId: string | null }>(data, 'candidates');
  const matches = rowsOf<{ id: string; candidateId: string; requirementId: string; result: string; evidenceQuote: string | null }>(data, 'matches');
  const roles = [...new Set(requirements.map((item) => item.role))];
  const gaps = candidates.map((candidate) => ({
    candidate,
    gaps: requirements.filter((req) => req.role === candidate.role && matches.find((match) => match.candidateId === candidate.id && match.requirementId === req.id)?.result !== 'meets'),
  }));
  return (
    <div className="stack">
      <p className="small">Resumes, their text, and evidence quotes are deleted 90 days after upload. Candidate names and results stay.</p>
      <div className="row">
        <section className="card stack" style={{ flex: 1 }}>
          <h2>Requirements</h2>
          {requirements.length === 0 ? <p>No items found.</p> : requirements.map((item) => (
            <button key={item.id} type="button" onClick={() => onOpen('personnel_requirements', item.id)}>{item.role}: {item.requirement}</button>
          ))}
          <AddForm label="Add a requirement" onSubmit={(body) => postRow(bid.id, 'resumes', { role: body.extra || 'Role', requirement: body.name }, onReload, onError)} />
        </section>
        <section className="card stack" style={{ flex: 1 }}>
          <h2>Candidates</h2>
          <label className="field">Resume file
            <input type="file" aria-label="Resume file" onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              uploadFile(bid.id, file, 'resume').then(() => onReload()).catch((err: Error) => onError(err instanceof ApiError ? err.message : err.message));
            }} />
          </label>
          {candidates.map((candidate) => (
            <p key={candidate.id}>{candidate.name} · {candidate.role}{docs.find((doc) => doc.id === candidate.documentId)?.liveStatus === 'deleted' ? ' · Removed: resume deleted after 90 days' : ''}</p>
          ))}
          <AddForm label="Assign a candidate" onSubmit={(body) => postRow(bid.id, 'resumes', { kind: 'candidate', name: body.name, role: body.extra || 'Role' }, onReload, onError)} />
        </section>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Requirement</th>{candidates.map((candidate) => <th key={candidate.id}>{candidate.name}</th>)}</tr>
          </thead>
          <tbody>
            {requirements.map((req) => (
              <tr key={req.id}>
                <td>{req.requirement}</td>
                {candidates.map((candidate) => {
                  const match = matches.find((item) => item.candidateId === candidate.id && item.requirementId === req.id);
                  return <td key={candidate.id} title={match?.evidenceQuote ?? ''}>{match?.result ?? 'unknown'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Gaps</h2>
      {gaps.map(({ candidate, gaps: missing }) => (
        <p key={candidate.id}>{candidate.name}: {missing.length === 0 ? 'meets the role' : missing.map((item) => item.requirement).join('; ')}</p>
      ))}
      <p>{roles.filter((role) => !candidates.some((candidate) => candidate.role === role && gaps.find((item) => item.candidate.role === role && item.gaps.length === 0))).join(', ') || 'Every listed role has a candidate who meets it, or no roles are listed.'}</p>
      <button className="btn secondary" type="button" onClick={() => downloadXlsx('resumes.xlsx', [['Role', 'Requirement'], ...requirements.map((item) => [item.role, item.requirement])])}>XLSX</button>
    </div>
  );
}

function Reviews({ bid, data, onReload, onError, onOpen }: Panel) {
  const reviews = rowsOf<{ id: string; type: string; scheduledAt: string | null; status: string | null }>(data, 'reviews');
  const findings = rowsOf<SourceFields & { id: string; reviewId: string; kind: string; text: string; evalFactor: string | null; disposition: string | null }>(data, 'findings');
  const [type, setType] = useState('pink');
  const federal = bid.bidType === 'federal';
  return (
    <div className="stack">
      <form className="row" onSubmit={(event) => {
        event.preventDefault();
        postRow(bid.id, 'reviews', { type, scheduledAt: new Date().toISOString() }, onReload, onError);
      }}>
        <label className="field">Review type
          <select aria-label="Review type" value={type} onChange={(event) => setType(event.target.value)}>
            {['pink', 'red', 'green', 'gold', 'other'].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <button className="btn" type="submit">Create review</button>
      </form>
      <label className="field">Draft file
        <input aria-label="Draft file" type="file" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) uploadFile(bid.id, file, 'draft').then(() => onReload()).catch((err: Error) => onError(err.message));
        }} />
      </label>
      {reviews.length === 0 ? <p>No items found.</p> : reviews.map((review) => {
        const group = findings.filter((item) => item.reviewId === review.id);
        const factors = [...new Set(group.map((item) => item.evalFactor || 'General'))];
        return (
          <section key={review.id} className="card stack">
            <h2><span className={`tag ${review.type}`}>{review.type}</span> <span className="num">{dayKey(review.scheduledAt)}</span></h2>
            <AddForm label="Reviewer" onSubmit={(body) => postRow(bid.id, 'reviews', { kind: 'assignment', reviewId: review.id, reviewerName: body.name, sections: body.extra }, onReload, onError)} />
            <AddForm label="Finding" onSubmit={(body) => postRow(bid.id, 'reviews', { kind: 'finding', reviewId: review.id, text: body.name, evalFactor: body.extra, findingKind: 'comment' }, onReload, onError)} />
            {factors.map((factor) => (
              <div key={factor}>
                <h3>{federal ? 'Section M' : 'Evaluation factor'}: {factor}</h3>
                {group.filter((item) => (item.evalFactor || 'General') === factor).map((item) => (
                  <p key={item.id}>
                    <button type="button" onClick={() => onOpen('review_findings', item.id)}>{item.kind}</button> {item.text}
                    {item.sourceQuote ? <span className="quote">{item.sourceQuote} p.{item.sourcePage}</span> : null}
                    <span className="row">
                      {['accept', 'reject', 'done'].map((disposition) => (
                        <button key={disposition} className="btn secondary" type="button" onClick={() => {
                          api(`/api/bids/${bid.id}/rows/review_findings/${item.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { disposition } }) }).then(onReload);
                        }}>{disposition}</button>
                      ))}
                      {item.disposition ? <span>Disposition: {item.disposition}</span> : null}
                    </span>
                  </p>
                ))}
              </div>
            ))}
          </section>
        );
      })}
      <div className="row">
        <button className="btn secondary" type="button" onClick={() => downloadDocx('review.docx', findings.map((item) => `${item.kind}: ${item.text}`))}>DOCX</button>
        <button className="btn secondary" type="button" onClick={() => downloadXlsx('findings.xlsx', [['Kind', 'Text', 'Disposition'], ...findings.map((item) => [item.kind, item.text, item.disposition ?? ''])])}>XLSX</button>
      </div>
    </div>
  );
}

function Production({ bid, data, onOpen, onReload }: Panel) {
  const items = rowsOf<{ id: string; category: string; rule: string; done: boolean; sourcePage: number | null }>(data, 'items');
  const ready = items.length > 0 && items.every((item) => item.done);
  return (
    <div className="stack">
      <p className={ready ? 'banner' : 'banner warn'}>{ready ? 'Ready to submit' : `${items.filter((item) => item.done).length} of ${items.length} done`}</p>
      {items.length === 0 ? <p>No items found.</p> : items.map((item) => (
        <label key={item.id} className="row">
          <input type="checkbox" checked={item.done} aria-label={item.rule} onChange={(event) => {
            api(`/api/bids/${bid.id}/rows/production_items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { done: event.target.checked } }) }).then(onReload);
          }} />
          <button type="button" onClick={() => onOpen('production_items', item.id)}>{item.category}: {item.rule}</button>
          {item.sourcePage ? <span>p. {item.sourcePage}</span> : null}
        </label>
      ))}
    </div>
  );
}

function Orals({ bid, data, onOpen, onReload, onError }: Panel) {
  const items = rowsOf<{ id: string; category: string; item: string; done: boolean; sourcePage: number | null }>(data, 'items');
  return (
    <div className="stack">
      {items.length === 0 ? <p>No items found.</p> : items.map((item) => (
        <label key={item.id} className="row">
          <input type="checkbox" checked={item.done} aria-label={item.item} onChange={(event) => {
            api(`/api/bids/${bid.id}/rows/orals_items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { done: event.target.checked } }) }).then(onReload);
          }} />
          <button type="button" onClick={() => onOpen('orals_items', item.id)}>{item.category}: {item.item}</button>
        </label>
      ))}
      <AddForm label="Session topic" onSubmit={(body) => postRow(bid.id, 'orals', { category: 'Session', item: body.name }, onReload, onError)} />
    </div>
  );
}

function Lessons({ bid, data, onReload, onError }: Panel) {
  const items = rowsOf<{ id: string; question: string; answer: string; author: string | null }>(data, 'items');
  return (
    <div className="stack">
      {items.length === 0 ? <p>No items found.</p> : items.map((item) => (
        <label key={item.id} className="field">{item.question}
          <textarea defaultValue={item.answer} onBlur={(event) => {
            api(`/api/bids/${bid.id}/rows/lessons/${item.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { answer: event.target.value } }) }).then(onReload);
          }} />
        </label>
      ))}
      <AddForm label="Add a note" onSubmit={(body) => postRow(bid.id, 'lessons', { question: body.name, answer: body.extra }, onReload, onError)} />
      <button className="btn secondary" type="button" onClick={() => downloadDocx('lessons.docx', items.map((item) => `${item.question} ${item.answer}`))}>DOCX</button>
    </div>
  );
}

function Documents({ bid, plan, docs, onReload, onError, onNotice }: Panel) {
  const [kind, setKind] = useState('attachment');
  const [reason, setReason] = useState('');
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const used = docs.reduce((sum, doc) => sum + doc.sizeBytes, 0);
  const cap = capMb(plan);
  return (
    <div className="stack">
      <p className="num">{mb(used)} of {cap} MB used</p>
      <form className="row" onSubmit={(event) => {
        event.preventDefault();
        const input = (event.currentTarget.elements.namedItem('file') as HTMLInputElement);
        const file = input.files?.[0];
        if (!file) return;
        uploadFile(bid.id, file, kind).then((result) => {
          if (result.duplicate) onNotice('Already uploaded.');
          onReload();
        }).catch((err: Error) => {
          if (err instanceof ApiError && err.status === 413) onError(`This file is larger than the ${mb(Math.max(0, cap * 1024 * 1024 - used))} left.`);
          else if (err.message.toLowerCase().includes('password')) onError('Upload an unlocked copy.');
          else onError(err.message);
        });
      }}>
        <label className="field">Kind
          <select aria-label="File kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            {['solicitation', 'amendment', 'attachment', 'resume', 'draft'].map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="field">File
          <input name="file" type="file" required aria-label="File to upload" />
        </label>
        <button className="btn" type="submit">Upload</button>
      </form>
      {docs.length === 0 ? <p>No items found.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Amd</th><th>Pages</th><th>Size</th><th>Uploaded</th><th>Live until</th><th>Status</th><th>Marking</th><th /></tr></thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.fileName}</td>
                  <td>{doc.kind}</td>
                  <td className="num">{doc.amendmentNo ?? '—'}</td>
                  <td className="num">{doc.pageCount ?? (doc.pagesEstimated ? `${doc.pagesEstimated} est.` : '—')}</td>
                  <td className="num">{mb(doc.sizeBytes)}</td>
                  <td className="num">{doc.createdAt.slice(0, 10)}</td>
                  <td className="num">{doc.liveUntil?.slice(0, 10) ?? '—'}</td>
                  <td>{doc.liveStatus || doc.extractStatus || doc.scanStatus || 'processing'}</td>
                  <td>{doc.markingStatus || 'none'}</td>
                  <td className="row">
                    {doc.liveStatus === 'archived' ? <button className="btn secondary" type="button" onClick={() => api(`/api/documents/${doc.id}/restore`, { method: 'POST' }).then(() => onNotice('Restore requested')).then(onReload).catch((err: Error) => onError(err.message))}>Restore</button> : null}
                    {doc.liveStatus === 'restoring' ? <span>Restoring (a short wait)</span> : null}
                    {doc.kind === 'amendment' ? <button className="btn secondary" type="button" onClick={() => setOverrideId(doc.id)}>Override</button> : null}
                    <button className="btn danger" type="button" onClick={() => api(`/api/documents/${doc.id}`, { method: 'DELETE' }).then(onReload)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {overrideId ? (
        <Dialog title={`Override solicitation key for this amendment. ${2 - bid.keyOverridesUsed} left.`} onCancel={() => setOverrideId(null)}>
          <form className="stack" onSubmit={(event) => {
            event.preventDefault();
            api(`/api/documents/${overrideId}/key-override`, { method: 'POST', body: JSON.stringify({ reason }) })
              .then(() => { setOverrideId(null); onNotice('Override recorded.'); onReload(); })
              .catch((err: Error) => onError(err.message));
          }}>
            <label className="field">Reason
              <input required value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <button className="btn" type="submit">Override</button>
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}

function Settings({ bid, plan, onReload, onError }: Panel) {
  const [name, setName] = useState(bid.name);
  const [agency, setAgency] = useState(bid.agency ?? '');
  const [bidType, setBidType] = useState(bid.bidType);
  const [number, setNumber] = useState(bid.solicitationNumber);
  const [start, setStart] = useState(dayKey(bid.startDate));
  const [due, setDue] = useState(dayKey(bid.dueDate));
  const [time, setTime] = useState(bid.dueTime ?? '');
  const [zone, setZone] = useState(bid.timeZone ?? '');
  const [orals, setOrals] = useState(bid.oralsEnabled);
  const [keep, setKeep] = useState(dayKey(bid.retentionExtendedUntil));
  const [prompt, setPrompt] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  function save(mode?: 'shift' | 'scale' | 'keep') {
    const previous = dayKey(bid.dueDate);
    api<Bid>(`/api/bids/${bid.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name, agency, bidType, solicitationNumber: number,
        startDate: start || null, dueDate: due || null, dueTime: time, timeZone: zone,
        oralsEnabled: orals,
        retentionExtendedUntil: plan === 'free' ? undefined : (keep || null),
      }),
    }).then(() => {
      if (mode && previous && due && previous !== due) {
        return api(`/api/bids/${bid.id}/schedule/adjust`, { method: 'POST', body: JSON.stringify({ mode, previousDue: previous, nextDue: due }) });
      }
      return undefined;
    }).then(() => {
      setPrompt(null);
      onReload();
    }).catch((err: Error) => onError(err.message));
  }

  return (
    <form className="card stack" onSubmit={(event) => {
      event.preventDefault();
      if (dayKey(bid.dueDate) && due && dayKey(bid.dueDate) !== due) setPrompt(due);
      else save();
    }}>
      <label className="field">Name <input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field">Agency <input value={agency} onChange={(event) => setAgency(event.target.value)} /></label>
      <label className="field">Bid type
        <select value={bidType} onChange={(event) => setBidType(event.target.value === 'sled' ? 'sled' : 'federal')}>
          <option value="federal">Federal</option>
          <option value="sled">SLED</option>
        </select>
      </label>
      <label className="field">Solicitation number <input value={number} onChange={(event) => setNumber(event.target.value)} /></label>
      <label className="field">Start date <input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label className="field">Due date <input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>
      <label className="field">Time <input value={time} onChange={(event) => setTime(event.target.value)} /></label>
      <label className="field">Time zone <input value={zone} onChange={(event) => setZone(event.target.value)} /></label>
      <label className="row"><input type="checkbox" checked={orals} onChange={(event) => setOrals(event.target.checked)} /> Orals</label>
      {plan !== 'free' ? <label className="field">Keep files live until <input type="date" value={keep} onChange={(event) => setKeep(event.target.value)} /></label> : null}
      <button className="btn" type="submit">Save</button>
      <button className="btn danger" type="button" onClick={() => setDeleting(true)}>Delete the bid</button>
      {prompt ? (
        <Dialog title="The due date changed" onCancel={() => setPrompt(null)}>
          <p>Move unlocked schedule activities with the new date, scale them, or keep them.</p>
          <div className="row">
            <button className="btn" type="button" onClick={() => save('shift')}>Shift</button>
            <button className="btn" type="button" onClick={() => save('scale')}>Scale</button>
            <button className="btn secondary" type="button" onClick={() => save('keep')}>Keep</button>
          </div>
        </Dialog>
      ) : null}
      {deleting ? (
        <Dialog title={`Delete ${bid.name}`} onCancel={() => setDeleting(false)}>
          <p>Type the bid name to delete it and its archive copies. A consumed credit is not returned. A reserved credit is released.</p>
          <label className="field">Bid name
            <input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
          </label>
          <button className="btn danger" type="button" disabled={confirmName !== bid.name} onClick={() => {
            api(`/api/bids/${bid.id}`, { method: 'DELETE' }).then(() => { window.location.hash = '#/bids'; }).catch((err: Error) => onError(err.message));
          }}>Delete {bid.name}</button>
        </Dialog>
      ) : null}
    </form>
  );
}

type Panel = {
  bid: Bid;
  plan: string;
  docs: DocumentRow[];
  data: Record<string, unknown> | null;
  onOpen: (table: string, id: string) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onReload: () => void;
};

function postRow(bidId: string, tab: string, body: Record<string, unknown>, onReload: () => void, onError: (message: string) => void) {
  api(`/api/bids/${bidId}/tabs/${tab}/rows`, { method: 'POST', body: JSON.stringify(body) }).then(onReload).catch((err: Error) => onError(err.message));
}

function AddForm({ label, onSubmit }: { label: string; onSubmit: (body: { name: string; extra: string }) => void }) {
  const [name, setName] = useState('');
  const [extra, setExtra] = useState('');
  return (
    <form className="row" onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit({ name, extra }); setName(''); setExtra(''); }}>
      <label className="field">{label}
        <input required value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">Detail
        <input value={extra} onChange={(event) => setExtra(event.target.value)} />
      </label>
      <button className="btn secondary" type="submit">Add</button>
    </form>
  );
}

function monthDays(cursor: Date): { key: string; label: string; holiday: string }[] {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const cells: { key: string; label: string; holiday: string }[] = [];
  for (let i = 0; i < first.getDay(); i += 1) cells.push({ key: '', label: '', holiday: '' });
  const count = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= count; day += 1) {
    const date = new Date(year, month, day);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    cells.push({ key, label: String(day), holiday: holidayName(date) });
  }
  return cells;
}

function holidayName(date: Date): string {
  const month = date.getMonth();
  const day = date.getDate();
  const weekday = date.getDay();
  const nth = Math.ceil(day / 7);
  if (month === 0 && day === 1) return 'New Year';
  if (month === 0 && weekday === 1 && nth === 3) return 'MLK';
  if (month === 1 && weekday === 1 && nth === 3) return 'Presidents';
  if (month === 4 && weekday === 1 && day > 24) return 'Memorial';
  if (month === 5 && day === 19) return 'Juneteenth';
  if (month === 6 && day === 4) return 'Independence';
  if (month === 8 && weekday === 1 && nth === 1) return 'Labor';
  if (month === 9 && weekday === 1 && nth === 2) return 'Columbus';
  if (month === 10 && day === 11) return 'Veterans';
  if (month === 10 && weekday === 4 && nth === 4) return 'Thanksgiving';
  if (month === 11 && day === 25) return 'Christmas';
  return '';
}

import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, uploadFile } from '../legacy-api';
import type { Bid, OrgPayload } from '../models';
import { capMb, daysLeft } from '../models';

export function BidsHome({ onOpen }: { onOpen: (id: string) => void }) {
  const [bids, setBids] = useState<Bid[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Bid[]>('/api/bids').then(setBids).catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main className="page stack">
      <div className="row">
        <h1>Bids</h1>
        <span className="grow" />
        <a className="btn" href="#/bids/new">+ New bid</a>
      </div>
      {error ? <p className="banner bad">{error}{error.includes('organization') ? <> <a href="#/org">Create an organization</a></> : null}</p> : null}
      {bids === null ? <div className="skeleton" /> : bids.length === 0 ? <p>No bids yet.</p> : (
        <div className="card-grid">
          {bids.map((bid) => (
            <button key={bid.id} className="card stack" type="button" onClick={() => onOpen(bid.id)}>
              <strong>{bid.name}</strong>
              <span>{bid.agency || 'Agency not set'}</span>
              <span className="num">{bid.dueDate ? bid.dueDate.slice(0, 10) : 'No due date'} · {daysLeft(bid.dueDate)}</span>
              <span>{bid.status} · credit {bid.creditStatus || 'not reserved'}</span>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

export function NewBid({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [bidType, setBidType] = useState<'federal' | 'sled'>('federal');
  const [solicitationNumber, setSolicitationNumber] = useState('');
  const [org, setOrg] = useState<OrgPayload | null>(null);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    api<OrgPayload>('/api/org').then(setOrg).catch((err: Error) => setError(err.message));
  }, []);

  const plan = org?.org?.plan ?? 'free';
  const credits = org?.credits;
  const left = credits ? credits.allowed - credits.used - credits.reserved : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const bid = await api<Bid>('/api/bids', {
        method: 'POST',
        body: JSON.stringify({ name, bidType, solicitationNumber: solicitationNumber || 'PENDING' }),
      });
      if (file) {
        const result = await uploadFile(bid.id, file, 'solicitation');
        if (result.duplicate) {
          setError('Already uploaded.');
          return;
        }
      }
      onCreated(bid.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setError('This organization is out of RFP credits.');
      } else if (err instanceof ApiError && err.status === 413) {
        setError('That file is larger than the space left on this bid.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the bid');
      }
    }
  }

  return (
    <main className="page">
      <form className="card stack" onSubmit={submit} style={{ maxWidth: 560 }}>
        <h1>New bid</h1>
        <p>The first solicitation file reserves one RFP credit. Attachments, amendments, resumes, and drafts do not. This bid can hold {capMb(plan)} MB.</p>
        {left !== null ? <p className="num">Credits left this period: {left}. Resets {credits?.periodEnd?.slice(0, 10)}.</p> : <p>Credits are counted when the first solicitation is uploaded.</p>}
        <label className="field">Bid name
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">Bid type
          <select value={bidType} onChange={(event) => setBidType(event.target.value === 'sled' ? 'sled' : 'federal')}>
            <option value="federal">Federal</option>
            <option value="sled">SLED</option>
          </select>
        </label>
        <label className="field">Solicitation number
          <input value={solicitationNumber} onChange={(event) => setSolicitationNumber(event.target.value)} />
        </label>
        <label className="field">Solicitation file
          <input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
        {error ? <p className="banner bad">{error}</p> : null}
        <button className="btn" type="submit">Create bid</button>
      </form>
    </main>
  );
}

export function Organization() {
  const [org, setOrg] = useState<OrgPayload | null>(null);
  const [members, setMembers] = useState<{ userId: string; role: string }[]>([]);
  const [about, setAbout] = useState<{ provider: string; model: string; subprocessors: string[] } | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function load() {
    api<OrgPayload>('/api/org').then((payload) => {
      setOrg(payload);
      setName(payload.org?.name ?? '');
    }).catch((err: Error) => {
      if (err instanceof ApiError && err.status === 403) {
        setOrg({ org: null, credits: null, role: 'owner' });
      } else {
        setError(err.message);
      }
    });
    api<{ userId: string; role: string }[]>('/api/org/members').then(setMembers).catch(() => undefined);
    api<{ provider: string; model: string; subprocessors: string[] }>('/api/about/processing').then(setAbout).catch(() => undefined);
  }

  useEffect(load, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/org', { method: 'POST', body: JSON.stringify({ name }) });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the organization');
    }
  }

  if (org && !org.org) {
    return (
      <main className="page">
        <form className="card stack" onSubmit={create}>
          <h1>Create your organization</h1>
          <label className="field">Organization name
            <input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          {error ? <p className="banner bad">{error}</p> : null}
          <button className="btn" type="submit">Create</button>
        </form>
      </main>
    );
  }

  const credits = org?.credits;
  return (
    <main className="page stack">
      <h1>Organization</h1>
      {error ? <p className="banner bad">{error}</p> : null}
      {message ? <p className="banner">{message}</p> : null}
      <section className="card stack">
        <h2>Plan</h2>
        <p>{org?.org?.plan ?? '…'} · {org?.org?.planStatus}</p>
        <p className="num">Credits used {credits?.used ?? 0} of {credits?.allowed ?? 0}, reserved {credits?.reserved ?? 0}. Period ends {credits?.periodEnd?.slice(0, 10) ?? 'when the first file is uploaded'}.</p>
        <button className="btn" type="button" disabled title="Stripe is not connected">Billing (Stripe portal)</button>
        <p className="small muted">The billing button opens when Stripe is connected.</p>
      </section>
      <section className="card stack">
        <h2>Members</h2>
        <ul>{members.map((member) => <li key={member.userId}>{member.role} · {member.userId}</li>)}</ul>
        <form className="row" onSubmit={(event) => {
          event.preventDefault();
          api('/api/org/invites', { method: 'POST', body: JSON.stringify({ email }) })
            .then(() => setMessage('Invite logged. The link is in the server log.'))
            .catch((err: Error) => setError(err.message));
        }}>
          <label className="field">Invite work email
            <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <button className="btn" type="submit">Invite</button>
        </form>
        {org?.role === 'owner' ? members.filter((member) => member.role !== 'owner').map((member) => (
          <button key={member.userId} className="btn danger" type="button" onClick={() => {
            api(`/api/org/members/${member.userId}`, { method: 'DELETE' }).then(load).catch((err: Error) => setError(err.message));
          }}>Remove {member.userId}</button>
        )) : null}
      </section>
      <section className="card stack">
        <h2>Data and AI</h2>
        <p>Model: {about?.model}. Provider: {about?.provider}.</p>
        <p>Subprocessors: {about?.subprocessors.join(', ')}.</p>
        <a href="#/privacy">Privacy Policy</a>
      </section>
    </main>
  );
}

export function Account() {
  const [me, setMe] = useState<{ name: string | null; email: string; phone: string | null } | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ name: string | null; email: string; phone: string | null }>('/api/me').then((user) => {
      setMe(user);
      setName(user.name ?? '');
    }).catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main className="page">
      <form className="card stack" style={{ maxWidth: 480 }} onSubmit={(event) => {
        event.preventDefault();
        api('/api/me', { method: 'PATCH', body: JSON.stringify({ name, ...(password ? { password, currentPassword } : {}) }) })
          .then(() => setMessage('Saved.'))
          .catch((err: Error) => setError(err.message));
      }}>
        <h1>Account</h1>
        <p>Email {me?.email}</p>
        <p>Phone {me?.phone}</p>
        <label className="field">Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">Current password (needed to change the password)
          <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <label className="field">New password
          <input type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error ? <p className="banner bad">{error}</p> : null}
        {message ? <p className="banner">{message}</p> : null}
        <button className="btn" type="submit">Save</button>
      </form>
    </main>
  );
}

export function Privacy() {
  return (
    <main className="page card stack">
      <h1>Privacy</h1>
      <p>Proposal files are processed by the AI provider configured for this installation. The Organization screen names the model, the provider, and the subprocessors (DeepInfra, Anthropic, Telnyx, and Stripe).</p>
      <p>A published privacy-policy document is not part of this build. Email and SMS codes are written to the server log until those providers are connected.</p>
    </main>
  );
}

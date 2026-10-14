import { useState } from 'react'
import './overview.css'

type BidFact = {
  id: string
  field: string
  value: string
  sourcePage?: number
  sourceQuote?: string
  confirmed: boolean
}

type KickoffItem = {
  id: string
  label: string
  owner?: string
  done: boolean
}

export type OverviewTabProps = {
  facts: BidFact[]
  kickoff: KickoffItem[]
  countdown: { daysLeft: number; workdaysLeft: number; dueLabel: string } | null
  onEditFact?: (id: string, value: string) => void
  onConfirmFact?: (id: string, confirmed: boolean) => void
  onToggleKickoff?: (id: string, done: boolean) => void
  onSetOwner?: (id: string, owner: string) => void
  onOpenSource?: (page: number, quote: string) => void
}

const sampleFacts: BidFact[] = [
  { id: 'agency', field: 'Issuing agency', value: 'Department of Transportation', sourcePage: 1, sourceQuote: 'The Department of Transportation invites proposals...', confirmed: true },
  { id: 'solicitation', field: 'Solicitation number', value: 'DOT-24-1187', sourcePage: 1, sourceQuote: 'Solicitation No. DOT-24-1187', confirmed: true },
  { id: 'contract', field: 'Contract type', value: 'Firm-fixed-price', sourcePage: 8, sourceQuote: 'The anticipated contract type is firm-fixed-price.', confirmed: false },
  { id: 'period', field: 'Period of performance', value: 'Base year + four option years', sourcePage: 12, sourceQuote: 'The period of performance is one base year with four option years.', confirmed: false },
]

const sampleKickoff: KickoffItem[] = [
  { id: 'roles', label: 'Confirm proposal roles and responsibilities', owner: 'Amaan', done: true },
  { id: 'schedule', label: 'Agree on the proposal schedule', owner: 'Amaan', done: true },
  { id: 'owner', label: 'Assign a compliance matrix owner', owner: 'Priya', done: false },
  { id: 'pages', label: 'Set page budgets by volume', owner: 'Jordan', done: false },
  { id: 'calls', label: 'Schedule data calls with subject matter experts', owner: 'Priya', done: false },
  { id: 'reviews', label: 'Set color team review dates', owner: 'Amaan', done: false },
]

export function OverviewTab({
  facts = sampleFacts,
  kickoff = sampleKickoff,
  countdown = { daysLeft: 42, workdaysLeft: 29, dueLabel: 'November 25, 2026 at 5:00 PM ET' },
  onEditFact,
  onConfirmFact,
  onToggleKickoff,
  onSetOwner,
  onOpenSource,
}: OverviewTabProps) {
  const [editingFact, setEditingFact] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState('')
  const completed = kickoff.filter((item) => item.done).length

  function startEditing(fact: BidFact) {
    setEditingFact(fact.id)
    setDraftValue(fact.value)
  }

  function saveFact(fact: BidFact) {
    onEditFact?.(fact.id, draftValue)
    setEditingFact(null)
  }

  return (
    <section className="overview-tab" aria-labelledby="overview-title">
      <div className="overview-heading">
        <div>
          <p className="eyebrow">Bid overview</p>
          <h1 id="overview-title">DOT Highway Safety Data Platform</h1>
          <p className="lede">AI-extracted bid facts and the decisions to make before writing begins.</p>
        </div>
        {countdown ? (
          <div className="countdown" aria-label={`${countdown.daysLeft} calendar days until due date`}>
            <span className="countdown-number">{countdown.daysLeft}</span>
            <span className="countdown-label">calendar days left</span>
            <span className="countdown-workdays">{countdown.workdaysLeft} workdays · due {countdown.dueLabel}</span>
          </div>
        ) : null}
      </div>

      <div className="overview-grid">
        <section className="panel facts-panel" aria-labelledby="facts-title">
          <div className="panel-heading">
            <div><h2 id="facts-title">Bid facts</h2><p>Review what was extracted from the solicitation.</p></div>
            <span className="status-pill">{facts.filter((fact) => fact.confirmed).length}/{facts.length} confirmed</span>
          </div>
          <div className="facts-list">
            {facts.map((fact) => (
              <article className={`fact-row ${fact.confirmed ? 'is-confirmed' : 'needs-review'}`} key={fact.id}>
                <div className="fact-main">
                  <span className="fact-label">{fact.field}</span>
                  {editingFact === fact.id ? (
                    <div className="edit-fact">
                      <label className="sr-only" htmlFor={`fact-${fact.id}`}>Edit {fact.field}</label>
                      <input id={`fact-${fact.id}`} value={draftValue} onChange={(event) => setDraftValue(event.target.value)} />
                      <button className="text-button" type="button" onClick={() => saveFact(fact)}>Save</button>
                      <button className="text-button quiet" type="button" onClick={() => setEditingFact(null)}>Cancel</button>
                    </div>
                  ) : <strong>{fact.value}</strong>}
                  {fact.sourcePage && fact.sourceQuote ? (
                    <button className="source-link" type="button" onClick={() => onOpenSource?.(fact.sourcePage!, fact.sourceQuote!)}>Source · p. {fact.sourcePage}</button>
                  ) : null}
                </div>
                <div className="fact-actions">
                  <button className="text-button quiet" type="button" onClick={() => startEditing(fact)}>Edit</button>
                  <button className={`confirm-button ${fact.confirmed ? 'confirmed' : ''}`} type="button" aria-pressed={fact.confirmed} onClick={() => onConfirmFact?.(fact.id, !fact.confirmed)}>
                    <span aria-hidden="true">{fact.confirmed ? '✓' : '○'}</span> {fact.confirmed ? 'Confirmed' : 'Confirm'}
                  </button>
                </div>
              </article>
            ))}
          </div>
          <p className="panel-footnote">Every fact keeps a source page so your team can verify it before relying on it.</p>
        </section>

        <section className="panel kickoff-panel" aria-labelledby="kickoff-title">
          <div className="panel-heading">
            <div><h2 id="kickoff-title">Kickoff checklist</h2><p>Get the team ready for a clean start.</p></div>
            <span className="progress-count">{completed} of {kickoff.length}</span>
          </div>
          <div className="progress-track" aria-label={`${completed} of ${kickoff.length} kickoff items complete`}><span style={{ width: `${kickoff.length ? (completed / kickoff.length) * 100 : 0}%` }} /></div>
          <div className="checklist">
            {kickoff.map((item) => (
              <div className={`checklist-row ${item.done ? 'done' : ''}`} key={item.id}>
                <input id={`kickoff-${item.id}`} type="checkbox" checked={item.done} onChange={(event) => onToggleKickoff?.(item.id, event.target.checked)} />
                <label htmlFor={`kickoff-${item.id}`}>{item.label}</label>
                <input className="owner-input" aria-label={`Owner for ${item.label}`} value={item.owner ?? ''} onChange={(event) => onSetOwner?.(item.id, event.target.value)} />
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="review-callout" role="note">
        <div className="callout-icon" aria-hidden="true">!</div>
        <div><strong>Start with the facts that need review.</strong><p>Two extracted facts are still unconfirmed. Confirm them now, then assign the remaining kickoff items before opening the compliance matrix.</p></div>
        <button className="text-button" type="button" onClick={() => document.getElementById('facts-title')?.scrollIntoView({ behavior: 'smooth' })}>Review facts</button>
      </div>
    </section>
  )
}

export function OverviewPreview() {
  return <OverviewTab />
}

export default OverviewTab

import { ArrowUpRight, CircleCheck, Mail, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { activity, bid, needs, requests, stages, volumes } from '@/lib/sample-data'

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn('rise rounded-2xl bg-card p-5 shadow-sm', className)}>{children}</section>
}

function Ring({ value }: { value: number }) {
  const r = 52
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 120 120" className="size-36 -rotate-90" role="img" aria-label={`${value}% drafted`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="var(--muted)" strokeWidth="10" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c - (value / 100) * c}
      />
    </svg>
  )
}

export function AtriumDashboard() {
  const pct = Math.round((bid.pagesDrafted / bid.pagesTotal) * 100)
  const current = stages.find((s) => s.status === 'running')
  const received = requests.filter((r) => r.status === 'Received').length

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 pb-24 md:p-6 md:pb-24">
      <header className="rise flex flex-col gap-1 px-1 pb-2">
        <p className="text-sm text-muted-foreground">Good morning, Dana. Your proposal is moving along.</p>
        <h1 className="text-pretty text-2xl font-semibold tracking-tight md:text-3xl">{bid.title}</h1>
        <p className="text-sm text-muted-foreground">
          {bid.agency} · <span className="font-mono">{bid.number}</span>
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="flex flex-col items-center gap-3 text-center md:row-span-2">
          <h2 className="self-start text-sm font-medium text-muted-foreground">Draft progress</h2>
          <div className="relative flex items-center justify-center">
            <Ring value={pct} />
            <span className="absolute flex flex-col items-center">
              <span className="text-3xl font-semibold tabular-nums">{pct}%</span>
              <span className="text-xs text-muted-foreground">
                {bid.pagesDrafted}/{bid.pagesTotal} pages
              </span>
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Now: <span className="font-medium text-foreground">{current?.name}</span>. Red review starts when every page
            clears 90%.
          </p>
          <ul className="flex w-full flex-col gap-2 border-t border-border pt-4 text-left">
            {volumes.map((v) => (
              <li key={v.name} className="flex items-center justify-between text-sm">
                <span className="truncate">{v.name.split(' · ')[1]}</span>
                <span className="tabular-nums text-muted-foreground">
                  {v.drafted}/{v.total}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="flex flex-col justify-between gap-4 bg-primary text-primary-foreground">
          <h2 className="text-sm font-medium opacity-80">Submission due</h2>
          <div>
            <p className="text-4xl font-semibold tracking-tight">{bid.dueIn}</p>
            <p className="text-sm opacity-80">{bid.dueDate}</p>
          </div>
        </Card>

        <Card className="flex flex-col justify-between gap-4 bg-signal/25">
          <h2 className="text-sm font-medium text-signal-foreground">Q&amp;A window</h2>
          <div>
            <p className="text-4xl font-semibold tracking-tight text-signal-foreground">{bid.qaIn}</p>
            <a href="#" className="inline-flex items-center gap-1 text-sm font-medium text-signal-foreground">
              Review 7 draft questions
              <ArrowUpRight className="size-4" aria-hidden />
            </a>
          </div>
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-muted-foreground">Run budget</h2>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-semibold tabular-nums">${bid.costSpent}</span>
            <span className="text-sm text-muted-foreground">/ ${bid.costCap}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${(bid.costSpent / bid.costCap) * 100}%` }} />
          </div>
        </Card>

        <Card className="flex flex-col gap-4 md:col-span-1 xl:col-span-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Journey</h2>
            <span className="text-xs text-muted-foreground">
              {stages.filter((s) => s.status === 'done').length} of {stages.length} steps
            </span>
          </div>
          <ol className="flex flex-wrap gap-2">
            {stages.map((s) => (
              <li
                key={s.name}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium',
                  s.status === 'done' && 'bg-accent text-accent-foreground',
                  s.status === 'running' && 'bg-primary text-primary-foreground',
                  s.status === 'gate' && 'border border-dashed border-primary text-primary',
                  s.status === 'queued' && 'bg-muted text-muted-foreground',
                )}
              >
                {s.status === 'done' && <CircleCheck className="size-3.5" aria-hidden />}
                {s.name}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="flex flex-col gap-4 lg:col-span-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">We still need these</h2>
            <span className="text-xs text-muted-foreground">Drafting continues with placeholders</span>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {needs.map((n) => (
              <li key={n.id} className="flex flex-col gap-3 rounded-xl border border-border p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{n.section}</span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      n.impact === 'High' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {n.impact} impact
                  </span>
                </div>
                <p className="text-sm font-medium leading-snug">{n.text}</p>
                <button
                  type="button"
                  className="inline-flex h-9 items-center justify-center gap-2 self-start rounded-lg bg-secondary px-3 text-xs font-medium text-secondary-foreground hover:bg-accent"
                >
                  <Upload className="size-3.5" aria-hidden />
                  Add evidence
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Requests</h2>
              <span className="text-xs text-muted-foreground">
                {received} of {requests.length} back
              </span>
            </div>
            <ul className="flex flex-col gap-2">
              {requests.map((r) => (
                <li key={r.item + r.who} className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full',
                      r.status === 'Received' ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground',
                      r.status === 'Overdue' && 'bg-destructive/10 text-destructive',
                    )}
                  >
                    <Mail className="size-3.5" aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{r.who}</span>
                    <span className="truncate text-xs text-muted-foreground">{r.item}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{r.status}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Recently</h2>
            <ol className="flex flex-col gap-2">
              {activity.slice(0, 3).map((a) => (
                <li key={a.time} className="text-sm leading-relaxed">
                  <span className="text-muted-foreground">{a.time} · </span>
                  {a.text}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </main>
  )
}

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ProposalSubject, TabProposalsProps } from '@/types';
import { formatRange } from '@/schedule/format';
import { SourceLink } from '@/ui/common/SourceLink';

const INTRO: Record<TabProposalsProps['subject'], string> = {
  facts: 'An amendment changes a fact you added, confirmed, or edited. Insert the new value, or dismiss it to keep yours.',
  dates: 'An amendment changes a date you added, confirmed, or edited. Insert the new date, or dismiss it to keep yours.',
};

function subjectText(s: ProposalSubject): string {
  if (s.kind === 'fact') return `${s.label}: ${s.value}`;
  return `${s.label}, ${s.start ? formatRange(s.start, s.end) : 'No date'}`;
}

/** The changes amendments propose on a tab's user rows, each with Insert, Dismiss, and its source. */
export function TabProposals({ subject, proposals, busyIds, onInsert, onDismiss, onOpenSource }: TabProposalsProps) {
  if (proposals.length === 0) return null;
  return (
    <section aria-labelledby="tab-proposals-title" className="grid gap-3 rounded-lg border border-line bg-paper p-4 text-ink">
      <h2 id="tab-proposals-title" className="text-base font-semibold">
        Changes from amendments
      </h2>
      <p className="text-sm text-muted-foreground">{INTRO[subject]}</p>
      {proposals.map((p) => {
        const amd = p.amendmentNo ? `Amendment ${p.amendmentNo}` : 'Amendment';
        const label = p.next.label;
        const busy = busyIds.includes(p.id);
        return (
          <article key={p.id} aria-label={`${amd}: ${label}`} className="grid gap-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{subjectText(p.next)}</span>
              <Badge variant="outline">{p.amendmentNo ? `Amd ${p.amendmentNo}` : 'Amendment'}</Badge>
            </div>
            {p.replaces.map((old) => (
              <div key={old.rowId} className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">{`Replaces ${subjectText(old.subject)}`}</p>
                {old.isAi && (
                  <SourceLink
                    page={old.sourcePage}
                    pageEnd={old.sourcePageEnd}
                    rowLabel={`the replaced ${old.subject.label}`}
                    onOpen={() => onOpenSource(old.rowId)}
                  />
                )}
              </div>
            ))}
            {p.replaces.length === 0 && (
              <p className="text-sm text-muted-foreground">The row it replaced was removed. Insert adds this one.</p>
            )}
            {p.sourceQuote && (
              <blockquote className="border-l-2 border-line pl-3 text-sm text-muted-foreground">“{p.sourceQuote}”</blockquote>
            )}
            <SourceLink page={p.sourcePage} pageEnd={p.sourcePageEnd} rowLabel={label} onOpen={() => onOpenSource(p.rowId)} />
            <div className="flex gap-2">
              <Button type="button" size="sm" aria-label={`Insert ${amd}: ${label}`} disabled={busy} onClick={() => onInsert(p.id)}>
                Insert
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Dismiss ${amd}: ${label}`}
                disabled={busy}
                onClick={() => onDismiss(p.id)}
              >
                Dismiss
              </Button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

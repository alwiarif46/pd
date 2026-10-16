import { Button } from '@/components/ui/button';
import type { AmendmentDateNoticeProps } from '@/types';
import { SourceLink } from '@/ui/common/SourceLink';
import { formatDay } from './format';

/** An amendment's date change the user put off: what it does, its source, and a way back to the prompt. */
export function AmendmentDateNotice(p: AmendmentDateNoticeProps) {
  const who = p.amendmentNo ? `Amendment ${p.amendmentNo}` : 'An amendment';
  return (
    <div role="region" aria-label="Amendment date change" className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper p-3 text-sm text-ink">
      <p role="status">{`${who} moves the due date to ${formatDay(p.nextDue)}.`}</p>
      {p.sourceQuote && (
        <blockquote className="border-l-2 border-line pl-3 text-sm text-muted-foreground">“{p.sourceQuote}”</blockquote>
      )}
      <SourceLink
        page={p.sourcePage}
        pageEnd={null}
        rowLabel={p.amendmentNo ? `Amendment ${p.amendmentNo}` : 'the amendment'}
        onOpen={p.onOpenSource}
      />
      <Button type="button" size="sm" variant="outline" onClick={p.onReview}>
        Review date change
      </Button>
    </div>
  );
}

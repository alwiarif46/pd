import { isWorkday, workdayDelta } from '@pd/core/schedule';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ScheduleDateChangePromptProps } from '@/types';
import { SourceLink } from '@/ui/common/SourceLink';
import { formatDay } from './format';

/** 09 s5.11: the due date changed; shift, scale, or keep the schedule. */
export function DateChangePrompt(p: ScheduleDateChangePromptProps) {
  const rules = { workdaysOnly: true };
  const { previousDue } = p;
  // An amendment set the due date on a bid that had none: nothing to move from, so only "Keep dates" applies.
  const keepOnly = previousDue === null;
  const zero =
    previousDue !== null && p.workdaysOnly && previousDue !== p.nextDue && workdayDelta(previousDue, p.nextDue, rules) === 0;
  const offDay = previousDue !== null && !zero && p.workdaysOnly && !isWorkday(p.nextDue, rules);
  const unit = p.workdaysOnly ? 'workdays' : 'days';
  const summary = p.summary ?? {
    shift: `Moves unlocked activities by the same number of ${unit}.`,
    scale: 'Stretches or squeezes unlocked activities between the start date and the new due date.',
    keep: 'Leaves every activity where it is.',
  };
  const fromAmendment = p.origin === 'amendment';
  const who = p.amendmentNo ? `Amendment ${p.amendmentNo}` : 'The amendment';
  const title = keepOnly
    ? p.amendmentNo
      ? `Amendment ${p.amendmentNo} set the due date`
      : 'An amendment set the due date'
    : p.amendmentNo
      ? `Amendment ${p.amendmentNo} moved the due date`
      : fromAmendment
        ? 'An amendment moved the due date'
        : 'The due date changed';
  const description = keepOnly
    ? `${who} sets the due date to ${formatDay(p.nextDue)}. The bid had no due date, so the schedule dates stay as they are.`
    : `The due date moved from ${formatDay(previousDue)} to ${formatDay(p.nextDue)}. Move the schedule with it?`;
  // Esc and an outside click cancel, except while an answer is being applied.
  return (
    <Dialog open={p.open} onOpenChange={(v) => !v && !p.busy && p.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {fromAmendment && <p className="text-sm text-ink">{`Your answer sets the bid's due date to ${formatDay(p.nextDue)}.`}</p>}
        {fromAmendment && (
          <div className="grid gap-1">
            {p.sourceQuote && (
              <blockquote className="border-l-2 border-line pl-3 text-sm text-muted-foreground">“{p.sourceQuote}”</blockquote>
            )}
            <SourceLink
              page={p.sourcePage}
              pageEnd={null}
              rowLabel={p.amendmentNo ? `Amendment ${p.amendmentNo}` : 'the amendment'}
              onOpen={p.onOpenSource}
            />
          </div>
        )}
        {p.dueSaved && (
          <p role="status" className="text-sm text-ink">The new due date is saved. Choose how to move the schedule.</p>
        )}
        {zero && (
          <p className="text-sm text-warning">
            {`That is 0 workdays, because ${formatDay(p.nextDue)} is not a workday. Shifting moves no unlocked activity.`}
          </p>
        )}
        {offDay && <p className="text-sm text-warning">{`${formatDay(p.nextDue)} is not a workday.`}</p>}
        <dl className="grid gap-3 text-sm">
          {!keepOnly && (
            <div>
              <dt className="font-medium text-ink">Shift dates</dt>
              <dd className="text-muted-foreground">{summary.shift}</dd>
            </div>
          )}
          {!keepOnly && (
            <div>
              <dt className="font-medium text-ink">Scale dates</dt>
              <dd className="text-muted-foreground">{summary.scale}</dd>
            </div>
          )}
          <div>
            <dt className="font-medium text-ink">Keep dates</dt>
            <dd className="text-muted-foreground">{summary.keep}</dd>
          </div>
        </dl>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={p.busy} onClick={p.onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={zero || keepOnly ? 'default' : 'outline'}
            autoFocus={zero || keepOnly}
            disabled={p.busy}
            onClick={() => p.onChoose('keep')}
          >
            Keep dates
          </Button>
          {!keepOnly && (
            <Button type="button" variant="outline" disabled={p.busy} onClick={() => p.onChoose('scale')}>
              Scale dates
            </Button>
          )}
          {!keepOnly && (
            <Button
              type="button"
              variant={zero ? 'outline' : 'default'}
              autoFocus={!zero}
              disabled={p.busy}
              onClick={() => p.onChoose('shift')}
            >
              Shift dates
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

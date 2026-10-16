import { isWorkday, workdayDelta } from '@pd/core/schedule';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ScheduleDateChangePromptProps } from '@/types';
import { formatDay } from './format';

/** 09 s5.11: the due date changed; shift, scale, or keep the schedule. */
export function DateChangePrompt(p: ScheduleDateChangePromptProps) {
  const rules = { workdaysOnly: true };
  const zero = p.workdaysOnly && p.previousDue !== p.nextDue && workdayDelta(p.previousDue, p.nextDue, rules) === 0;
  const offDay = !zero && p.workdaysOnly && !isWorkday(p.nextDue, rules);
  const unit = p.workdaysOnly ? 'workdays' : 'days';
  const summary = p.summary ?? {
    shift: `Moves unlocked activities by the same number of ${unit}.`,
    scale: 'Stretches or squeezes unlocked activities between the start date and the new due date.',
    keep: 'Leaves every activity where it is.',
  };
  // Esc and an outside click cancel, except while an answer is being applied.
  return (
    <Dialog open={p.open} onOpenChange={(v) => !v && !p.busy && p.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{p.amendmentNo ? `Amendment ${p.amendmentNo} moved the due date` : 'The due date changed'}</DialogTitle>
          <DialogDescription>
            {`The due date moved from ${formatDay(p.previousDue)} to ${formatDay(p.nextDue)}. Move the schedule with it?`}
          </DialogDescription>
        </DialogHeader>
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
          <div>
            <dt className="font-medium text-ink">Shift dates</dt>
            <dd className="text-muted-foreground">{summary.shift}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink">Scale dates</dt>
            <dd className="text-muted-foreground">{summary.scale}</dd>
          </div>
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
            variant={zero ? 'default' : 'outline'}
            autoFocus={zero}
            disabled={p.busy}
            onClick={() => p.onChoose('keep')}
          >
            Keep dates
          </Button>
          <Button type="button" variant="outline" disabled={p.busy} onClick={() => p.onChoose('scale')}>
            Scale dates
          </Button>
          <Button
            type="button"
            variant={zero ? 'outline' : 'default'}
            autoFocus={!zero}
            disabled={p.busy}
            onClick={() => p.onChoose('shift')}
          >
            Shift dates
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

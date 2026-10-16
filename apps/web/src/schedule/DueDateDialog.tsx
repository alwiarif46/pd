import { useState } from 'react';
import { isIsoDate } from '@pd/core/schedule';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  open: boolean;
  dueDate: string | null;
  onSubmit: (nextDue: string) => void;
  onCancel: () => void;
}

function DueDateForm({ dueDate, onSubmit, onCancel }: Omit<Props, 'open'>) {
  const [value, setValue] = useState(dueDate ?? '');
  const valid = isIsoDate(value) && value !== dueDate;
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit(value);
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="new-due-date">New due date</Label>
        <Input id="new-due-date" type="date" value={value} onChange={(event) => setValue(event.target.value)} />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid}>
          Continue
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Asks for a new due date; the container decides whether the date-change prompt follows. */
export function DueDateDialog(p: Props) {
  return (
    <Dialog open={p.open} onOpenChange={(v) => !v && p.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{p.dueDate ? 'Change the due date' : 'Set the due date'}</DialogTitle>
          <DialogDescription>
            {p.dueDate ? 'You choose next how the schedule moves with it.' : 'Templates count back from the due date.'}
          </DialogDescription>
        </DialogHeader>
        {/* The content unmounts when the dialog closes, so the form starts fresh each time. */}
        <DueDateForm dueDate={p.dueDate} onSubmit={p.onSubmit} onCancel={p.onCancel} />
      </DialogContent>
    </Dialog>
  );
}

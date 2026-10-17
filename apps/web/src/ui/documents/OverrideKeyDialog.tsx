import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

export interface OverrideKeyDialogProps {
  open: boolean;
  overridesLeft: number;
  onAccept: (reason: string) => void;
  onCancel: () => void;
}
export function OverrideKeyDialog({ open, overridesLeft, onAccept, onCancel }: OverrideKeyDialogProps) {
  const [reason, setReason] = useState('');
  const submit = () => {
    if (overridesLeft > 0 && reason.trim()) {
      onAccept(reason.trim());
      setReason('');
    }
  };
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Accept this amendment anyway?</DialogTitle>
          <DialogDescription>
            Use this when the amendment leaves out the solicitation number. Your reason is logged.
          </DialogDescription>
        </DialogHeader>
        <p className="font-numeric">
          {overridesLeft === 0
            ? 'No overrides left. Start a new bid for this file.'
            : `${overridesLeft} overrides left on this bid`}
        </p>
        {overridesLeft > 0 && (
          <Textarea
            aria-label="Reason"
            placeholder="Reason for accepting this amendment"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={overridesLeft === 0 || !reason.trim()}>
            Accept amendment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

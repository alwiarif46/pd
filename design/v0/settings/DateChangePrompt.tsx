import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { DateChangePromptProps } from './types'

function formatDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day))
}

export function DateChangePrompt({ open, previousDue, nextDue, onChoose, onCancel }: DateChangePromptProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>The due date moved</DialogTitle>
          <DialogDescription>
            The due date moved from {formatDate(previousDue)} to {formatDate(nextDue)}. How should the schedule change?
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button variant="outline" className="h-auto justify-between py-3 text-left" onClick={() => onChoose('shift')}>
            <span><span className="block font-medium">Shift dates</span><span className="text-muted-foreground">Move every unlocked activity by the same number of days.</span></span>
          </Button>
          <Button variant="outline" className="h-auto justify-between py-3 text-left" onClick={() => onChoose('scale')}>
            <span><span className="block font-medium">Scale dates</span><span className="text-muted-foreground">Stretch or shrink the unlocked activities to fit the new window.</span></span>
          </Button>
          <Button variant="outline" className="h-auto justify-between py-3 text-left" onClick={() => onChoose('keep')}>
            <span><span className="block font-medium">Keep dates</span><span className="text-muted-foreground">Leave the activities where they are.</span></span>
          </Button>
        </div>
        <DialogFooter><Button variant="ghost" onClick={onCancel} autoFocus>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

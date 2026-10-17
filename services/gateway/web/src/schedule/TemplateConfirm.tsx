import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { ScheduleTemplateOption } from '@/types';
import { formatDay } from './format';

interface Props {
  open: boolean;
  template: ScheduleTemplateOption | null;
  dueDate: string | null;
  /** Unlocked activities that came from a template. */
  templateCount: number;
  /** Unlocked activities added by hand. */
  userCount: number;
  onApply: (replace: boolean) => void;
  onCancel: () => void;
}

/** Confirms a template. Replacing also removes unlocked hand-added activities, so it says so. */
export function TemplateConfirm(p: Props) {
  const name = p.template?.name ?? 'template';
  const description = p.template?.description ?? '';
  const replaces = p.templateCount > 0 || p.userCount > 0;
  const removal = [
    `Replacing removes every unlocked activity that came from a template or was added by hand: ${p.templateCount} from a template and ${p.userCount} added by hand.`,
    'Hand-added activities are removed too and cannot be restored. Lock an activity first to keep it.',
    'Locked activities and dates from the solicitation stay.',
  ];
  let title = `Apply ${name}?`;
  let body: string[];
  if (!replaces) {
    body = [`${description} Its activities count back from the due date, ${p.dueDate ? formatDay(p.dueDate) : 'not set yet'}.`];
  } else if (p.templateCount > 0) {
    title = `Replace activities with ${name}?`;
    body = ['This schedule already has template activities, so a new template replaces them.', ...removal];
  } else {
    body = [`${description} You can add the template beside your activities, or replace them.`, ...removal];
  }
  return (
    <AlertDialog open={p.open} onOpenChange={(v) => !v && p.onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2">
              {body.map((text) => (
                <p key={text}>{text}</p>
              ))}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          {!replaces && <AlertDialogAction onClick={() => p.onApply(false)}>Apply template</AlertDialogAction>}
          {replaces && p.templateCount === 0 && (
            <AlertDialogAction onClick={() => p.onApply(false)}>Add beside them</AlertDialogAction>
          )}
          {replaces && (
            <AlertDialogAction variant="destructive" onClick={() => p.onApply(true)}>
              Replace activities
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

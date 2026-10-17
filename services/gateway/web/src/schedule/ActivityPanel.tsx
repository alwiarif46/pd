import { useState } from 'react';
import type { FormEvent } from 'react';
import { countWorkdays, inferActivityKind } from '@pd/core/schedule';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import type { ActivityDraft, ActivityKind, ReviewColor, ScheduleActivity } from '@/types';
import { SourceLink } from '@/ui/common/SourceLink';
import { KIND_LABELS, ORIGIN_LABELS, REVIEW_LABELS } from './labels';

const CUSTOM = '__custom__';

interface Props {
  open: boolean;
  /** null: add a new activity. */
  activity: ScheduleActivity | null;
  activityOptions: string[];
  defaultStart: string | null;
  workdaysOnly: boolean;
  onSubmit: (draft: ActivityDraft) => void;
  onDelete: (() => void) | null;
  onOpenSource: (() => void) | null;
  onClose: () => void;
}

function initialChoice(activity: ScheduleActivity | null, options: string[]): string {
  if (activity && options.includes(activity.label)) return activity.label;
  return CUSTOM;
}

/** Add or edit one activity. The parent mounts it with a key, so the form starts from props. */
export function ActivityPanel(p: Props) {
  const a = p.activity;
  const [choice, setChoice] = useState(() => initialChoice(a, p.activityOptions));
  const [customName, setCustomName] = useState(a && !p.activityOptions.includes(a.label) ? a.label : '');
  const [kind, setKind] = useState<ActivityKind>(a?.kind ?? 'writing');
  const [reviewColor, setReviewColor] = useState<ReviewColor | null>(a?.reviewColor ?? null);
  const [start, setStart] = useState(a ? (a.start ?? '') : (p.defaultStart ?? ''));
  const [end, setEnd] = useState(a?.end ?? '');
  const [owner, setOwner] = useState(a?.owner ?? '');
  const [locked, setLocked] = useState(a?.locked ?? false);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const lockedOnOpen = a?.locked ?? false;
  const datesDisabled = lockedOnOpen && locked;
  const name = (choice === CUSTOM ? customName : choice).trim();
  const days = start && end && end >= start ? countWorkdays(start, end, { workdaysOnly: p.workdaysOnly }) : null;
  const unit = p.workdaysOnly ? (days === 1 ? 'workday' : 'workdays') : days === 1 ? 'day' : 'days';

  const chooseName = (value: string) => {
    setChoice(value);
    if (value !== CUSTOM) {
      const inferred = inferActivityKind(value);
      setKind(inferred.kind);
      setReviewColor(inferred.reviewColor);
    }
  };

  const chooseKind = (value: ActivityKind) => {
    setKind(value);
    if (value === 'review' && reviewColor === null) setReviewColor('blue');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: string[] = [];
    if (name === '') found.push('Enter an activity name.');
    if (end && !start) found.push('Set a start date first.');
    if (start && end && end < start) found.push('The end date is before the start date.');
    setErrors(found);
    if (found.length > 0) return;
    p.onSubmit({
      label: name,
      kind,
      reviewColor: kind === 'review' ? (reviewColor ?? 'blue') : null,
      start: start || null,
      end: end || null,
      owner: owner.trim() || null,
      locked,
    });
  };

  return (
    <Sheet open={p.open} onOpenChange={(v) => !v && p.onClose()}>
      <SheetContent side="right" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{a ? 'Edit activity' : 'New activity'}</SheetTitle>
          <SheetDescription>
            {a ? 'Change the dates, owner, or lock for this activity.' : 'Add an activity to the schedule.'}
          </SheetDescription>
        </SheetHeader>
        <form className="grid gap-4 px-4 pb-4" onSubmit={submit} noValidate>
          {a && (
            <div className="grid gap-2 text-sm">
              <p className="font-medium text-ink">{ORIGIN_LABELS[a.origin]}</p>
              {a.origin === 'ai' && (
                <>
                  <SourceLink
                    page={a.sourcePage}
                    pageEnd={a.sourcePageEnd}
                    rowLabel={a.label}
                    onOpen={() => p.onOpenSource?.()}
                  />
                  {a.sourceQuote && (
                    <blockquote className="whitespace-pre-wrap border-l-2 border-line pl-3 text-muted-foreground">
                      {a.sourceQuote}
                    </blockquote>
                  )}
                </>
              )}
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="activity-name">Activity</Label>
            <Select value={choice} onValueChange={chooseName}>
              <SelectTrigger id="activity-name" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {p.activityOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM}>Custom name</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {choice === CUSTOM && (
            <div className="grid gap-2">
              <Label htmlFor="activity-custom-name">Custom activity name</Label>
              <Input id="activity-custom-name" value={customName} onChange={(e) => setCustomName(e.target.value)} />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="activity-kind">Kind</Label>
            <Select value={kind} onValueChange={(v) => chooseKind(v as ActivityKind)}>
              <SelectTrigger id="activity-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABELS) as ActivityKind[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {KIND_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {kind === 'review' && (
            <div className="grid gap-2">
              <Label htmlFor="activity-review">Review color</Label>
              <Select value={reviewColor ?? 'blue'} onValueChange={(v) => setReviewColor(v as ReviewColor)}>
                <SelectTrigger id="activity-review" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(REVIEW_LABELS) as ReviewColor[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {REVIEW_LABELS[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="activity-start">Start date</Label>
              <Input
                id="activity-start"
                type="date"
                value={start}
                disabled={datesDisabled}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="activity-end">End date</Label>
              <Input
                id="activity-end"
                type="date"
                value={end}
                disabled={datesDisabled}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
          {datesDisabled && <p className="text-sm text-muted-foreground">Unlock to change the dates.</p>}
          {days !== null && <p className="font-numeric text-sm text-muted-foreground">{`${days} ${unit}`}</p>}
          <div className="grid gap-2">
            <Label htmlFor="activity-owner">Owner</Label>
            <Input id="activity-owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
          </div>
          <div className="flex items-start gap-3">
            <Switch id="activity-locked" checked={locked} onCheckedChange={setLocked} aria-describedby="activity-locked-help" />
            <div className="grid gap-1">
              <Label htmlFor="activity-locked">Lock dates</Label>
              <p id="activity-locked-help" className="text-sm text-muted-foreground">
                Locked dates do not move when the due date changes.
              </p>
            </div>
          </div>
          {errors.map((message) => (
            <p key={message} role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="submit">{a ? 'Save changes' : 'Add activity'}</Button>
            <Button type="button" variant="outline" onClick={p.onClose}>
              Cancel
            </Button>
            {a && p.onDelete && (
              <Button type="button" variant="destructive" className="ml-auto" onClick={() => setConfirmDelete(true)}>
                Delete activity
              </Button>
            )}
          </div>
        </form>
        {a && p.onDelete && (
          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{`Delete ${a.label}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {`This removes the activity from the schedule.${a.origin === 'ai' ? ' The date stays in the solicitation.' : ''}`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={p.onDelete}>
                  Delete activity
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </SheetContent>
    </Sheet>
  );
}

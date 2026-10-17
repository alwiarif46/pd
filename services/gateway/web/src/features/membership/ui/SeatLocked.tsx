import { Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MembershipLayout } from './MembershipLayout';
import type { SeatLockedProps } from './types';

export function SeatLocked({ email, message, checking, onCheckAgain, onSignOut }: SeatLockedProps) {
  return (
    <MembershipLayout title="You have no seat right now">
      <Lock className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm leading-relaxed text-ink">{message}</p>
      {email && <p className="text-sm leading-relaxed text-muted-foreground">Signed in as {email}.</p>}
      <p className="text-sm leading-relaxed text-muted-foreground">
        Your organization&apos;s plan has fewer seats than members. The owner can upgrade the plan or remove a
        member; your access returns as soon as a seat is free.
      </p>
      <div className="flex flex-col gap-3">
        <Button type="button" className="h-10 w-full" onClick={onCheckAgain} disabled={checking} aria-disabled={checking}>
          {checking && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {checking ? 'Checking...' : 'Check again'}
        </Button>
        <Button type="button" variant="outline" className="h-10 w-full" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </MembershipLayout>
  );
}

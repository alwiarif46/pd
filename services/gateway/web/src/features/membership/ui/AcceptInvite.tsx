import { useId, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { normalizeInviteCode } from '../pending-invite';
import { MembershipLayout, StatusLine } from './MembershipLayout';
import type { AcceptInviteProps } from './types';

function Busy({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel: string }) {
  return (
    <>
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {busy ? busyLabel : label}
    </>
  );
}

function NotNow({ onDismiss }: Pick<AcceptInviteProps, 'onDismiss'>) {
  return (
    <Button type="button" variant="outline" className="h-10 w-full" onClick={onDismiss}>
      Not now
    </Button>
  );
}

function EnterCode({ onSubmitCode }: Pick<AcceptInviteProps, 'onSubmitCode'>) {
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  function submit(event: FormEvent) {
    event.preventDefault();
    const code = normalizeInviteCode(value);
    if (!code) {
      setError('This does not look like an invite code. Copy the whole code from the invite email.');
      return;
    }
    setError(undefined);
    onSubmitCode(code);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Paste the invite code from your invitation email.
      </p>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor={id} className="text-sm font-medium text-ink">
          Invite code
        </Label>
        <Input
          id={id}
          name="code"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(undefined);
          }}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-10"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm leading-snug text-due">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" className="h-10 w-full">
        Continue
      </Button>
    </form>
  );
}

export function AcceptInvite(props: AcceptInviteProps) {
  const { step, submitting } = props;
  return (
    <MembershipLayout title="Join your team">
      {step.kind === 'enter_code' && <EnterCode onSubmitCode={props.onSubmitCode} />}
      {step.kind === 'signed_out' && (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Create an account or log in with the email address the invite was sent to.
          </p>
          <div className="flex flex-col gap-3">
            <Button type="button" className="h-10 w-full" onClick={props.onSignUp}>
              Create account
            </Button>
            <Button type="button" variant="outline" className="h-10 w-full" onClick={props.onLogIn}>
              Log in
            </Button>
          </div>
        </>
      )}
      {step.kind === 'ready' && (
        <>
          <p className="text-sm leading-relaxed text-ink">You are signed in as {step.email}.</p>
          <Button
            type="button"
            className="h-10 w-full"
            onClick={props.onAccept}
            disabled={submitting}
            aria-disabled={submitting}
          >
            <Busy busy={submitting} label="Join organization" busyLabel="Joining..." />
          </Button>
          <NotNow onDismiss={props.onDismiss} />
        </>
      )}
      {step.kind === 'joined' && (
        <>
          <p role="status" className="text-sm leading-relaxed text-ink">
            You joined {step.orgName}.
          </p>
          <Button type="button" className="h-10 w-full" onClick={props.onContinue}>
            Open Shaavir PD
          </Button>
        </>
      )}
      {step.kind === 'failed' && (
        <>
          <StatusLine message={step.message} />
          {(step.reason === 'seats_full' || step.reason === 'other') && (
            <Button type="button" className="h-10 w-full" onClick={props.onRetry} disabled={submitting}>
              <Busy busy={submitting} label="Try again" busyLabel="Trying..." />
            </Button>
          )}
          {step.reason === 'email_mismatch' && (
            <Button type="button" className="h-10 w-full" onClick={props.onSignOut}>
              Sign out and use another account
            </Button>
          )}
          {/* Final refusals: the code is already dropped, so this only opens the app. */}
          {(step.reason === 'invalid' ||
            step.reason === 'expired' ||
            step.reason === 'used' ||
            step.reason === 'already_in_org') && (
            <Button type="button" className="h-10 w-full" onClick={props.onContinue}>
              Open Shaavir PD
            </Button>
          )}
          {/* The code is kept for these; Not now drops it. */}
          {(step.reason === 'seats_full' || step.reason === 'email_mismatch' || step.reason === 'other') && (
            <NotNow onDismiss={props.onDismiss} />
          )}
        </>
      )}
    </MembershipLayout>
  );
}

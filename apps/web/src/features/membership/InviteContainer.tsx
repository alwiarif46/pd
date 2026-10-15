import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError } from '@/api';
import { parseAuthHash } from '@/features/auth/routes';
import { messageOf } from '@/features/shared/messages';
import { acceptAction, membershipApi, type AcceptOutcome, type MembershipApi } from './controller';
import { clearPendingInvite, isInviteCode, loadPendingInvite, savePendingInvite } from './pending-invite';
import { AcceptInvite } from './ui/AcceptInvite';
import type { InviteStep } from './ui/types';

const INVITE_HASH = '#/invite';

interface Props {
  signedIn: boolean;
  /** Test seam; defaults to the typed client. */
  api?: MembershipApi;
}

function go(hash: string) {
  window.location.hash = hash;
}

/** The code from `#/invite?token=<code>`, else the one kept from earlier in this sign-up. */
function initialCode(): string | null {
  const token = parseAuthHash(window.location.hash).token?.trim();
  if (isInviteCode(token)) return token;
  return loadPendingInvite();
}

/**
 * `#/invite`: joins the organization an invite was sent for. The code comes from the link or is pasted;
 * it is kept in storage while the person signs up or logs in, and removed from the address bar. The person
 * always clicks "Join organization": landing here never joins by itself.
 */
export function InviteContainer({ signedIn, api = membershipApi }: Props) {
  const [code, setCode] = useState<string | null>(initialCode);
  const [email, setEmail] = useState<string | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptOutcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const alive = useRef(true);

  // Keep the code from the link and take the one-time token out of the address bar.
  useEffect(() => {
    alive.current = true;
    const token = parseAuthHash(window.location.hash).token;
    if (token !== null) {
      const trimmed = token.trim();
      if (isInviteCode(trimmed)) savePendingInvite(trimmed);
      window.history.replaceState(null, '', INVITE_HASH);
    }
    return () => {
      alive.current = false;
    };
  }, []);

  // Who is signed in, so the person sees which address will join.
  useEffect(() => {
    if (!signedIn || !code) return;
    const abort = new AbortController();
    api.getMe({ signal: abort.signal }).then(
      (me) => {
        if (!abort.signal.aborted) setEmail(me.email);
      },
      (error: unknown) => {
        if (abort.signal.aborted || isAbortError(error)) return;
        setMeError(messageOf(error));
      },
    );
    return () => abort.abort();
  }, [api, signedIn, code]);

  const accept = useCallback(() => {
    if (!code) return;
    setSubmitting(true);
    void acceptAction(api, code).then((outcome) => {
      if (outcome.kind === 'joined' || !outcome.keepCode) clearPendingInvite();
      if (!alive.current) return;
      setSubmitting(false);
      setResult(outcome);
    });
  }, [api, code]);

  const signOut = useCallback(() => {
    // The pending code stays, so the right account can use it next.
    void api.logOut().finally(() => go('#/login'));
  }, [api]);

  const submitCode = useCallback((value: string) => {
    savePendingInvite(value);
    setResult(null);
    setMeError(null);
    setCode(value);
  }, []);

  const goToApp = useCallback(() => {
    clearPendingInvite();
    go('#/bids');
  }, []);

  let step: InviteStep | null;
  if (result) {
    step =
      result.kind === 'joined'
        ? { kind: 'joined', orgName: result.orgName }
        : { kind: 'failed', reason: result.reason, message: result.message };
  } else if (!code) {
    step = { kind: 'enter_code' };
  } else if (!signedIn) {
    step = { kind: 'signed_out' };
  } else if (meError) {
    step = { kind: 'failed', reason: 'other', message: meError };
  } else if (email !== null) {
    step = { kind: 'ready', email };
  } else {
    step = null;
  }

  if (!step) {
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        Loading...
      </p>
    );
  }

  return (
    <AcceptInvite
      step={step}
      submitting={submitting}
      onSubmitCode={submitCode}
      onAccept={accept}
      onSignUp={() => go('#/signup')}
      onLogIn={() => go('#/login')}
      onSignOut={signOut}
      onRetry={accept}
      onContinue={goToApp}
    />
  );
}

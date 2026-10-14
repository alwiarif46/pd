import { useCallback, useEffect, useRef, useState } from 'react';
import { LogIn } from '@/ui/auth/LogIn';
import { ResetPassword } from '@/ui/auth/ResetPassword';
import { ResetRequest } from '@/ui/auth/ResetRequest';
import { SignUp } from '@/ui/auth/SignUp';
import { Verify } from '@/ui/auth/Verify';
import type { AuthStatus } from '@/types';
import {
  authApi,
  IDLE,
  loadPending,
  logInAction,
  requestResetAction,
  resendCodeAction,
  resendEmailAction,
  setPasswordAction,
  signUpAction,
  SUBMITTING,
  verifyEmailAction,
  verifyPhoneAction,
  type AuthApi,
} from './controller';
import { authHash, parseAuthHash, type AuthView } from './routes';

interface Props {
  /** Called after a successful log in; the token is already stored. */
  onSignedIn: () => void;
  /** Test seam; defaults to the typed client. */
  api?: AuthApi;
}

function go(view: AuthView | 'privacy') {
  window.location.hash = view === 'privacy' ? '#/privacy' : authHash(view);
}

/** Removes the one-time token from the address bar without adding a history entry. */
function stripToken(view: AuthView) {
  window.history.replaceState(null, '', authHash(view));
}

/** Lets a view call an action and show its status; ignores results after unmount. */
function useAction() {
  const [status, setStatus] = useState<AuthStatus>(IDLE);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async (call: () => Promise<AuthStatus>): Promise<AuthStatus> => {
    setStatus(SUBMITTING);
    const result = await call();
    if (alive.current) setStatus(result);
    return result;
  }, []);
  return { status, setStatus, run, alive };
}

function LogInView({ api, onSignedIn }: { api: AuthApi; onSignedIn: () => void }) {
  const { status, run } = useAction();
  return (
    <LogIn
      status={status}
      onLogIn={(email, password) => {
        void run(() => logInAction(api, email, password)).then((result) => {
          if (result.state === 'done') onSignedIn();
        });
      }}
      onForgotPassword={() => go('reset')}
      onSignUp={() => go('signup')}
    />
  );
}

function SignUpView({ api }: { api: AuthApi }) {
  const { status, run } = useAction();
  return (
    <SignUp
      status={status}
      onSignUp={(values) => {
        void run(() => signUpAction(api, values)).then((result) => {
          if (result.state === 'done') go('verify');
        });
      }}
      onLogIn={() => go('login')}
      onOpenPrivacy={() => go('privacy')}
    />
  );
}

function VerifyView({ api, token }: { api: AuthApi; token: string | null }) {
  const [pending] = useState(loadPending);
  const [step, setStep] = useState<'email' | 'phone' | 'done'>(pending?.emailVerified ? 'phone' : 'email');
  const { status, setStatus, run, alive } = useAction();
  const handled = useRef<string | null>(null);

  // The email link lands here with a token. Run it once (StrictMode runs effects twice).
  useEffect(() => {
    if (!token || handled.current === token) return;
    handled.current = token;
    stripToken('verify');
    void run(() => verifyEmailAction(api, token)).then((result) => {
      if (result.state === 'done' && alive.current) setStep('phone');
    });
  }, [api, token, run, alive]);

  // Opened with no link and no sign-up in progress: nothing to verify.
  const lost = !token && !pending && step === 'email';
  useEffect(() => {
    if (lost) go('signup');
  }, [lost]);

  const email = pending?.email ?? '';
  const phone = pending?.phone ?? '';
  return (
    <Verify
      email={email}
      phone={phone}
      step={step}
      status={status}
      onSubmitCode={(code) => {
        void run(() => verifyPhoneAction(api, phone, code)).then((result) => {
          if (result.state === 'done' && alive.current) setStep('done');
        });
      }}
      onResendEmail={() => {
        void run(() => resendEmailAction(api, email));
      }}
      onResendCode={() => {
        void run(() => resendCodeAction(api));
      }}
      onLogIn={() => {
        setStatus(IDLE);
        go('login');
      }}
    />
  );
}

function ResetView({ api, token }: { api: AuthApi; token: string | null }) {
  // Hold the token in state so it can leave the address bar.
  const [resetToken] = useState(token);
  const { status, run } = useAction();
  useEffect(() => {
    if (resetToken) stripToken('reset');
  }, [resetToken]);

  if (resetToken) {
    return (
      <ResetPassword
        status={status}
        onSetPassword={(password) => {
          void run(() => setPasswordAction(api, resetToken, password));
        }}
        onLogIn={() => go('login')}
      />
    );
  }
  return (
    <ResetRequest
      status={status}
      onRequest={(email) => {
        void run(() => requestResetAction(api, email));
      }}
      onLogIn={() => go('login')}
    />
  );
}

/** Log in, sign up, verify and reset. Renders outside `.app-shell`. */
export function AuthContainer({ onSignedIn, api = authApi }: Props) {
  const [location, setLocation] = useState(() => parseAuthHash(window.location.hash));

  useEffect(() => {
    const onHash = () => setLocation(parseAuthHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // `key` resets a view's form and status when the route changes.
  const key = `${location.view}:${location.token ?? ''}`;
  switch (location.view) {
    case 'signup':
      return <SignUpView key={key} api={api} />;
    case 'verify':
      return <VerifyView key={key} api={api} token={location.token} />;
    case 'reset':
      return <ResetView key={key} api={api} token={location.token} />;
    default:
      return <LogInView key={key} api={api} onSignedIn={onSignedIn} />;
  }
}

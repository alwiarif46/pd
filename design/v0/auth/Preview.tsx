import type { ReactNode } from 'react';
import { LogIn } from './LogIn';
import { SignUp } from './SignUp';
import { Verify } from './Verify';
import { ResetRequest } from './ResetRequest';
import { ResetPassword } from './ResetPassword';
import type { AuthStatus, VerifyProps } from './types';

const SAMPLE_EMAIL = 'dana.reyes@northbridge-gov.com';
const SAMPLE_PHONE = '+15555550100';

const noop = () => {};

const STATUSES: { name: string; status: AuthStatus }[] = [
  { name: 'idle', status: { state: 'idle' } },
  { name: 'submitting', status: { state: 'submitting' } },
  { name: 'error', status: { state: 'error', message: 'That email and password do not match an account.' } },
  { name: 'done', status: { state: 'done', message: 'Check your inbox for the next step.' } },
];

const DONE_MESSAGES = {
  logIn: 'You have been logged out. Log in again to continue.',
  signUp: 'Account created. Check your email to confirm it.',
  verify: 'We sent a new code.',
  resetRequest: `If ${SAMPLE_EMAIL} has an account, we sent a reset link. It expires in 30 minutes.`,
  resetPassword: 'Your password is updated. Log in with the new password.',
};

const VERIFY_STEPS: VerifyProps['step'][] = ['email', 'phone', 'done'];

function withDoneMessage(status: AuthStatus, message: string): AuthStatus {
  return status.state === 'done' ? { state: 'done', message } : status;
}

function Frame({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section id={id} aria-label={label} className="border-b-4 border-ink">
      <div className="bg-paper px-4 py-2 font-mono text-sm text-muted-foreground">{label}</div>
      {children}
    </section>
  );
}

export function Preview() {
  const frames: { id: string; label: string; node: ReactNode }[] = [];

  for (const { name, status } of STATUSES) {
    frames.push({
      id: `login-${name}`,
      label: `LogIn · ${name}`,
      node: <LogIn status={withDoneMessage(status, DONE_MESSAGES.logIn)} onLogIn={noop} onForgotPassword={noop} onSignUp={noop} />,
    });
  }
  for (const { name, status } of STATUSES) {
    frames.push({
      id: `signup-${name}`,
      label: `SignUp · ${name}`,
      node: <SignUp status={withDoneMessage(status, DONE_MESSAGES.signUp)} onSignUp={noop} onLogIn={noop} onOpenPrivacy={noop} />,
    });
  }
  for (const step of VERIFY_STEPS) {
    for (const { name, status } of STATUSES) {
      frames.push({
        id: `verify-${step}-${name}`,
        label: `Verify · step ${step} · ${name}`,
        node: (
          <Verify
            email={SAMPLE_EMAIL}
            phone={SAMPLE_PHONE}
            step={step}
            status={withDoneMessage(status, DONE_MESSAGES.verify)}
            onSubmitCode={noop}
            onResendEmail={noop}
            onResendCode={noop}
            onLogIn={noop}
          />
        ),
      });
    }
  }
  for (const { name, status } of STATUSES) {
    frames.push({
      id: `reset-request-${name}`,
      label: `ResetRequest · ${name}`,
      node: <ResetRequest status={withDoneMessage(status, DONE_MESSAGES.resetRequest)} onRequest={noop} onLogIn={noop} />,
    });
  }
  for (const { name, status } of STATUSES) {
    frames.push({
      id: `reset-password-${name}`,
      label: `ResetPassword · ${name}`,
      node: <ResetPassword status={withDoneMessage(status, DONE_MESSAGES.resetPassword)} onSetPassword={noop} onLogIn={noop} />,
    });
  }

  return (
    <div className="bg-canvas text-ink">
      <nav aria-label="Auth previews" className="sticky top-0 z-10 border-b border-line bg-paper px-4 py-3">
        <ul className="flex gap-x-4 gap-y-1 overflow-x-auto whitespace-nowrap text-sm">
          {frames.map((f) => (
            <li key={f.id}>
              <a href={`#${f.id}`} className="text-primary underline-offset-4 hover:underline">
                {f.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {frames.map((f) => (
        <Frame key={f.id} id={f.id} label={f.label}>
          {f.node}
        </Frame>
      ))}
    </div>
  );
}

export default Preview;

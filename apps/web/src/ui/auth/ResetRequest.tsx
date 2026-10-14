import { useEffect, useId, useRef, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AuthBelowCard,
  AuthLayout,
  Field,
  StatusBanner,
  SubmitButton,
  TextButton,
  checkEmail,
  fieldAria,
  useAuthForm,
} from './AuthLayout';
import type { ResetRequestProps } from '@/types';

const CHECKS = { email: checkEmail };
const INITIAL = { email: '' };

export function ResetRequest({ status, onRequest, onLogIn }: ResetRequestProps) {
  const uid = useId();
  const emailId = `${uid}-email`;
  const emailRef = useRef<HTMLInputElement>(null);
  const { values, errors, setValue, blur, validateAll } = useAuthForm(CHECKS, INITIAL);
  const submitting = status.state === 'submitting';
  const done = status.state === 'done';

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (validateAll()) {
      emailRef.current?.focus();
      return;
    }
    onRequest(values.email.trim());
  }

  if (done) {
    return (
      <AuthLayout title="Reset your password">
        <StatusBanner status={status} />
        <Button type="button" className="h-10 w-full" onClick={onLogIn}>
          Back to log in
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset your password">
      <StatusBanner status={status} />
      <form noValidate onSubmit={handleSubmit}>
        <fieldset disabled={submitting} className="flex min-w-0 flex-col gap-5">
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
            Enter the email you use for Shaavir PD. We will send a link to choose a new password.
          </p>
          <Field id={emailId} label="Work email" error={errors.email}>
            <Input
              ref={emailRef}
              id={emailId}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              value={values.email}
              onChange={(e) => setValue('email', e.target.value)}
              onBlur={() => blur('email')}
              className="h-10"
              {...fieldAria(emailId, errors.email)}
            />
          </Field>
          <SubmitButton submitting={submitting} label="Send reset link" busyLabel="Sending reset link…" />
        </fieldset>
      </form>

      <AuthBelowCard>
        <TextButton onClick={onLogIn}>Back to log in</TextButton>
      </AuthBelowCard>
    </AuthLayout>
  );
}

import { useEffect, useId, useRef, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  AuthLayout,
  Field,
  PasswordInput,
  PasswordLengthHint,
  StatusBanner,
  SubmitButton,
  checkPassword,
  useAuthForm,
} from './AuthLayout';
import type { ResetPasswordProps } from './types';

const CHECKS = {
  password: checkPassword,
  confirm: (v: string, all: { password: string; confirm: string }) => {
    if (!v) return 'Confirm your new password.';
    if (v !== all.password) return 'Passwords do not match.';
    return undefined;
  },
};
const INITIAL = { password: '', confirm: '' };

export function ResetPassword({ status, onSetPassword, onLogIn }: ResetPasswordProps) {
  const uid = useId();
  const ids = { password: `${uid}-password`, confirm: `${uid}-confirm` };
  const refs = { password: useRef<HTMLInputElement>(null), confirm: useRef<HTMLInputElement>(null) };
  const { values, errors, setValue, blur, validateAll } = useAuthForm(CHECKS, INITIAL);
  const submitting = status.state === 'submitting';
  const done = status.state === 'done';

  useEffect(() => {
    refs.password.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const invalid = validateAll();
    if (invalid) {
      refs[invalid].current?.focus();
      return;
    }
    onSetPassword(values.password);
  }

  if (done) {
    return (
      <AuthLayout title="Choose a new password">
        <StatusBanner status={status} />
        <Button type="button" className="h-10 w-full" onClick={onLogIn}>
          Log in
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      <StatusBanner status={status} />
      <form noValidate onSubmit={handleSubmit}>
        <fieldset disabled={submitting} className="flex min-w-0 flex-col gap-5">
          <Field
            id={ids.password}
            label="New password"
            hint={<PasswordLengthHint password={values.password} />}
            error={errors.password}
          >
            <PasswordInput
              id={ids.password}
              inputRef={refs.password}
              autoComplete="new-password"
              value={values.password}
              error={errors.password}
              hasHint
              onChange={(v) => setValue('password', v)}
              onBlur={() => blur('password')}
            />
          </Field>

          <Field id={ids.confirm} label="Confirm password" error={errors.confirm}>
            <PasswordInput
              id={ids.confirm}
              inputRef={refs.confirm}
              autoComplete="new-password"
              value={values.confirm}
              error={errors.confirm}
              onChange={(v) => setValue('confirm', v)}
              onBlur={() => blur('confirm')}
            />
          </Field>

          <SubmitButton submitting={submitting} label="Set password" busyLabel="Setting password…" />
        </fieldset>
      </form>
    </AuthLayout>
  );
}

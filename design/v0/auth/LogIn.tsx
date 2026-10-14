import { useEffect, useId, useRef, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import {
  AuthBelowCard,
  AuthLayout,
  Field,
  PasswordInput,
  StatusBanner,
  SubmitButton,
  TextButton,
  checkEmail,
  checkPassword,
  fieldAria,
  useAuthForm,
} from './AuthLayout';
import type { LogInProps } from './types';

const CHECKS = { email: checkEmail, password: checkPassword };
const INITIAL = { email: '', password: '' };

export function LogIn({ status, onLogIn, onForgotPassword, onSignUp }: LogInProps) {
  const uid = useId();
  const ids = { email: `${uid}-email`, password: `${uid}-password` };
  const refs = { email: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null) };
  const { values, errors, setValue, blur, validateAll } = useAuthForm(CHECKS, INITIAL);
  const submitting = status.state === 'submitting';

  useEffect(() => {
    refs.email.current?.focus();
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
    onLogIn(values.email.trim(), values.password);
  }

  return (
    <AuthLayout title="Log in">
      <StatusBanner status={status} />
      <form noValidate onSubmit={handleSubmit}>
        <fieldset disabled={submitting} className="flex min-w-0 flex-col gap-5">
          <Field id={ids.email} label="Work email" error={errors.email}>
            <Input
              ref={refs.email}
              id={ids.email}
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
              {...fieldAria(ids.email, errors.email)}
            />
          </Field>

          <Field
            id={ids.password}
            label="Password"
            error={errors.password}
            labelAside={<TextButton onClick={onForgotPassword}>Forgot password?</TextButton>}
          >
            <PasswordInput
              id={ids.password}
              inputRef={refs.password}
              autoComplete="current-password"
              value={values.password}
              error={errors.password}
              onChange={(v) => setValue('password', v)}
              onBlur={() => blur('password')}
            />
          </Field>

          <SubmitButton submitting={submitting} label="Log in" busyLabel="Logging in…" />
        </fieldset>
      </form>

      <AuthBelowCard>
        New to Shaavir PD? <TextButton onClick={onSignUp}>Create an account</TextButton>
      </AuthBelowCard>
    </AuthLayout>
  );
}

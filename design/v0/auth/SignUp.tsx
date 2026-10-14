import { useEffect, useId, useRef, type ChangeEvent, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import {
  AuthBelowCard,
  AuthLayout,
  Field,
  PasswordInput,
  PasswordLengthHint,
  StatusBanner,
  SubmitButton,
  TextButton,
  checkEmail,
  checkPassword,
  checkPhoneDigits,
  fieldAria,
  formatPhone,
  phoneDigits,
  useAuthForm,
} from './AuthLayout';
import type { SignUpProps } from './types';

const CHECKS = {
  email: checkEmail,
  name: (v: string) => (v.trim() ? undefined : 'Enter your full name.'),
  password: checkPassword,
  phone: checkPhoneDigits,
};
const INITIAL = { email: '', name: '', password: '', phone: '' };

export function SignUp({ status, onSignUp, onLogIn, onOpenPrivacy }: SignUpProps) {
  const uid = useId();
  const ids = { email: `${uid}-email`, name: `${uid}-name`, password: `${uid}-password`, phone: `${uid}-phone` };
  const refs = {
    email: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    phone: useRef<HTMLInputElement>(null),
  };
  const { values, errors, setValue, blur, validateAll } = useAuthForm(CHECKS, INITIAL);
  const submitting = status.state === 'submitting';
  const phoneDisplay = formatPhone(values.phone);

  useEffect(() => {
    refs.email.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePhoneChange(e: ChangeEvent<HTMLInputElement>) {
    const next = phoneDigits(e.target.value);
    // Backspacing over a formatting character should still remove a digit.
    const deletedFormatting = e.target.value.length < phoneDisplay.length && next === values.phone;
    setValue('phone', deletedFormatting ? values.phone.slice(0, -1) : next);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const invalid = validateAll();
    if (invalid) {
      refs[invalid].current?.focus();
      return;
    }
    onSignUp({
      email: values.email.trim(),
      name: values.name.trim(),
      password: values.password,
      phone: `+1${values.phone}`,
    });
  }

  return (
    <AuthLayout title="Create your account">
      <StatusBanner status={status} />
      <form noValidate onSubmit={handleSubmit}>
        <fieldset disabled={submitting} className="flex min-w-0 flex-col gap-5">
          <Field id={ids.email} label="Work email" hint="Use your company email." error={errors.email}>
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
              {...fieldAria(ids.email, errors.email, true)}
            />
          </Field>

          <Field id={ids.name} label="Full name" error={errors.name}>
            <Input
              ref={refs.name}
              id={ids.name}
              name="name"
              type="text"
              autoComplete="name"
              autoCapitalize="words"
              value={values.name}
              onChange={(e) => setValue('name', e.target.value)}
              onBlur={() => blur('name')}
              className="h-10"
              {...fieldAria(ids.name, errors.name)}
            />
          </Field>

          <Field
            id={ids.password}
            label="Password"
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

          <Field
            id={ids.phone}
            label={
              <>
                Mobile phone<span className="sr-only">, US number, country code plus 1</span>
              </>
            }
            hint="US numbers only. We text a code to confirm it."
            error={errors.phone}
          >
            <div className="flex min-w-0">
              <span
                aria-hidden="true"
                className="flex h-10 shrink-0 items-center rounded-l-md border border-r-0 border-line bg-weekend px-3 font-numeric text-sm tabular-nums text-muted-foreground"
              >
                +1
              </span>
              <Input
                ref={refs.phone}
                id={ids.phone}
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                value={phoneDisplay}
                onChange={handlePhoneChange}
                onBlur={() => blur('phone')}
                className="h-10 min-w-0 rounded-l-none font-numeric tabular-nums"
                {...fieldAria(ids.phone, errors.phone, true)}
              />
            </div>
          </Field>

          <SubmitButton submitting={submitting} label="Create account" busyLabel="Creating account…" />

          <p className="text-sm leading-relaxed text-muted-foreground">
            By creating an account you agree to the <TextButton onClick={onOpenPrivacy}>Privacy Policy</TextButton>.
          </p>
        </fieldset>
      </form>

      <AuthBelowCard>
        Already have an account? <TextButton onClick={onLogIn}>Log in</TextButton>
      </AuthBelowCard>
    </AuthLayout>
  );
}

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AuthLayout,
  Field,
  StatusBanner,
  SubmitButton,
  checkCode,
  fieldAria,
  formatPhone,
  phoneDigits,
} from './AuthLayout';
import type { VerifyProps } from './types';

const RESEND_COOLDOWN_SECONDS = 30;

type StepState = 'done' | 'current' | 'upcoming';

function StepIndicator({ step }: { step: VerifyProps['step'] }) {
  const steps: { n: number; label: string; state: StepState }[] = [
    { n: 1, label: 'Email', state: step === 'email' ? 'current' : 'done' },
    { n: 2, label: 'Phone', state: step === 'email' ? 'upcoming' : step === 'phone' ? 'current' : 'done' },
  ];
  return (
    <ol aria-label="Progress" className="flex items-center gap-3">
      {steps.map((s, i) => (
        <li key={s.n} aria-current={s.state === 'current' ? 'step' : undefined} className="flex items-center gap-3">
          {i > 0 && <span aria-hidden="true" className={`h-px w-8 ${s.state === 'upcoming' ? 'bg-line' : 'bg-primary'}`} />}
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={[
                'flex size-6 items-center justify-center rounded-full border font-numeric text-xs font-semibold tabular-nums',
                s.state === 'done' && 'border-primary bg-primary text-primary-foreground',
                s.state === 'current' && 'border-primary bg-paper text-primary',
                s.state === 'upcoming' && 'border-line bg-paper text-muted-foreground',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {s.state === 'done' ? <Check className="size-3.5" /> : s.n}
            </span>
            <span className={`text-sm font-medium ${s.state === 'upcoming' ? 'text-muted-foreground' : 'text-ink'}`}>
              <span aria-hidden="true">{s.n} </span>
              {s.label}
              <span className="sr-only">
                {s.state === 'done' ? ', completed' : s.state === 'current' ? ', current step' : ', not started'}
              </span>
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Verify({ email, phone, step, status, onSubmitCode, onResendEmail, onResendCode, onLogIn }: VerifyProps) {
  const uid = useId();
  const codeId = `${uid}-code`;
  const codeRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [cooldown, setCooldown] = useState(0);
  const submitting = status.state === 'submitting';
  const phoneLabel = `+1 ${formatPhone(phoneDigits(phone))}`;

  useEffect(() => {
    if (step === 'phone') codeRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function handleCodeChange(value: string) {
    const next = value.replace(/\D/g, '').slice(0, 6);
    setCode(next);
    if (codeError) setCodeError(checkCode(next));
  }

  function handleResendCode() {
    onResendCode();
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const error = checkCode(code);
    setCodeError(error);
    if (error) {
      codeRef.current?.focus();
      return;
    }
    onSubmitCode(code);
  }

  return (
    <AuthLayout title="Confirm your email and phone">
      <StepIndicator step={step} />
      <StatusBanner status={status} />

      {step === 'email' && (
        <div className="flex flex-col gap-5">
          <p className="text-pretty text-sm leading-relaxed text-ink">
            We sent a link to <span className="break-all font-medium">{email}</span>. Open it on this device to continue.
          </p>
          <Button type="button" variant="outline" className="h-10 w-full" onClick={onResendEmail} disabled={submitting}>
            Resend email
          </Button>
        </div>
      )}

      {step === 'phone' && (
        <form noValidate onSubmit={handleSubmit}>
          <fieldset disabled={submitting} className="flex min-w-0 flex-col gap-5">
            <p className="text-pretty text-sm leading-relaxed text-ink">
              Enter the 6-digit code we sent to{' '}
              <span className="whitespace-nowrap font-numeric font-medium tabular-nums">{phoneLabel}</span>.
            </p>

            <Field id={codeId} label="SMS code" error={codeError}>
              <Input
                ref={codeRef}
                id={codeId}
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => handleCodeChange(e.target.value)}
                onBlur={() => setCodeError(code ? checkCode(code) : undefined)}
                className="h-14 text-center font-numeric text-2xl tabular-nums tracking-[0.5em] indent-[0.5em]"
                {...fieldAria(codeId, codeError)}
              />
            </Field>

            <SubmitButton submitting={submitting} label="Verify code" busyLabel="Verifying code…" />

            <Button
              type="button"
              variant="outline"
              className="h-10 w-full"
              onClick={handleResendCode}
              disabled={cooldown > 0}
            >
              {cooldown > 0 ? (
                <>
                  Resend code in <span className="font-numeric tabular-nums">{cooldown}s</span>
                </>
              ) : (
                'Resend code'
              )}
            </Button>
          </fieldset>
        </form>
      )}

      {step === 'done' && (
        <div className="flex flex-col items-center gap-5 text-center">
          <CheckCircle2 className="size-10 text-team-green" aria-hidden="true" />
          <p className="text-base font-medium text-ink">{"You're all set."}</p>
          <Button type="button" className="h-10 w-full" onClick={onLogIn}>
            Log in
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}

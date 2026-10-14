import {
  Children,
  isValidElement,
  useCallback,
  useId,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { AlertCircle, Check, Eye, EyeOff, Info, Landmark, ListChecks, Loader2, Quote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AuthLayoutProps, AuthStatus } from '@/types';

/* ------------------------------------------------------------------ */
/* Frame                                                               */
/* ------------------------------------------------------------------ */

const VALUE_LINES = [
  { icon: ListChecks, text: 'Compliance matrix from your solicitation in minutes.' },
  { icon: Quote, text: 'Every row cites its page and quote.' },
  { icon: Landmark, text: 'Federal and SLED bids.' },
];

function Wordmark() {
  return <span className="text-lg font-semibold tracking-tight">Shaavir PD</span>;
}

/** Content placed after the card (for example "New to Shaavir PD? Create an account"). */
export function AuthBelowCard({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function AuthLayout({ title, children }: AuthLayoutProps) {
  const titleId = useId();
  const inside: ReactNode[] = [];
  const below: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.type === AuthBelowCard) below.push(child);
    else inside.push(child);
  });

  return (
    <div className="flex min-h-dvh w-full min-w-0 flex-col bg-canvas font-sans text-ink lg:flex-row">
      <header className="bg-ink px-4 py-3 text-paper lg:hidden">
        <Wordmark />
      </header>

      <aside className="hidden bg-ink p-12 text-paper lg:flex lg:w-2/5 lg:flex-col lg:justify-between">
        <div className="flex flex-col gap-16">
          <Wordmark />
          <ul className="flex max-w-sm flex-col gap-6">
            {VALUE_LINES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-base leading-relaxed">
                <Icon className="mt-1 size-4 shrink-0 text-paper/70" aria-hidden="true" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-paper/60">{'© Shaavir'}</p>
      </aside>

      <main className="flex min-w-0 flex-1 justify-center px-4 py-8 lg:items-center lg:px-12">
        <div className="flex w-full min-w-0 flex-col gap-6 lg:max-w-[400px]">
          <section
            aria-labelledby={titleId}
            className="rounded-lg border border-line bg-paper p-6 shadow-sm sm:p-8"
          >
            <h1 id={titleId} className="text-pretty text-2xl font-semibold tracking-tight text-ink">
              {title}
            </h1>
            <div className="mt-6 flex flex-col gap-5">{inside}</div>
          </section>
          {below.length > 0 && (
            <div className="text-center text-sm leading-relaxed text-muted-foreground">{below}</div>
          )}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status banner                                                       */
/* ------------------------------------------------------------------ */

export function StatusBanner({ status }: { status: AuthStatus }) {
  if (status.state === 'error') {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-due/30 bg-due/5 px-3 py-2.5 text-sm leading-relaxed text-due"
      >
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{status.message}</span>
      </div>
    );
  }
  if (status.state === 'done') {
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink"
      >
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>{status.message}</span>
      </div>
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Field primitives                                                    */
/* ------------------------------------------------------------------ */

export function fieldAria(id: string, error?: string, hasHint = false) {
  const describedBy = [hasHint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return {
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
  } as const;
}

interface FieldProps {
  id: string;
  label: ReactNode;
  labelAside?: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}

export function Field({ id, label, labelAside, hint, error, children }: FieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </Label>
        {labelAside}
      </div>
      {children}
      {hint && (
        <div id={`${id}-hint`} className="text-sm leading-snug text-muted-foreground">
          {hint}
        </div>
      )}
      {error && (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-sm leading-snug text-due">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

interface PasswordInputProps {
  id: string;
  value: string;
  autoComplete: 'current-password' | 'new-password';
  error?: string;
  hasHint?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  onBlur: () => void;
}

export function PasswordInput({ id, value, autoComplete, error, hasHint, inputRef, onChange, onBlur }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        name={id}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="h-10 pr-11"
        {...fieldAria(id, error, hasHint)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        aria-controls={id}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary disabled:opacity-50"
      >
        {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

export function PasswordLengthHint({ password }: { password: string }) {
  const met = password.length >= PASSWORD_MIN;
  return (
    <span className={`inline-flex items-center gap-1.5 ${met ? 'text-team-green' : 'text-muted-foreground'}`}>
      <Check className="size-3.5" aria-hidden="true" />
      <span>12+ characters</span>
      <span className="sr-only" aria-live="polite">
        {met ? 'requirement met' : 'requirement not met'}
      </span>
    </span>
  );
}

export function SubmitButton({ submitting, label, busyLabel }: { submitting: boolean; label: string; busyLabel: string }) {
  return (
    <Button type="submit" className="h-10 w-full" disabled={submitting} aria-disabled={submitting}>
      {submitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {submitting ? busyLabel : label}
    </Button>
  );
}

export function TextButton({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="link"
      onClick={onClick}
      disabled={disabled}
      className="h-auto p-0 text-sm font-medium text-primary"
    >
      {children}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* Validation (rules from contract 5.13)                               */
/* ------------------------------------------------------------------ */

export const PASSWORD_MIN = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type FieldCheck<V> = (value: string, all: V) => string | undefined;

export function checkEmail(value: string) {
  const v = value.trim();
  if (!v) return 'Enter your work email.';
  if (!EMAIL_RE.test(v)) return 'Enter an email like name@company.com.';
  return undefined;
}

export function checkPassword(value: string) {
  if (!value) return 'Enter a password.';
  if (value.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  return undefined;
}

export function checkPhoneDigits(digits: string) {
  if (!digits) return 'Enter your mobile number.';
  if (digits.length !== 10) return 'Enter a 10-digit US number.';
  return undefined;
}

export function checkCode(code: string) {
  if (!code) return 'Enter the 6-digit code.';
  if (!/^\d{6}$/.test(code)) return 'The code is 6 digits.';
  return undefined;
}

/** Keeps up to 10 national digits; drops a leading US country code if pasted. */
export function phoneDigits(raw: string) {
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.slice(0, 10);
}

/** (555) 555-0100, built progressively as digits arrive. */
export function formatPhone(digits: string) {
  const a = digits.slice(0, 3);
  const b = digits.slice(3, 6);
  const c = digits.slice(6, 10);
  if (digits.length === 0) return '';
  if (digits.length <= 3) return `(${a}`;
  if (digits.length <= 6) return `(${a}) ${b}`;
  return `(${a}) ${b}-${c}`;
}

/* ------------------------------------------------------------------ */
/* Form state                                                          */
/* ------------------------------------------------------------------ */

export function useAuthForm<K extends string>(checks: Record<K, FieldCheck<Record<K, string>>>, initial: Record<K, string>) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({});

  const setValue = useCallback(
    (key: K, value: string) => {
      setValues((prev) => {
        const next = { ...prev, [key]: value };
        // Once a field shows an error, re-check it as the user fixes it.
        setErrors((e) => (e[key] ? { ...e, [key]: checks[key](value, next) } : e));
        return next;
      });
    },
    [checks],
  );

  const blur = useCallback(
    (key: K) => {
      setErrors((e) => ({ ...e, [key]: values[key] ? checks[key](values[key], values) : undefined }));
    },
    [checks, values],
  );

  /** Checks every field; returns the first invalid key, or null when the form is valid. */
  const validateAll = useCallback((): K | null => {
    const next: Partial<Record<K, string>> = {};
    let first: K | null = null;
    for (const key of Object.keys(checks) as K[]) {
      const error = checks[key](values[key], values);
      if (error) {
        next[key] = error;
        if (first === null) first = key;
      }
    }
    setErrors(next);
    return first;
  }, [checks, values]);

  return { values, errors, setValue, blur, validateAll };
}

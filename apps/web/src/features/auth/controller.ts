import * as api from '@/api';
import { ApiError } from '@/api';
import type { AuthStatus, SignUpValues } from '@/types';

/** The slice of the typed API client the auth container uses. Tests pass a mock. */
export interface AuthApi {
  logIn: typeof api.logIn;
  signUp: typeof api.signUp;
  verifyEmail: typeof api.verifyEmail;
  verifyPhone: typeof api.verifyPhone;
  resendEmail: typeof api.resendEmail;
  resendCode: typeof api.resendCode;
  requestPasswordReset: typeof api.requestPasswordReset;
  resetPassword: typeof api.resetPassword;
}

export const authApi: AuthApi = api;

export const IDLE: AuthStatus = { state: 'idle' };
export const SUBMITTING: AuthStatus = { state: 'submitting' };

const FALLBACK_MESSAGE = 'Something went wrong. Try again.';

/** API errors carry text meant for the user; show it as given. Anything else gets a plain line. */
export function messageOf(error: unknown): string {
  return error instanceof ApiError && error.message ? error.message : FALLBACK_MESSAGE;
}

async function attempt(run: () => Promise<unknown>, doneMessage: string): Promise<AuthStatus> {
  try {
    await run();
    return { state: 'done', message: doneMessage };
  } catch (error) {
    return { state: 'error', message: messageOf(error) };
  }
}

/* ---- The sign-up in progress, kept so the email link can land in a new tab ---- */

export const PENDING_KEY = 'pd-pending-signup';

export interface PendingSignUp {
  email: string;
  phone: string;
  /** Set once the email link is confirmed, so a refresh resumes at the SMS code. */
  emailVerified?: boolean;
  /** False once the API says the phone step is skipped (an allow-listed tester), so a refresh resumes at done. */
  phoneRequired?: boolean;
}

export function savePending(value: PendingSignUp): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    // Storage can be blocked; the verify screen then shows no address.
  }
}

export function loadPending(): PendingSignUp | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<PendingSignUp>;
    if (typeof data.email === 'string' && typeof data.phone === 'string') {
      return {
        email: data.email,
        phone: data.phone,
        emailVerified: data.emailVerified === true,
        ...(data.phoneRequired === false ? { phoneRequired: false } : {}),
      };
    }
  } catch {
    // Treat unreadable storage as empty.
  }
  return null;
}

export function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
}

/* ---- Actions: each returns the status to show. `done` means move on. ---- */

export function logInAction(deps: AuthApi, email: string, password: string): Promise<AuthStatus> {
  return attempt(() => deps.logIn(email, password), '');
}

export async function signUpAction(deps: AuthApi, values: SignUpValues): Promise<AuthStatus> {
  const status = await attempt(() => deps.signUp(values), '');
  if (status.state === 'done') {
    savePending({ email: values.email, phone: values.phone });
  }
  return status;
}

/** The verify-email outcome; on success, `phoneRequired` says whether the phone step comes next. */
export type VerifyEmailStatus = AuthStatus & { phoneRequired?: boolean };

export async function verifyEmailAction(deps: AuthApi, token: string): Promise<VerifyEmailStatus> {
  let phoneRequired = true;
  const status = await attempt(async () => {
    const result = await deps.verifyEmail(token);
    // Only an explicit false skips the step; an older API sends no flag.
    phoneRequired = result?.phoneRequired !== false;
  }, '');
  if (status.state !== 'done') {
    return status;
  }
  // Kept until the user moves on to log in, so a refresh (or a re-render without the token)
  // resumes at the right step: the code, or done when the phone step is skipped.
  const pending = loadPending();
  if (pending) {
    savePending({ ...pending, emailVerified: true, ...(phoneRequired ? {} : { phoneRequired: false }) });
  }
  if (!phoneRequired) {
    // Phone already verified, or an allow-listed tester: the sign-up is finished.
    return { state: 'done', message: 'Email confirmed. Your account is ready. Log in to continue.', phoneRequired };
  }
  return { state: 'done', message: 'Email confirmed. Enter the code we texted you.', phoneRequired };
}

export async function verifyPhoneAction(deps: AuthApi, phone: string, code: string): Promise<AuthStatus> {
  const status = await attempt(() => deps.verifyPhone(phone, code), 'Your account is ready. Log in to continue.');
  if (status.state === 'done') {
    clearPending();
  }
  return status;
}

/** The API answers 200 for every address, so the message must not say a message was sent. */
const RESEND_MESSAGE = 'If the account needs it, we sent a new message.';

export function resendEmailAction(deps: AuthApi, email: string): Promise<AuthStatus> {
  return attempt(() => deps.resendEmail(email), RESEND_MESSAGE);
}

export function resendCodeAction(deps: AuthApi, email: string): Promise<AuthStatus> {
  return attempt(() => deps.resendCode(email), RESEND_MESSAGE);
}

export function requestResetAction(deps: AuthApi, email: string): Promise<AuthStatus> {
  return attempt(
    () => deps.requestPasswordReset(email),
    'If an account exists for that email, we sent a link to reset the password.',
  );
}

export function setPasswordAction(deps: AuthApi, token: string, password: string): Promise<AuthStatus> {
  return attempt(() => deps.resetPassword(token, password), 'Your password is updated. Log in with it.');
}

// Shared UI types: docs/plans/09-ui-workflow.md sections 5.1 and 5.12.
// v0 and ui components import these from '@/types'. Do not redefine them.
// Per-screen contracts (sections 5.2 to 5.11) are added here when that screen is integrated.
import type { ReactNode } from 'react';

export type Tab =
  | 'overview' | 'schedule' | 'compliance' | 'outline' | 'resumes' | 'reviews'
  | 'production' | 'orals' | 'lessons' | 'documents' | 'settings';

export interface ProcessingState {
  stage: 'idle' | 'scanning' | 'extracting' | 'classifying' | 'extract' | 'verify' | 'map' | 'done' | 'failed';
  percent: number;
  message?: string;
  etaSeconds?: number;
}

export interface SourceLinkProps {
  page?: number;
  quote?: string;
  fileGone?: boolean;
  onOpen: (page: number, quote: string) => void;
}
// Auth screens: docs/plans/09-ui-workflow.md section 5.13.
export type AuthStatus =
  | { state: 'idle' }
  | { state: 'submitting' }
  | { state: 'error'; message: string }
  | { state: 'done'; message: string };
export interface AuthLayoutProps { title: string; children: ReactNode }
export interface LogInProps { status: AuthStatus; onLogIn: (email: string, password: string) => void; onForgotPassword: () => void; onSignUp: () => void }
export interface SignUpValues { email: string; name: string; password: string; phone: string }
export interface SignUpProps { status: AuthStatus; onSignUp: (v: SignUpValues) => void; onLogIn: () => void; onOpenPrivacy: () => void }
export interface VerifyProps {
  email: string; phone: string; step: 'email' | 'phone' | 'done'; status: AuthStatus;
  onSubmitCode: (code: string) => void; onResendEmail: () => void; onResendCode: () => void; onLogIn: () => void;
}
export interface ResetRequestProps { status: AuthStatus; onRequest: (email: string) => void; onLogIn: () => void }
export interface ResetPasswordProps { status: AuthStatus; onSetPassword: (password: string) => void; onLogIn: () => void }

/** 5.12: how a source-bearing row shows its amendment history. */
export type AmendmentMark =
  | { kind: 'original' }
  | { kind: 'added'; amendmentNo: number }
  | { kind: 'superseded'; amendmentNo: number; replacedById: string | null }
  | { kind: 'withdrawn'; amendmentNo: number };

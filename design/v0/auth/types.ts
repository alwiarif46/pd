import type React from 'react';

export type AuthStatus =
  | { state: 'idle' }
  | { state: 'submitting' }
  | { state: 'error'; message: string }
  | { state: 'done'; message: string };
export interface AuthLayoutProps { title: string; children: React.ReactNode }
export interface LogInProps { status: AuthStatus; onLogIn: (email: string, password: string) => void; onForgotPassword: () => void; onSignUp: () => void }
export interface SignUpValues { email: string; name: string; password: string; phone: string }
export interface SignUpProps { status: AuthStatus; onSignUp: (v: SignUpValues) => void; onLogIn: () => void; onOpenPrivacy: () => void }
export interface VerifyProps {
  email: string; phone: string; step: 'email' | 'phone' | 'done'; status: AuthStatus;
  onSubmitCode: (code: string) => void; onResendEmail: () => void; onResendCode: () => void; onLogIn: () => void;
}
export interface ResetRequestProps { status: AuthStatus; onRequest: (email: string) => void; onLogIn: () => void }
export interface ResetPasswordProps { status: AuthStatus; onSetPassword: (password: string) => void; onLogIn: () => void }

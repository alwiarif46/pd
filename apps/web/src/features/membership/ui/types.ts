export type InviteFailure =
  | 'invalid'
  | 'expired'
  | 'used'
  | 'email_mismatch'
  | 'already_in_org'
  | 'seats_full'
  | 'other';

export type InviteStep =
  | { kind: 'enter_code' }
  | { kind: 'signed_out' }
  | { kind: 'ready'; email: string }
  | { kind: 'joined'; orgName: string }
  | { kind: 'failed'; reason: InviteFailure; message: string };

export interface AcceptInviteProps {
  step: InviteStep;
  submitting: boolean;
  onSubmitCode(code: string): void;
  onAccept(): void;
  onSignUp(): void;
  onLogIn(): void;
  onSignOut(): void;
  onRetry(): void;
  onContinue(): void;
  /** "Not now": drop the waiting code and use the app with the account signed in. */
  onDismiss(): void;
}

export interface SeatLockedProps {
  email: string;
  message: string;
  checking: boolean;
  onCheckAgain(): void;
  onSignOut(): void;
}

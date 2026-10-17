export type AuthView = 'login' | 'signup' | 'verify' | 'reset';

export interface AuthLocation {
  view: AuthView;
  /** The `token` query value from the email link, when present. */
  token: string | null;
}

export const AUTH_VIEWS: readonly AuthView[] = ['login', 'signup', 'verify', 'reset'];

export function isAuthView(value: string | undefined): value is AuthView {
  return AUTH_VIEWS.includes(value as AuthView);
}

/** Parses `#/verify?token=abc` into a view and token. Unknown paths fall back to `login`. */
export function parseAuthHash(hash: string): AuthLocation {
  const body = hash.replace(/^#\/?/, '');
  const queryAt = body.indexOf('?');
  const path = queryAt === -1 ? body : body.slice(0, queryAt);
  const query = queryAt === -1 ? '' : body.slice(queryAt + 1);
  const head = path.split('/').filter(Boolean)[0];
  const token = new URLSearchParams(query).get('token');
  return { view: isAuthView(head) ? head : 'login', token: token ? token : null };
}

/** The hash for a view, without any token. */
export function authHash(view: AuthView): string {
  return `#/${view}`;
}

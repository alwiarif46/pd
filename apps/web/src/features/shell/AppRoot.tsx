import { useEffect, useState } from 'react';
import { isSignedIn, onUnauthorized, setToken } from '@/api';
import { Toaster } from '@/components/ui/sonner';
import { Privacy } from '@/screens/Outside';
import { AuthContainer } from '@/features/auth/AuthContainer';
import { LegacyFrame } from './LegacyFrame';
import { parseRoute } from './routes';
import { ShellContainer } from './ShellContainer';

const LOGIN_HASH = '#/login';

/**
 * The app: auth screens when signed out (and on the auth routes), the privacy page for anyone, and the
 * shell when signed in. Everything renders outside the legacy `.app-shell` except the legacy screens the
 * shell hosts in a LegacyFrame. An expired session (any 401 on a request that sent a token) signs out.
 */
export function AppRoot() {
  const [hash, setHash] = useState(() => window.location.hash);
  const [, setSignOuts] = useState(0);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(
    () =>
      onUnauthorized(() => {
        setToken(null);
        if (window.location.hash === LOGIN_HASH) setSignOuts((n) => n + 1);
        else window.location.hash = LOGIN_HASH;
      }),
    [],
  );

  const signedIn = isSignedIn();
  const route = parseRoute(hash, signedIn);
  const publicPrivacy = route.kind === 'page' && route.page === 'privacy';

  let body;
  if (route.kind === 'auth' || (!signedIn && !publicPrivacy)) {
    body = (
      <AuthContainer
        onSignedIn={() => {
          window.location.hash = '#/bids';
        }}
      />
    );
  } else if (!signedIn) {
    body = (
      <LegacyFrame>
        <Privacy />
      </LegacyFrame>
    );
  } else {
    body = <ShellContainer route={route} />;
  }

  return (
    <>
      {body}
      {/* Outside .app-shell, so the reset and the v0 tokens apply; survives route changes. */}
      <Toaster />
    </>
  );
}

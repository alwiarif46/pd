// Routes of identity in the OpenAPI file (packages/contracts/openapi/identity.yaml).
// `pnpm contracts:check` compares this list with the file. Add a route to the contract first.
// The handlers arrive in the service PRs of chat 2. Until then the list only mirrors the contract.
export const routes: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/healthz' },
  { method: 'GET', path: '/tenants' },
  { method: 'POST', path: '/tenants' },
  { method: 'PATCH', path: '/tenants' },
  { method: 'GET', path: '/members' },
  { method: 'DELETE', path: '/members/:userId' },
  { method: 'POST', path: '/invites' },
  { method: 'POST', path: '/invites/accept' },
  { method: 'GET', path: '/me' },
  { method: 'PATCH', path: '/me' },
  { method: 'GET', path: '/auth/login' },
  { method: 'GET', path: '/auth/callback' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'POST', path: '/tokens/verify' },
  { method: 'GET', path: '/.well-known/jwks.json' },
];

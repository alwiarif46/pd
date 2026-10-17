// Routes of ingest in the OpenAPI file (packages/contracts/openapi/ingest.yaml).
// `pnpm contracts:check` compares this list with the file. Add a route to the contract first.
// The handlers arrive in the service PRs of chat 2. Until then the list only mirrors the contract.
export const routes: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/healthz' },
  { method: 'POST', path: '/bids/:id/uploads' },
  { method: 'DELETE', path: '/uploads/:id' },
  { method: 'PUT', path: '/uploads/:id/chunks/:index' },
  { method: 'POST', path: '/uploads/:id/complete' },
  { method: 'GET', path: '/bids/:id/documents' },
  { method: 'GET', path: '/documents/:id/view-token' },
  { method: 'GET', path: '/documents/view/:token' },
  { method: 'GET', path: '/documents/:id/pages' },
  { method: 'GET', path: '/documents/:id/file' },
  { method: 'POST', path: '/documents/:id/restore' },
  { method: 'POST', path: '/documents/:id/confirm-marking' },
  { method: 'DELETE', path: '/documents/:id' },
  { method: 'GET', path: '/bids/:id/jobs' },
  { method: 'POST', path: '/jobs/:id/retry' },
];

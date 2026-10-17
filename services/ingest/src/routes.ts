// Routes of ingest in the OpenAPI file (packages/contracts/openapi/ingest.yaml).
// `pnpm contracts:check` compares this list with the file. Add a route to the contract first.
export const routes: ReadonlyArray<{ method: string; path: string }> = [{ method: 'GET', path: '/healthz' }];

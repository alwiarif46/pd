// Routes of drive in the OpenAPI file (packages/contracts/openapi/drive.yaml).
// `pnpm contracts:check` compares this list with the file. Add a route to the contract first.
export const routes: ReadonlyArray<{ method: string; path: string }> = [{ method: 'GET', path: '/healthz' }];

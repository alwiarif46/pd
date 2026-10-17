# @pd/testing

Shared test helpers for every service: two tenants with fixed ids, the sample RFP, `pnpm seed`, the cross-tenant helper (09 s9.4), and stub skills. The package holds no client documents. The only solicitation is the public sample RFP in `evals/fixtures/sample-rfp-77344426Q0100/`.

## The two tenants

Import them from `@pd/testing`. PD stores the tenant id as `org_id`, with the same value.

| | Tenant A | Tenant B |
|---|---|---|
| `id` | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` |
| Name | Tenant A | Tenant B |
| Admin user id | `aaaaaaaa-0000-4000-8000-000000000001` | `bbbbbbbb-0000-4000-8000-000000000001` |
| Admin email | `admin-a@example.test` | `admin-b@example.test` |
| Membership id (owner) | `aaaaaaaa-0000-4000-8000-000000000003` | `bbbbbbbb-0000-4000-8000-000000000003` |
| Bid id | `aaaaaaaa-0000-4000-8000-000000000002` | `bbbbbbbb-0000-4000-8000-000000000002` |
| Bid | DFC ISSO RFQ, `77344426Q0100`, federal, agency Development Finance Corporation (DFC) | Tenant B Sample RFQ, `TENANT-B-0001`, federal, agency General Services Administration (GSA) |
| Plan | `growth`, `active` | `growth`, `active` |

Exports: `TENANT_A`, `TENANT_B`, `TENANTS`, `FIXTURES` (`{ a, b }`), and the types `TenantFixture`, `TenantId`, `UserId`, `BidId`, `MembershipId`.

## Sample RFP (`listSampleRfpFiles()`)

Lists the 10 files of the sample RFP with `kind`, `amendmentNo`, `sizeBytes`, `sha256`, `mime`, `relPath`, `fileName`, and `absPath`. It finds the repo root by walking up to `pnpm-workspace.yaml`.

- The solicitation PDF is `solicitation`. Attachments 1 to 3 of the original package are `attachment` with no amendment number.
- `P0001` is an `amendment` with number 1. `P00002` is an `amendment` with number 2.
- Amendment 2's revised attachments 1 to 3 and the Q&A sheet (Attachment 4) are `attachment` with `amendmentNo` 2.

**Amendment-linked files in PD's schema.** PD's `documents` table has no column that ties an attachment to an amendment. Its `amendment_no` column is documented as "amendments only", and only the unique index is restricted to `kind = 'amendment'`; the CHECK allows 1 to 999 on any row. The seed therefore stores amendment 2's attachments as `kind = 'attachment'` with `amendment_no = 2` and no `amendment_no_source`. If chat 2 adds a real link, change `src/seed.ts` and this note.

`sampleDocumentId(tenantId, relPath)` gives each file a stable uuid, which the seed uses as the document id.

## `pnpm seed`

```
PD_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:54329/pd_dev pnpm seed --migrate   # from the repo root or this package
```

- Uses `PD_ADMIN_DATABASE_URL`. `TEST_DATABASE_URL` is a fallback only when that database passes the guard below on its own name.
- **Guard.** It refuses a database that does not look like a test database, before it connects. A database passes when its name does not contain `prod` and either says it is for tests (contains `_test`, `_dev`, `_local`, `_scratch`, or starts or ends with `test`, `scratch`, `local`, `dev`) or sits on a loopback host (`localhost`, `127.x.x.x`, `::1`, a socket) and is not `postgres`. Anything else needs `PD_SEED_ALLOW=<exact database name>`, which also overrides a name with `prod`. `PD_SEED_ALLOW` never widens the `TEST_DATABASE_URL` fallback. The refusal prints the host and database name, never the password. The check is on names, not on what the data is: a tunnel to a production server on `localhost` with an ordinary name passes, so check the URL.
- **Migrations only on request.** Without `--migrate` the seed never migrates. If the `organizations` table is missing it stops and says to pass `--migrate`. With `--migrate` it always runs drizzle's migrator (`packages/core/src/db/migrations`, as `services/gateway/test/global-setup.ts` does), which skips the migrations in its journal, so repeating it is harmless. The login needs to create roles then (a superuser, or an owner with CREATEROLE). `seedAll(url, log, { migrate, allow })` takes the same switches.
- Upserts, by fixed id, both organizations, both admin users (password hash `x:y`, which nobody can sign in with; email verified), owner memberships, one bid each, and for tenant A one `documents` row per sample file (`storage_path` null, every status column at its default: registered, not processed).
- Every write runs inside `withOrg(tenantId)`. As a superuser, row-level security is bypassed, but `app.org_id` is still set. The tests also run the helpers as `pd_app`.
- A row that already matches is not touched. A row that drifted is updated. It prints one line per kind of row with `created`, `updated`, or `unchanged`, then a total.
- `identity.tenants` does not exist yet (the identity migration has only the outbox). It arrives in chat 2, and the seed will move there.
- The PD password code is removed in chat 2, so the seed writes only the minimum for a user.

## `runCrossTenant` (09 s9.4)

```ts
import { runCrossTenant, TENANT_A, TENANT_B } from '@pd/testing';

it('hides tenant A from tenant B', async () => {
  const app = buildApp(/* db */);
  await runCrossTenant({
    serviceId: 'billing',
    ids: { invoice_id: invoiceOfA.id, bid_id: TENANT_A.bid.id }, // path parameter name -> tenant A's id
    idsB: { invoice_id: invoiceOfB.id, bid_id: TENANT_B.bid.id }, // needed for paths with 2 or more parameters
    headersFor: (tenant) => ({ authorization: `Bearer ${tokenFor(tenant)}` }), // A and B must differ
    inject: async (req) => {
      const res = await app.inject({ method: req.method as 'GET', url: req.url, headers: req.headers, payload: req.payload as object });
      return { statusCode: res.statusCode, body: res.body };
    },
  });
});
```

- `endpointsOf(serviceId)` reads `packages/contracts/openapi/<id>.yaml` and returns `{ method, path, params, public }`. Paths stay in `{id}` form. `PUBLIC_ENDPOINTS` (`GET /healthz`) lists the endpoints that need no credentials.
- For each non-public endpoint it sends, in this order:
  1. as tenant B with tenant A's id in every path parameter: expects 404 (`cross-tenant-leak`);
  2. with no credentials: expects 401 (`anonymous-leak`). The anonymous request is `headersFor(B)` minus the credential headers in `credentialHeaderNames` (`authorization`, `proxy-authorization`, `cookie`, `x-api-key`, `x-auth-token`, `x-test-tenant`; add more with `extraCredentialHeaders`). Every other header, such as `content-type` and `accept`, is kept, so the 401 is for the missing credentials and not for a missing media type;
  3. for a path with two or more parameters: every combination where exactly one parameter is tenant A's id and the others are tenant B's own (`idsB`), as tenant B, expects 404. This catches a handler that checks the bid and then loads the document by its id alone. `idsB` (parameter name to a resource B owns) is required for such a path; without it the endpoint fails as `missing-idsB`;
  4. the positive control: as tenant A with A's ids, expects any 2xx, or the status in `expectAsA['METHOD /path']` (a number or a list, for an endpoint that answers 202 or 204). Anything else is `broken-control`: a service that answers 404 to everyone, ids that do not exist, or a path that matches no route would otherwise pass every check above. `headersFor` must give A and B different credentials. This request is sent last, because a DELETE or a consuming POST changes A's data; pass `reset(endpoint)` to put it back before each endpoint.
- The B and anonymous bodies (and the mixed ones) must not contain any value of `ids` or any of `markers` (default: tenant A's name, A's bid name, A's admin email). A hit is `body-leak`. So a 404 body must not echo the requested id: Fastify's default not-found body does, so set a generic handler. Matching is case-insensitive.
- A path parameter with no entry in `ids` is a failure (`unmapped-param`), never a skip. A new path in an OpenAPI file therefore fails the service's test until its ids are mapped. A request that throws is a `request-error`; the other endpoints still run.
- It returns a report (`checked` with `asTenantA`, `asTenantB`, `noCredentials` and `mixed` per endpoint, `publicEndpoints`, `failures`, `summary`). With any failure it throws `CrossTenantError`, an `AggregateError` that lists every problem. The report is on `error.report`.
- `inject` is `(req: { method, url, headers, payload? }) => Promise<{ statusCode, body }>`, so Fastify's `app.inject` and a Python TestClient wrapper both fit.
- `payloadFor(endpoint)` supplies a body for endpoints that validate the body before they look the row up. Query-string parameters are not generated. If an endpoint needs one to reach the lookup, put it in the path of a wrapper in `inject`.
- `assertRlsIsolation({ pool | client, table, tenantColumn, idsA, tenantA, tenantB })` is the database-level version. First tenant A must see all of `idsA` (so ids that do not exist cannot pass by accident; `tenantA` is required). Then, as tenant B (it sets `app.tenant_id` and `app.org_id`), selecting A's ids returns 0 rows, and updating or deleting them affects 0 rows. Everything runs in a transaction that is rolled back. Connect as the app role: a superuser or BYPASSRLS role skips row-level security and fails the check.

`test/skeletons.test.ts` runs the helper against the 12 TypeScript skeletons (its `headersFor` sends `x-test-tenant: <tenant id>`, so A and B differ). Each has only `/healthz`, so the result is "no non-public endpoints; nothing to check". A service adds its entries to `IDS_BY_SERVICE` in that test in the PR that adds a route with a path parameter. The two Python skeletons (`render`, `portal`) have no TypeScript harness: their test only checks that the OpenAPI file has no non-public path. A pytest version of the helper is not written yet; the first Python PR with a non-public route adds it, and this check fails until then. The gateway is checked on its OpenAPI file only (it has `/healthz` there; its PD routes join the contract later).

## Stub skills

`skills/stub-shred`, `skills/stub-compliance-matrix`, and `skills/stub-bid-summary` stand in for the placeholder stages (CLAUDE.md rule 7). The first two declare `version: "0.0.1-stub"`. `stub-bid-summary` has no frontmatter, so the loader falls back to a content hash.

```ts
import { withStubSkills } from '@pd/testing';
import { loadSkill } from '@pd/stage-interface';

await withStubSkills(() => { loadSkill('stub-shred'); });   // sets PD_SKILLS_DIR, restores it after
const restore = withStubSkills();                           // or restore by hand, for example in afterEach
```

Calls to `withStubSkills(fn)` must not overlap: it sets one process-wide environment variable and each call restores the value it saw, so two calls running at once (for example from `Promise.all`) can leave the stub path set. Await one before starting the next, or use the restore function in `afterEach`.

`STUB_SKILLS_DIR` and `STUB_SKILL_NAMES` are exported. `@pd/stage-interface` keeps its own fixtures for its own tests.

## Tests

`pnpm --filter @pd/testing test`. The database tests need `TEST_DATABASE_URL` (a superuser on a throwaway cluster). Each file makes a scratch database, migrates and seeds it (`--migrate`), and drops it. They create `pd_app` and `pd_system` through PD's migration and drop them afterward, holding Postgres advisory lock 7450902 so runs on one cluster do not overlap (the gateway API tests and service-kit use the same key).

Whether the row-level security tests can log in as `pd_app` is decided once, in `test/global-setup.ts` (`test/guard.ts` holds the table), before any file runs:

| `pd_app` on the cluster | `TEST_PD_APP_PASSWORD` | Result |
|---|---|---|
| absent | any | runs; the tests create and drop the role |
| present | set | runs as that role |
| present | unset, `CI` not `true` | the RLS tests are skipped with `it.skipIf`, so they show as skipped, with a warning |
| present | unset, `CI=true` | the run fails |

Without `TEST_DATABASE_URL` the database tests skip, and under `CI=true` they fail.

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
PD_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:54329/pd_dev pnpm seed
```

- Uses `PD_ADMIN_DATABASE_URL`, else `TEST_DATABASE_URL`. Point it at a database you mean to fill: the URL names one database, and `postgres` is the maintenance database on a stock cluster.
- If the `organizations` table is missing, it applies PD's migrations first (`packages/core/src/db/migrations`, with drizzle's migrator, as `services/gateway/test/global-setup.ts` does). The login needs to create roles then (a superuser, or an owner with CREATEROLE).
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
    headersFor: (tenant) => ({ authorization: `Bearer ${tokenFor(tenant)}` }),
    inject: async (req) => {
      const res = await app.inject({ method: req.method as 'GET', url: req.url, headers: req.headers, payload: req.payload as object });
      return { statusCode: res.statusCode, body: res.body };
    },
  });
});
```

- `endpointsOf(serviceId)` reads `packages/contracts/openapi/<id>.yaml` and returns `{ method, path, params, public }`. Paths stay in `{id}` form. `PUBLIC_ENDPOINTS` (`GET /healthz`) lists the endpoints that need no credentials.
- For each non-public endpoint it sends the request as tenant B with tenant A's id in every path parameter, and expects 404. It sends the same request with no credentials and expects 401.
- A path parameter with no entry in `ids` is a failure (`unmapped-param`), never a skip. A new path in an OpenAPI file therefore fails the service's test until its ids are mapped.
- It returns a report (`checked`, `publicEndpoints`, `failures`, `summary`). With any failure it throws `CrossTenantError`, an `AggregateError` that lists every endpoint that leaked (`cross-tenant-leak`, `anonymous-leak`) or lacked a mapping. The report is on `error.report`.
- `inject` is `(req: { method, url, headers, payload? }) => Promise<{ statusCode, body }>`, so Fastify's `app.inject` and a Python TestClient wrapper both fit.
- `payloadFor(endpoint)` supplies a body for endpoints that validate the body before they look the row up. Query-string parameters are not generated. If an endpoint needs one to reach the lookup, put it in the path of a wrapper in `inject`.
- `assertRlsIsolation({ pool | client, table, tenantColumn, idsA, tenantB, tenantA? })` is the database-level version. As tenant B (it sets `app.tenant_id` and `app.org_id`), selecting A's ids returns 0 rows, and updating or deleting them affects 0 rows. Everything runs in a transaction that is rolled back. Connect as the app role: a superuser or BYPASSRLS role skips row-level security and fails the check. Pass `tenantA` so ids that do not exist cannot pass the check by accident.

`test/skeletons.test.ts` runs the helper against the 12 TypeScript skeletons. Each has only `/healthz`, so the result is "no non-public endpoints; nothing to check". A service adds its entries to `IDS_BY_SERVICE` in that test in the PR that adds a route with a path parameter. The two Python skeletons (`render`, `portal`) have no TypeScript harness: their test only checks that the OpenAPI file has no non-public path. A pytest version of the helper is not written yet; the first Python PR with a non-public route adds it, and this check fails until then. The gateway is checked on its OpenAPI file only (it has `/healthz` there; its PD routes join the contract later).

## Stub skills

`skills/stub-shred`, `skills/stub-compliance-matrix`, and `skills/stub-bid-summary` stand in for the placeholder stages (CLAUDE.md rule 7). The first two declare `version: "0.0.1-stub"`. `stub-bid-summary` has no frontmatter, so the loader falls back to a content hash.

```ts
import { withStubSkills } from '@pd/testing';
import { loadSkill } from '@pd/stage-interface';

await withStubSkills(() => { loadSkill('stub-shred'); });   // sets PD_SKILLS_DIR, restores it after
const restore = withStubSkills();                           // or restore by hand, for example in afterEach
```

`STUB_SKILLS_DIR` and `STUB_SKILL_NAMES` are exported. `@pd/stage-interface` keeps its own fixtures for its own tests.

## Tests

`pnpm --filter @pd/testing test`. The database tests need `TEST_DATABASE_URL` (a superuser on a throwaway cluster). Each file makes a scratch database, seeds it, and drops it. They create `pd_app` and `pd_system` through PD's migration and drop them afterward. If `pd_app` already exists on the cluster, set `TEST_PD_APP_PASSWORD` to its password, or the row-level security tests skip. Without `TEST_DATABASE_URL` the database tests skip, and under `CI=true` they fail.

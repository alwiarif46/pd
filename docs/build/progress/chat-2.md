# Chat 2 progress

Plan: `docs/build/chat-2.md`. Brief stood in for the missing `handoffs/chat-1.md`. Chat 4 (render, fonts, format lock) runs in parallel in another thread with owner approval; this chat does not touch it.

## Session log
- 2026-10-17 session 1: started. Read BUILD-PLAN, chat-2, chat 1 progress and review, questions, 09 s2/s4/s6/s7. Native Postgres 16 started on 54329 (`useradd pgrun`, initdb, see chat-1 notes). `pnpm install --frozen-lockfile` ok. An architect pass mapped PD tables, routes and jobs to services (summary under "Decomposition").

## Decomposition (from the architect pass, 17 Oct 2026)
- Tables: identity gets organizations (as tenants), users (mirror), memberships, invites. Ingest gets documents, upload_sessions, pages, archive_objects, jobs, exports. Intel gets bids, bid facts, compliance rows and the other tab tables, amendments, amendment_links, check_these, kickoff_items. Sessions, auth_tokens, phone_codes and `pd_system` are deleted. Billing tables (rfp_credits, stripe_events) go to the billing schema through a bridge (below).
- Every cross-service foreign key becomes a plain uuid. Cascades become events (`intel.bid.deleted`, `ingest.document.deleted`).
- Routes: auth routes die with Zitadel; org/members/invites go to identity; uploads, documents, jobs retry go to ingest; bids, tabs, schedule, amendments, check-these go to intel; the gateway proxies and composes `GET /api/org` and `/bids/:id/jobs`.
- Worker: scan, file, marking, classify to ingest; AI, key check, amendment jobs to intel.

## PR list
Order follows the brief: contracts, then tenancy, then identity; ingest, intel and web run alongside after tenancy. One service per PR, about 15 files or fewer. "F" means fable-reviewer.

| # | Branch | What | Reviewer | Status | Next step |
|---|---|---|---|---|---|
| 0 | e2e/c2-00-plan | This file, questions.md Chat 2 entries | reviewer | merged (#65, merged by the owner) | |
| 0b | e2e/c2-00b-identity-plan | Identity design from the architect pass (`chat-2-identity-plan.md`); the identity PR split 3a-t, 3a to 3f, 4a replaces 3a to 3d above | reviewer | in review | |
| 1 | e2e/c2-01-contracts | OpenAPI for identity, gateway, ingest, intel; new events (`intel.bid.deleted`, `ingest.document.deleted`, audit events); version bumps | reviewer | in review (#68) | review round 1 running; add identity gaps from the identity plan |
| 2 | e2e/c2-02-tenancy (#66, 02b #67) | `withOrg` sets both settings; `*_svc` roles accepted by the role check; RLS template per schema; outbox relay role (BYPASSRLS, SELECT and UPDATE published_at only) with proving tests; LISTEN/NOTIFY prefixes; written exception in CLAUDE.md rule 4; Dockerfile ports and HEALTHCHECK | F | in review: fable round 1 no majors, minors fixed | CI, then ask owner |
| 2b | e2e/c2-02b-testing-helpers | Cross-tenant helper follow-ups from PR 10 (packages/testing) | F | planned | |
| 3a | e2e/c2-03a-zitadel | Zitadel pinned in stack (already), identity migration 0002, mock OIDC issuer fixes | F | planned | |
| 3b | e2e/c2-03b-identity-tenants | Identity: tenants, members, seats, org_map, copy script | F | planned | |
| 3c | e2e/c2-03c-identity-invites | Identity: invites, roles, `identity.*` events | F | planned | |
| 3d | e2e/c2-03d-identity-oidc | Identity: `/auth/*` OIDC code flow, management API, Zitadel org per tenant, user mirror, `/tokens/verify`, JWKS | F | planned | |
| 4 | e2e/c2-04-gateway | Gateway: route table and proxy, token check, rate limits, chunked upload pass-through; flag true when routes are in openapi/gateway.yaml | F (security) | planned | |
| 5 | e2e/c2-05-signin-cleanup | Delete PD password, phone code, sessions in gateway and core; test helpers use mock OIDC tokens | F | planned | |
| 6a | e2e/c2-06a-ingest-schema | Ingest migration, RLS, copy script | F | planned | |
| 6b | e2e/c2-06b-ingest-uploads | Uploads, credit bridge client | F (upload paths) | planned | |
| 6c | e2e/c2-06c-ingest-documents | Documents, retention, restore | reviewer | planned | |
| 6d | e2e/c2-06d-ingest-pipeline | Scan, sandbox convert, extract, OCR, marking, classify, chunk; queue; events | F (sandbox) | planned | |
| 7a | e2e/c2-07a-intel-schema | Intel migration (tables, parked tables, jobs), RLS, copy script | F | planned | |
| 7b | e2e/c2-07b-intel-bids | Bids routes, delete events | reviewer | planned | |
| 7c | e2e/c2-07c-intel-tabs | Tabs, schedule, check-these | reviewer | planned | |
| 7d | e2e/c2-07d-intel-ai | AI jobs, credit gate client, classified-event consumer, skills through stage interface | F (money) | planned | |
| 7e | e2e/c2-07e-intel-amendments | Key check, amendment number, apply, tabs, backfill | reviewer | planned | |
| 8 | e2e/c2-08-* | Web: sign-in screens, bids list, new bid, nine tab features with states tests and fidelity screenshots (several PRs, gateway/web only) | reviewer | planned | |
| 9 | e2e/c2-09-crosstenant | Cross-tenant suite over every new endpoint | F | planned | |
| 10 | e2e/c2-10-cleanup | Drop moved public tables, delete services/worker | F | planned | |
| B1 | e2e/c2-b1-billing-bridge | Billing: internal `/credits/*` over `billing.proposal_credits` (port of PD credits.ts) | F (money) | planned, needs owner nod | |

Billing is not in chat 2's list; B1 is the smallest bridge that keeps PD's credit gate working once ingest and intel own separate schemas (see Decisions).

## Done-when status
| Check | Status |
|---|---|
| Passkey sign-in and Google SSO through Zitadel | not started. SSO round trip will be "unverified: waits on Google and Microsoft OAuth test apps" (mock OIDC and CI Zitadel only) |
| PD password and session code gone; no service stores a password | not started |
| Upload to checked compliance matrix through the gateway | not started |
| PD tests pass inside ingest and intel | not started |
| User A gets 404 on every endpoint with B's ids | not started |
| Proposed: every tab passes Playwright states test and matches design | not started |

## Decisions
Mirror of `questions.md`, Chat 2.

## Stubs
- Mock OIDC issuer (`packages/testing/src/doubles/oidc.ts`) stands in for Zitadel in the session. Waits on: Docker daemon (CI runs the real Zitadel) and the owner's Google and Microsoft OAuth test apps. Blocks: the SSO check.
- Credit bridge `unmetered` adapter for tests and dev. Waits on: billing chat.

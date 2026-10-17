# Chat 2: Identity, gateway, PD services and tabs

**Builds:** plan phase 1. **Read:** BUILD-PLAN.md, handoffs/chat-1.md, `design/e2e/INVENTORY.md`, 09 s4.1, s4.2, s4.4, s4.5, s7, 03 s1 and s12, 05 s3 and s8, 06 s1, 07 s2, 08 Phase 1.

## Goal
A tenant signs in through Zitadel, uploads a solicitation, and gets a checked compliance matrix through the E2E gateway, with PD's tabs working as E2E features.

## PR list (proposed)
1. Contracts for identity, gateway, ingest, intel.
2. Zitadel pinned and unmodified in the stack; identity service: OIDC, management API, tenants, user mirror, memberships, invites, roles, `org_map`, one Zitadel organization per tenant. (fable-reviewer)
3. Sign-in: work email, MFA by authenticator app or passkey, Google and Microsoft SSO. Remove PD's password and session code. (fable-reviewer)
4. `withTenant` sets `app.tenant_id` and `app.org_id` (same value); RLS policies per schema. (fable-reviewer)
5. Gateway: routing, token check, rate limits, chunked upload pass-through. (fable-reviewer: security)
6. Ingest service from PD: upload, ClamAV, sandbox convert, extract, OCR, marking check, classify, chunk, pre-scan. (fable-reviewer: sandbox and upload paths)
7. Solicitation intel from PD: shred, compliance matrix, quote check, dates and schedule, bid facts, amendment key check and diff.
8. Web app: PD tabs as E2E features (09 s7), sign-in screens, bids list, new bid, tab states (05 s8). Every screen from `design/e2e/` per BUILD-PLAN s10, with Playwright states tests and fidelity screenshots. Log each design gap.
9. Cross-tenant test suite over every new endpoint, using the tenant A and B fixtures. (fable-reviewer)

## Done when (08 Phase 1)
- One tenant signs in with a passkey and another with Google SSO, both through Zitadel.
- PD's password and session code is gone from the repo; no E2E service stores a password.
- One solicitation package goes from upload to a checked compliance matrix through the gateway.
- PD's own tests pass inside ingest and intel (services 4 and 5).
- User A gets 404 on every endpoint with user B's ids.
- Proposed: every tab screen passes its Playwright states test and matches its design screen.

## Owner step
Google and Microsoft OAuth test app registrations. Until they exist, test SSO with Zitadel's local test IdP, mark the SSO check "unverified", and log it. If Zitadel cannot run in the session, use the mock OIDC issuer from BUILD-PLAN s3 locally and rely on CI for the real round trip.

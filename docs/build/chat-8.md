# Chat 8: Plans and Stripe, then hardening

**Builds:** plan phases 7 and 8. **Read:** BUILD-PLAN.md, handoffs/chat-7.md, `design/e2e/INVENTORY.md`, 06 s1 to s9, 07 s1 to s12, 05 s6, 09 s4.3, 08 Phases 7 and 8.

## Goal
Paid plans run in Stripe test mode, and every security and isolation check in 07 passes.

## PR list (proposed)
1. Contracts: billing events and endpoints (09 s4.3).
2. Plans: 3, 4, 5 proposals monthly, reset each month; proposal definition (100 drafted pages); recharge beyond. (fable-reviewer)
3. Free proposal: once per tenant, 50 drafted pages, work-email domain controls. (fable-reviewer)
4. Font fee; estimate before run; usage roll-ups. (fable-reviewer)
5. Stripe with PD's webhook handling, test clocks. (fable-reviewer)
6. SAML SSO for Enterprise through Zitadel. (fable-reviewer)
7. Organization, plan, and billing screens from `design/e2e/` per BUILD-PLAN s10 (05 s3, s6).
8. Security pass on 07: cross-tenant tests on every endpoint, job and event consumer; schema-role isolation; repository, font and spec isolation; render and portal cleanup; inbound mail drop. (fable-reviewer)
9. Load test against Anthropic rate limits; event lag, queue and retry measured against a written expectation. Without the key, run it against the stub and mark it "unverified".
10. Backups and restore drill. (fable-reviewer)
11. Legal pages drafted with the 07 s10 disclosures.

## Done when (08 Phase 7)
- In Stripe test mode with test clocks, a tenant subscribes, uses proposals, and resets at the period end.
- The same tenant buys a recharge and pays a font fee.
- A new tenant runs its free proposal, stops at 50 drafted pages, and a second tenant on the same work-email domain gets no second free proposal.
- Each count changes correctly at every step.

## Done when (08 Phase 8)
- Every item in the security pass (PR 8) passes.
- The load test, the restore drill, and the legal pages are done.
- No tenant can read another tenant's data in testing.

## Owner step
Stripe test-mode keys. Until they exist, billing runs against a Stripe mock, and the Phase 7 checks are marked "unverified".

# 08: Build Phases, Testing, and Launch

**Status:** Draft v2 · 17 Oct 2026

E2E Proposal is built as services in the PD repo, renamed to E2E Proposal (09 s5). E2E absorbs PD: PD's code becomes E2E's first working services. Each later phase adds services or stages, so every phase ends with something a tenant could use. Nothing ships until the tool passes the 10-RFP test (Phase 9).

## 1. Build order

| Phase | Builds | Services (09 s3) | Ends with |
|---|---|---|---|
| 0 | Repo rename, restructure, contracts, local stack, test set | `packages/`, `infra/` | PD's code and tests run in the E2E layout |
| 1 | Identity, gateway, PD services and tabs | 1, 2, 4, 5 | Upload to compliance matrix through E2E; PD's tabs work as E2E features |
| 2 | Orchestrator, model gateway, evidence, credit ledger | 3 (ledger only), 6, 7, 11 | Soft intake, AI-ban flag, Gate 0b, resume |
| 3 | Render service and fonts | 10 | Word, PDF, and verified page counts |
| 4 | Drafting | 8 | Every volume drafted with NEEDs and page gates |
| 5 | Reviews, gates, locks, package | 9, plus 8 and 10 | A full run to a downloadable package |
| 6 | Mid-run integrations | 12, 13, 14, 15 | Amendments, Q&A, request and collect, Drive, eBuy, portals, notices |
| 7 | Plans and Stripe | 3 | Paid plans live in Stripe test mode |
| 8 | Hardening, security, legal | All | Every check in 07 passes |
| 9 | 10-RFP test gate | All | Ten or more RFPs run end to end; cost cap set; fixes made |
| 10 | Terms, hosting, beta, launch | All | Paying tenants |

**PD's open PRs.** PRs #35 to #38 finish in the renamed repo in Phase 0, in the order #37, #35, #36, #38. Proposed: before the restructure PR (09 s6).

### Phase 0: Repo rename, restructure, contracts, test set

- Rename the PD GitHub repo (`pd`) to E2E Proposal. History, CI, the secret scan, hooks, infra tests, and PR branches stay. Start now.
- Finish PD's open PRs #35 to #38 in the repo.
- First E2E PR: restructure into `services/`, `packages/`, and `python/` (uv workspace) by the map in 09 s6. Rewrite CLAUDE.md. Move the E2E plans into `docs/plans/` and PD's plans into `docs/plans/archive-pd/`. Remove any parity check.
- Keep `C:\Tools\E2E` for working files only.
- Write CLAUDE.md from the outline in 09 s8.
- Set up `packages/contracts` with the OpenAPI and event schema layout, and `packages/stage-interface`.
- Local stack in Docker Compose: one Postgres cluster with a schema and role per service plus Zitadel's database, Zitadel, Redis, S3-compatible storage (MinIO), and ClamAV. Redis carries BullMQ and the Redis Streams events. One command boots it; the environment variables and migration order are in 09 s9. Proposed: a staging host through PD's `ssh` adapter. The production provider is chosen in Phase 10 (01 s1).
- Gather the test set: at least 10 past RFPs with the proposals the client firm submitted, federal and SLED. Use only documents the Owner may send to a model provider under standard terms. 🟨 **OPEN:** source tenants and written permission (00 s7).
- **Done when:**
  - Every service skeleton builds, boots, and answers a health check.
  - PD's tests pass in the new layout, and CI and the secret scan stay green.
  - PRs #35 to #38 are merged with their tests green.
  - The old PD URL redirects to the renamed repo.
  - A service role that queries another service's schema gets a permission error.
  - `docker compose up` boots the whole local stack, and `pnpm migrate` applies every schema in the order 09 s9 sets.

### Phase 1: Identity, gateway, PD services and tabs

- Identity: self-hosted Zitadel in the stack, pinned by version, unmodified. The identity service wraps it over OIDC and its management API: tenants, the user mirror, roles, invites, and the Zitadel organization per tenant (09 s4.2). Work email sign-in with MFA by authenticator app or passkey. Google and Microsoft SSO. SAML SSO for Enterprise can follow in Phase 7. No SMS (06 s1).
- `org_id` maps to `tenant_id` with the same value; `withTenant` sets both settings (09 s2).
- Gateway: routing, token check, rate limits, chunked upload pass-through.
- Ingest from PD: upload, ClamAV, sandbox convert, extraction, OCR, marking check, classify, chunk, pre-scan.
- Solicitation intel from PD: shred, compliance matrix, quote check, dates and schedule, bid facts, amendment key check and diff.
- PD's tabs become E2E features in the web app: overview, schedule, compliance matrix, outline, resumes, reviews, production, orals, lessons (09 s7).
- **Done when:**
  - A tenant signs in with a passkey, and another with Google SSO, both through Zitadel.
  - PD's password and session code is gone from the repo; no E2E service stores a password.
  - One solicitation package goes from upload to a checked compliance matrix through the E2E gateway.
  - PD's own tests pass inside services 4 and 5.
  - User A gets 404 on every endpoint with user B's ids.

### Phase 2: Orchestrator, model gateway, evidence, credit ledger

- Orchestrator: run state machine, stage records, idempotent stages, stage leases, retries, resume, gates (01 s3; 04 s12).
- Stage interface with today's skills as placeholders (02 s4).
- Model gateway: Anthropic adapter, rate buckets, metering, `ai_runs`, run budgets.
- Cost ledger and pause at the cap. The cap starts as a high placeholder; the 10-RFP test sets the real value (01 s8).
- Evidence and repository: store and fetch by agency, factor, section type, contract, and date, with pgvector. Seed it by importing a tenant's past proposals.
- Billing ledger without Stripe: reserve at run start, release on no-bid or when the run fails or is cancelled (06 s4).
- Soft intake screen with "We already have this", "We still need this", the estimate panel, and "Start run" (05 s4.1).
- AI-ban check at intake. A hit shows the flag, and the run continues (07 s4).
- Amendment gate, shred, and compliance matrix as orchestrated stages; bid/no-bid screen; run monitor (05 s4.2; 05 s4.3).
- **Done when:**
  - A tenant sees intake with items fetched from its repository.
  - An AI-ban clause in a test solicitation raises the flag, and the run goes on to Gate 0b.
  - The run reaches Gate 0b and holds. No-bid releases the reserved credit, and so does a cancelled run.
  - Killing the orchestrator mid-stage and restarting resumes from the saved stage with no duplicate output.

### Phase 3: Render service and fonts

- Python render service in the uv workspace, with the toolrunner and the skill scripts (01 s5.3).
- Install the metric-compatible open fonts. No Microsoft fonts on the Linux render service (01 s5.4).
- Format lock stage: format spec, silent rules, empty shell per volume.
- Word assembly with python-docx from the tenant's format spec and shell.
- Code-computed numbering: contents table, caption numbers, and cross-reference text written as results into the DOCX (01 s5.1).
- LibreOffice headless renders DOCX to PDF. SVG graphics render with librsvg.
- Rasterize every page. The vision model checks overflow, broken tables, cut-off graphics, orphan headings, and margins.
- Page count on the exact PDF the tenant will submit.
- Font request flow: upload, license confirmation, fee record (05 s6; 06 s6). 🟨 **OPEN:** fee amount.
- **Done when:**
  - A test volume renders to Word and PDF, and the contents table and captions match a hand check.
  - A page count matches a hand count of the same PDF.
  - The vision check catches each layout fault planted on purpose in a test page.

### Phase 4: Drafting

- Worksheet, then outline inside the locked format and shells (04 s3).
- Evidence pull, case vignettes, and agency intel.
- Page-gated drafting at 90% with per-page checks, in parallel by volume and section (04 s7.1).
- Prose checks before each gate score: kill words, plain language, term mirror, customer focus, strength test, story placement.
- NEED placeholders for every missing fact; drafting never waits on the user.
- Every claim carries an evidence citation (07 s5).
- Graphics: SVG through render; the image provider for illustrative art only.
- Executive summary. Pricing narrative: the pricing skill suggests, a human approves.
- Pink review document. Drive lands in Phase 6; until then the document downloads from the run monitor.
- **Done when:**
  - On two test RFPs, every page reaches 90% or carries a reason.
  - Every claim has a citation or a NEED.
  - A page that fails the gate re-drafts and re-gates on its own.

### Phase 5: Reviews, gates, locks, package

- Red team review by a separate reviewer model. 🟨 **OPEN:** reviewer model. Pick it here from a side-by-side test on the test set.
- Gate 1 screen: findings, NEEDs ranked by score impact, predicted rating per factor, dispositions (05 s4.7).
- The credit is consumed when the Red draft reaches the tenant at Gate 1 (06 s4).
- Locks: every human-edited block locked; re-drafts write around it; the model proposes changes and never edits silently; the sweep obeys locks (04 s8).
- Apply dispositions, re-draft flagged pages, re-gate, cross-volume sweep, assembly.
- Gold Team and White Glove review. Gate 2 screen with the round-by-round page diff (05 s4.9).
- Final package: volumes in Word and PDF, forms, attachments, compliance matrix, submission checklist, solicitation file naming (05 s4.10). Signature and review notice. Word-only page-limit note.
- **Done when:**
  - One full run goes from upload to package with only gate actions from a person.
  - The credit moves from reserved to consumed at Gate 1, and not before.
  - A locked block survives a re-draft unchanged, and a model change to it appears as a proposal.
  - An uncited claim stops assembly.
  - The package names files by the solicitation's rule.

### Phase 6: Mid-run integrations

- Amendment re-entry: diff, reopen affected pages, re-gate, proposals for locked blocks (04 s9).
- Comms: Gmail and Microsoft 365 connections (02 s7.1). 🟨 **OPEN:** mailbox token storage (07 s2).
- Q&A: draft questions in the required format, fill an agency questionnaire, draft the email, deadline alert, human review and send (05 s4.5).
- Request and collect: send requests from the tenant's mailbox, collect replies, upload option, status per item (05 s4.6).
- Drive: one folder per tenant, shared only with its users (07 s8).
- eBuy watcher: inbound address per tenant, RFQ number parse, bid opened, daily check for misses. 🟨 **OPEN:** how a tenant registers its inbound address in eBuy. Test on one tenant first.
- Portal agent on its own host: human-approved login and MFA, credentials never stored; upload and checklist for banned-automation portals (07 s2). 🟨 **OPEN:** agent implementation.
- Notifications and audit: in-app notices, email notices, the audit log.
- **Done when:**
  - An amendment uploaded mid-draft reopens only the pages it touches.
  - A Q&A email reaches a test inbox from a connected tenant mailbox after a user checks both review boxes.
  - A request reply returns through the mailbox and marks its item received.
  - One test tenant's eBuy notice opens a bid.
  - The agent downloads a document from one portal with a human at the MFA step and leaves no stored credential.

### Phase 7: Plans and Stripe

- Monthly plans: 3, 4, and 5 proposals. Unused proposals reset each month (06 s3).
- Free proposal: one per tenant, once only, up to 50 drafted pages, with the once-per-tenant controls in 06 s3.
- Proposal definition: one solicitation set, up to 100 drafted pages, all review rounds inside the run (06 s4).
- Recharge beyond 100 pages. 🟨 **OPEN:** rate.
- Font fee. Estimate before run. Usage roll-ups from the model gateway (06 s8).
- Stripe, reusing PD's webhook handling (PD 08 Phase 3). 🟨 **OPEN:** currency, assumed USD.
- SAML SSO for Enterprise tenants.
- **Done when:**
  - In Stripe test mode with test clocks, a tenant subscribes, uses proposals, and resets at the period end.
  - The same tenant buys a recharge and pays a font fee.
  - A new tenant runs its free proposal, stops at 50 drafted pages, and a second tenant on the same work-email domain gets no second free proposal.
  - Each count changes correctly at every step.

### Phase 8: Hardening, security, legal

- Security review against 07, including:
  - cross-tenant tests on every endpoint, job, and event consumer;
  - no service role can read another service's schema;
  - a run for tenant A never reads tenant B's repository, fonts, or format specs;
  - render jobs leave no files after they end;
  - portal sessions leave no profile, cookie, or credential behind;
  - comms drops inbound mail to an unknown address.
- Load test: several tenants running at once against the Anthropic rate limits, with event lag, queue, and retry behavior measured. Write the expected wait per run before the test.
- Backups and restore drill, as in PD (PD 08 Phase 5).
- Legal pages drafted with the disclosures in 07 s10. 🟨 **OPEN:** legal review.
- **Done when:** every item above passes, and no tenant can read another tenant's data in testing.

### Phase 9: 10-RFP test gate

The tool does not ship until it passes this gate.

- Run at least 10 RFPs end to end, from upload to package, federal and SLED. Use the Phase 0 test set.
- A proposal writer reads each package against what the client firm actually submitted.
- Measure per run: model and image cost, time to each gate, pages passing the 90% gate, Red findings accepted, uncited claims caught, page count accuracy.
- Set the per-run cost cap from the measured cost (01 s8).
- Fix what the test finds, then rerun the failing RFPs.
- Pass bar, decided: every package complete and page-verified, zero uncited claims, and zero cross-tenant reads. A writer must rate at least 8 of 10 packages "submittable after review".
- **Done when:**
  - At least 10 RFPs complete, and the pass bar holds.
  - The cost cap value is written into `app_settings`.

### Phase 10: Terms, hosting, beta, and launch

- Move to zero-retention and no-training terms with Anthropic and the image provider. The 10-RFP test runs under standard terms. The terms change before the tool ships and before any tenant document goes out under a paid plan (07 s9).
- Choose the production hosting provider. Deploy with PD's adapters (01 s1).
- Private beta with a small number of client firms. 🟨 **OPEN:** how many, and on what terms.
- Measure cost per run against the cost cap and the plan prices.
- 🟨 **OPEN:** Enterprise terms.
- Final product name after the trademark and domain check (00 s7).
- **Done when:**
  - The provider terms are in writing.
  - Production runs on the chosen host, and the restore drill passes there.
  - Beta runs reach the package, and measured cost per run fits under the plan prices.
  - Prices are live in Stripe.

## 2. Testing summary

| Type | Where |
|---|---|
| Unit tests | Stage state and resume, idempotent stages, cost cap math, lock rules, NEED register, citation check, numbering, page count, file naming, credit reserve and consume, plan and reset rules, recharge |
| Contract tests | Every service against the OpenAPI files and event schemas in `packages/contracts` |
| Identity | Sign-in, MFA, and SSO round trips against the local Zitadel; a Zitadel user event updates the mirror |
| Script self-tests | Every bid-autopilot script's `--selftest` runs in CI on the render image |
| Model tests | Test set runs per phase; rerun on every skill or prompt change; reviewer model chosen in Phase 5 |
| Render tests | Planted layout faults caught; computed numbering matches a hand check; page count matches the exact PDF; metric-compatible fonts hold line breaks |
| Integration tests | Upload to package on staging; amendment mid-run; Q&A send; request and collect round trip; eBuy inbound on one test tenant |
| Tenant isolation | PD's tests plus schema-role, event, repository, render, agent, Drive, and inbound mail checks in Phase 8 |
| Lock tests | A locked block survives re-draft, sweep, and amendment; changes arrive only as proposals |
| Accuracy | An uncited claim always blocks assembly; a NEED is never filled by the model |
| Billing | Stripe test clocks for resets, recharge, and font fee |
| 10-RFP test | Phase 9, before launch |

## Decision log

| Date | Decision |
|---|---|
| 17 Oct 2026 | Render server and fonts before drafting, so page budgets rest on real page counts |
| 17 Oct 2026 | eBuy watcher tested on one tenant first |
| 17 Oct 2026 | Rush path for eBuy RFQs and task orders dropped |
| 17 Oct 2026 | Owner decision: build order rewritten for microservices in one monorepo; work starts now |
| 17 Oct 2026 | Owner decision: a 10-RFP test gate before launch. The tool runs at least 10 RFPs, the terms change, then it ships |
| 17 Oct 2026 | Owner decision: the per-run cost cap comes from the 10-RFP test |
| 17 Oct 2026 | Owner decision: hosting is chosen after the tool is built, in Phase 10 |
| 17 Oct 2026 | Owner update: E2E absorbs PD; no shared package, no parity check |
| 17 Oct 2026 | Owner decision: no new repo. The PD repo is renamed to E2E Proposal and restructured in Phase 0's first PR |
| 17 Oct 2026 | Reviewer model picked in Phase 5 from a side-by-side test |
| 17 Oct 2026 | Owner decision: PD's open PRs finish in the renamed repo in Phase 0 |
| 17 Oct 2026 | Owner decision: one free proposal per tenant, capped at 50 drafted pages, built and tested in Phase 7 |
| 17 Oct 2026 | Owner confirmed: the 10-RFP test runs under standard terms; zero-retention terms come before shipping |
| 17 Oct 2026 | Owner decision: the Phase 9 pass bar is complete packages, zero uncited claims, and 8 of 10 submittable (item 64 closed) |
| 17 Oct 2026 | Owner decision: the local stack runs Redis for BullMQ and Redis Streams events; no NATS |
| 17 Oct 2026 | Owner decision: the Phase 9 pass bar also keeps page-verified packages and zero cross-tenant reads |
| 17 Oct 2026 | Owner decision: Zitadel enters the local stack in Phase 0 and the identity service wraps it in Phase 1 (item 61 closed) |
| 17 Oct 2026 | Final review: Phase 0 gains the one-command local stack and migration order (09 s9); Phase 2 release rule names failure and cancel |

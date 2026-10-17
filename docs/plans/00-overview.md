# 00: Overview

**Status:** Draft v2 · 17 Oct 2026 · Reviewed 17 Oct 2026 · Owner decisions applied 17 Oct 2026
**Folder:** `plan/docs`
**How to use these plans:** each file covers one area. Update the "Decision log" in the relevant file when a decision changes during the build. Open items carry 🟨 **OPEN** and also appear in section 7 of this file.

## 1. What we are building

E2E Proposal (working name) is a multi-tenant web app sold to government contractors for federal and SLED (state, local, education) bids. The goal is a proposal done with one click. A user uploads the solicitation set, and the tool runs the whole proposal pipeline in the background. People step in only at a few gates.

The tool runs the 24 bid-autopilot skills as a backend pipeline on the Anthropic API. It runs as 15 microservices in one monorepo (09). E2E absorbs PD, the earlier proposal development tool, entirely. The PD repo is renamed to E2E Proposal and becomes that monorepo. PD's code becomes E2E's ingest, solicitation intel, identity, and billing services, the web shell, and `infra/`. PD's tabs become E2E features.

Who is who:
- **Tenant:** a client firm that buys the tool. The tenant is the offeror on every bid it runs.
- **Vendor:** Shaavir, which builds, hosts, and sells the tool.
- **Owner:** the product owner, who holds the open decisions in these plans.

The tool is a platform for sale. Shaavir's own users are one set of users among many.

## 2. Plan files

| File | Covers |
|---|---|
| 00-overview.md | Product, goal, decisions table, run flow summary, scope, success measures, open items, decision log (this file) |
| 01-infrastructure.md | Hosting (OPEN until built), services per server role, orchestrator, events and queues, render service, fonts, portal agent sandbox, model providers, cost cap, monitoring, backups |
| 02-architecture.md | Stack, the 15 services, PD reuse map, stage interface, data flow per stage, tenancy model, integrations (email MCPs, Shaavir Drive, eBuy inbound, portals), APIs |
| 03-data-model.md | Tables (tenants, bids, runs, stages, pages, blocks with locks, findings, dispositions, NEEDs, evidence, repo items, requests, Q&A, packages, billing usage), storage layout, schemas by service |
| 04-pipeline.md | Stages mapped to the 24 skills and their scripts, inputs and outputs, gates, 90% page gate, separate reviewer, locks, amendment re-entry, Q&A, request and collect, resume, failure handling |
| 05-ui.md | Screens: soft intake, bid/no-bid, run monitor, Q&A review and send, request tracker, Gate 1 review, Gate 2 sign-off, package download, repository browser, settings |
| 06-accounts-billing.md | Tenants, roles, plans, monthly reset, proposal definition, recharge, font fee, estimate before run, usage metering, Stripe |
| 07-security-privacy-legal.md | Tenant isolation, credentials, MFA flow, disclosures, AI-ban flag, accuracy and citations, signatures, retention, Drive storage, subprocessors |
| 08-build-phases.md | Build order by service, acceptance checks, tests, the 10-RFP test gate, launch |
| 09-repo-and-services.md | Platform rules, each service's contract, the monorepo layout, the PD repo rename and restructure, PD tabs as features, the CLAUDE.md outline, local development and configuration |

Cross-references read as (file number, section), for example (04 s6) or (04 s7.2). PD plan references read as (PD 04 s3.1).

## 3. Decisions made

| Area | Decision |
|---|---|
| Product shape | Multi-tenant web app. One click starts a full proposal run from the solicitation set |
| Product name | E2E Proposal, a working name. The final name waits on a trademark and domain check |
| Base | E2E absorbs PD. PD's code becomes E2E services in place; PD's tabs become E2E features (09 s7) |
| Architecture | Microservices: 15 services, one Postgres cluster with a schema per service and row-level security in each, Redis Streams events, S3-compatible storage, one container per service (09) |
| Repo | No new repo. The PD repo (`pd` under the vendor's GitHub account, local `C:\Tools\PD`) is renamed to E2E Proposal and keeps its history, CI, secret scan, hooks, infra tests, and PR branches. The first PR restructures it: pnpm and Turbo for TypeScript, a uv workspace for render and the portal agent. `C:\Tools\E2E` holds working files only (09 s5; 09 s6) |
| Hosting | Chosen after the tool is built. Deploys use PD's hosting adapters (01 s1) |
| Identity | Self-hosted Zitadel (AGPL-3.0), unmodified where possible, wrapped by the identity service, which owns `tenant_id`; PD's `org_id` maps to it. Any change to Zitadel's source is published on our site. Work email with authenticator app or passkey MFA; Google and Microsoft SSO; SAML for Enterprise; no SMS (06 s1; 09 s4.2) |
| Tenancy | Each client firm is a tenant. Each tenant keeps its own evidence, format specs, fonts, users, and repository. Nothing crosses tenants |
| Orchestrator | Runs the stages as a pipeline. It saves state after each stage, so a run can resume. Durable events, idempotent stages, retries, rate-limit handling, and a cost cap per run (01 s3) |
| Stage interface | Every stage runs behind one interface. Today's skills are placeholders; the Owner rebuilds each stage's skill later (02 s4) |
| Stage order | Format lock runs before the outline (04 s3) |
| Skill scripts | Move to the render service (the brief's render/worker server). Stage services call them as tools |
| Render service | Python, on Linux. SVG graphics, Word assembly with python-docx, code-computed numbering (contents, captions, cross-references), LibreOffice headless DOCX to PDF, page verify |
| Image provider | GPT Image 2, for illustrative art only |
| Red review | A separate reviewer model, different from the drafter. The Owner has not chosen the model |
| Intake | Soft. Only the RFP is mandatory. The tool fetches what the tenant repo already holds and shows "we already have this" and "we still need this" |
| Placeholders | Drafting proceeds with NEEDs until inputs arrive. All other inputs must arrive before the Red review |
| AI-ban check | A solicitation that bans or restricts AI-generated content gets a flag at intake. The run continues |
| Locks | Every block a human edits gets a lock. Re-drafts and the sweep write around locked blocks. The model may propose a change to a locked block but never edits it silently |
| Page verification | About 99% of submissions are PDF. The tool renders, rasterizes every page, and a vision model checks layout. The tool measures page count on the exact PDF submitted |
| Word-only submissions | Accepted. The package ends with a note telling the user to check the page limit in Word |
| Fonts | Windows Server licenses Microsoft's fonts; the Linux render service ships none. It uses metric-compatible open fonts and open-licensed fonts. Other fonts by request, for a one-time fee |
| Commercial fonts | Need the tenant's own license. The request takes a font upload plus license confirmation. The fee does not license the font |
| Q&A | The pipeline drafts questions in the required format, or fills the agency's questionnaire. A human reviews and sends from the tenant's own mailbox. Deadline alert |
| Request and collect | The tool requests and collects commitment letters, partner past performance forms, resume consents, and similar items by email. Upload also works. Status tracked per item |
| Email | Sent from the tenant's own address through the Gmail and Microsoft 365 connections (MCP) the tenant links |
| Shaavir Drive | Every tenant gets its own Drive folder, shared only with that tenant's users. The Pink review document and working documents live there |
| Portals | The user picks: a browser agent with the human approving each login and MFA, or manual upload. Credentials are never stored. Portals that ban automation get upload or a guided checklist. The final submit click is always a human's |
| eBuy watcher | Each tenant gets an inbound address. The tool parses the RFQ number and opens a bid. A daily check covers missed emails. Test on one tenant first |
| Accuracy | Every past performance and staffing claim needs an evidence citation. Assembly blocks uncited claims |
| Signatures | The tool fills details. The client signs and reviews. The tool never signs |
| Disclosures | Cover AI processing (Anthropic and the image provider), subprocessors, and Drive storage |
| Learning loop | Learns from filled NEEDs and reviewer dispositions. Award outcome and debrief feed the repository and gate calibration |
| Repository | Per tenant. Holds past sections, designs, graphics, and every other proposal part. Fetchable by agency, factor, section type, contract, and date. Never shared across tenants |
| Plans | Monthly: 1800 for 3 proposals, 2200 for 4, 2500 for 5. Enterprise by discussion. USD assumed |
| Free proposal | One per tenant, once only, up to 50 drafted pages, otherwise the same proposal definition. Tied to the verified work-email domain (06 s3) |
| Unused proposals | Reset every month |
| Proposal credit | Reserved at run start. Released on no-bid, or when a run fails or is cancelled before the Red draft. Consumed when the Red draft reaches the tenant (06 s4) |
| PD plans | PD's Free, Starter, and Growth plans dropped for E2E's plans (06 s3) |
| One proposal | One solicitation set (solicitation, amendments, attachments). Up to 100 drafted pages in total, with all review rounds inside the run. Beyond 100 pages, an additional recharge |
| Estimate | Cost and time shown before a run starts, from page count and volume count |
| Cost cap | Image and model cost count against the run's cost cap. The cap value comes from the 10-RFP test (08 Phase 9) |
| Launch gate | The tool runs at least 10 RFPs end to end under standard provider terms. The pass bar: complete packages, zero uncited claims, 8 of 10 submittable. The terms then move to zero retention. Then it ships (08 Phase 9; 08 Phase 10) |
| Dropped | Rush path for eBuy RFQs and task orders |

## 4. Run flow summary

Full detail lives in (04 s6) and (05 s4).

| Step | Type | What happens |
|---|---|---|
| Gate 0: Intake | Soft, human | RFP upload is the only mandatory input. The tool pulls past performance and other inputs from the tenant repo first. It shows what it has, what it still needs, and which items are mandatory. AI-ban clauses get a flag here |
| Run part 1 | Automatic | Amendment gate, shred, compliance matrix. AI-ban clauses stay flagged; the run goes on |
| Gate 0b: Bid/no-bid | Human | After the shred, the tool scores fit, eligibility, past performance coverage, and risk. A human decides |
| Run part 2 | Automatic | Scoresheet, format lock, then outline. Q&A questions drafted. Pink review document in Shaavir Drive. Evidence pull, vignettes, agency intel. Page-gated drafting at 90% with per-page checks, in parallel by volume and section. Graphics, executive summary, pricing narrative (the pricing skill suggests, a human approves). Red team review by the separate reviewer model |
| Gate 1: After Red | Human | The Red draft reaches the tenant here, and the proposal credit is consumed. The reviewer sees findings, NEEDs, and page scores. The tool shows a predicted rating per evaluation factor and NEEDs ranked by score impact. The reviewer accepts, edits, or rejects each finding, fills NEEDs, and approves. Edited blocks lock |
| Run part 3 | Automatic | Apply dispositions. Re-draft flagged pages around locked blocks. Re-gate. Cross-volume sweep, assembly, PDF render and visual check, page count. Gold Team and White Glove review |
| Gate 2: After Gold | Human | The reviewer sees a round-by-round diff, page by page. They confirm final volumes and sign off |
| Final package | Download | One download (section 5). The tool lists what needs a signature and what needs review. The client signs; the tool never signs |
| Submission | Optional, human | Portal agent with human approval, or manual upload. A human always clicks submit |

Any time during a run:
- **Amendment re-entry.** The tool diffs each new amendment, whether uploaded or caught by the eBuy watcher. Affected pages reopen and re-gate.
- **Q&A.** Draft questions and the draft email show in the tool. A human reviews both, then sends.
- **Request and collect.** Third-party items go out by email from the tenant's mailbox and come back by email or upload. Status is tracked per item.

## 5. Scope

**In scope for v1:**
- The full run flow in section 4, from intake to the final package.
- The final package as one download:
  - All volumes in Word and PDF, page-verified.
  - Completed forms: SF 33 or SF 1449, reps and certs, pricing sheets, and the cover letter.
  - Attachments: resumes, past performance forms, commitment letters, certificates.
  - The compliance matrix and a submission checklist.
  - File names that follow the solicitation.
- Per-tenant repository, Shaavir Drive folder, inbound eBuy address, and email connections.
- Plans, recharge, font requests, and Stripe billing (06).

**Out of scope for v1:**
- Rush path for eBuy RFQs and task orders (dropped).
- Signing any document. The client signs.
- Clicking submit on any portal.
- Browser agent use on portals that ban automation, such as SAM.gov.
- Sharing anything across tenants, including repository items and learned calibration.
- A separate PD app. PD's features live inside E2E.

## 6. Success measures (first 6 months)

The Owner sets targets at launch where this list gives no number.

- Share of runs that reach Gate 1 with no human input beyond the RFP and the intake screen.
- Uncited past performance or staffing claims in a delivered package: zero. Assembly blocks them, so any found is a defect.
- Page count on the submitted PDF matches the solicitation limit on every PDF package.
- Cross-tenant data exposure: zero incidents.
- Model and image cost per run stays inside the run's cost cap.
- Share of Red findings the reviewer accepts at Gate 1, tracked as a quality signal.
- Award rate on tenant proposals, from the outcomes fed back into the repository.

## 7. Open items 🟨

One merged list. Each file keeps its own markers; this list is the index. Items 1 to 12 come from the brief. Items 13 to 59 surfaced while drafting. Items 60 to 66 came with the owner decisions of 17 Oct 2026. Items 67 and 68 came from the final review. Closed items keep their numbers, so references hold.

**From the brief**

1. 🟨 **OPEN:** Red reviewer model. It must differ from the drafter (01 s6.2; 04 s7.2; 08 Phase 5).
2. 🟨 **OPEN:** recharge rate for drafted pages beyond 100 per proposal, and its unit (06 s5).
3. 🟨 **OPEN:** font request fee amount (06 s6).
4. 🟨 **OPEN:** currency. The plans assume USD (06 s3).
5. **CLOSED 17 Oct 2026:** zero-retention and no-training terms. The 10-RFP test runs under the providers' standard terms. The terms then move to zero retention, and only then does the tool ship. Owner confirmed (01 s6.1; 07 s9; 08 Phase 10).
6. 🟨 **OPEN:** final product name and domain. Working name: E2E Proposal. Needs a trademark and domain check (01 s9; 05 s2; 08 Phase 10).
7. 🟨 **OPEN:** hosting provider. Chosen after the tool is built; deploys use PD's adapters (01 s1; 07 s9; 08 Phase 10).
8. 🟨 **OPEN:** browser agent build: Anthropic computer use, or Playwright driven by the model (01 s7; 02 s7.4; 07 s2).
9. **CLOSED 17 Oct 2026:** PD reuse. E2E absorbs PD; the restructure map and each service's PD source are set (02 s3; 09 s3; 09 s6).
10. 🟨 **OPEN:** eBuy inbound address registration. Test on one tenant first (02 s7.3; 08 Phase 6).
11. 🟨 **OPEN:** Enterprise terms (06 s3; 08 Phase 10).
12. 🟨 **OPEN:** who may raise the per-run cost cap. The cap value is closed: the 10-RFP test sets it (01 s8; 04 s12; 05 s4.3; 06 s8; 08 Phase 9).

**Platform and infrastructure**

13. **CLOSED 17 Oct 2026:** one deployment or two. E2E absorbs PD, so one platform serves all tenants (01 s1; 09 s6).
14. 🟨 **OPEN:** render role plan and price, and app role price, at the provider chosen after the build (01 s5.2; 01 s13).
15. 🟨 **OPEN:** inbound mail service, which becomes a subprocessor (01 s9; 07 s9).
16. 🟨 **OPEN:** backup retention for the repository and final packages; RPO and RTO targets (01 s11; 07 s7).
17. **CLOSED 17 Oct 2026:** field refresh. The render service computes the contents table, captions, and cross-references in code; LibreOffice headless renders the PDF (01 s5.1; 04 s5.19).
18. **CLOSED 17 Oct 2026:** core fonts EULA. The Linux render service ships no Microsoft fonts and uses metric-compatible fonts (01 s5.4; 07 s11).
19. 🟨 **OPEN:** vision token cost per page. Confirm against current Anthropic docs before the 10-RFP test (01 s6.1).
20. 🟨 **OPEN:** which email MCP servers (hosted or self-run) and the narrowest scopes each needs (02 s7.1).
21. 🟨 **OPEN:** mailbox OAuth token storage. Proposed: encrypted at rest, scoped to the tool's threads, revocable (02 s7.1; 07 s2).
22. 🟨 **OPEN:** Shaavir Drive's interface for folders, sharing, versions, and change notices; which service backs it (02 s7.2; 07 s8).
23. 🟨 **OPEN:** how the daily eBuy check authenticates per tenant without stored credentials (02 s7.3; 07 s2).
24. 🟨 **OPEN:** whether the tool pulls opportunity attachments through SAM.gov's public API, which is not browser automation (02 s7.4; 07 s2).
25. **CLOSED 17 Oct 2026:** Telnyx phone verification dropped. Sign-in uses MFA by authenticator app or passkey, plus SSO (06 s1).
26. **CLOSED 17 Oct 2026:** `org_id` versus `tenant_id`. The identity service owns `tenant_id`; PD's `org_id` maps to it with the same value (03 s1; 09 s2).
27. 🟨 **OPEN:** how `gate_calibration` changes the 90% gate score, if at all (03 s7).

**Pipeline**

28. **CLOSED 17 Oct 2026:** stage order. Format lock runs before the outline (04 s3).
29. 🟨 **OPEN:** whether pricing approval must land before Red or only before assembly (04 s3).
30. 🟨 **OPEN:** which model runs the outline stage, given the plugin's model pin. The Owner's stage rebuild may settle it (04 s4).
31. **CLOSED 17 Oct 2026:** AI-ban hit. It flags, and the run continues (04 s5.1; 05 s4.1; 07 s4).
32. 🟨 **OPEN:** how Drive edits are read back, and whether they count as human edits that lock blocks (02 s7.2; 04 s5.9).
33. 🟨 **OPEN:** Gate 0b score weights, and whether any score sets a recommendation (04 s6).
34. 🟨 **OPEN:** whether Gold and White Glove also use the reviewer model (04 s7.2).
35. 🟨 **OPEN:** whether an amendment after Gate 2 reopens the run on its own or waits for a user (04 s9).
36. 🟨 **OPEN:** Q&A alert schedule and request reminder timing (04 s10; 04 s11; 05 s4.6; 05 s7).
37. 🟨 **OPEN:** whether each request email needs a human click before it goes. Proposed: yes, as for Q&A (02 s7.1; 04 s11; 05 s4.6; 07 s3).
38. 🟨 **OPEN:** page count after a tenant edits the DOCX in Word and re-exports. The tool's count holds only for its own PDF (01 s5.5; 04 s5.20).

**Accounts and billing**

39. 🟨 **OPEN:** user seats per plan, and seats after a downgrade (06 s3; 06 s9).
40. 🟨 **OPEN:** whether gates need a separate reviewer or approver role, or any Member can act (04 s6; 06 s2).
41. 🟨 **OPEN:** whether a tenant can have more than one Admin (06 s2).
42. **CLOSED 17 Oct 2026:** free tier. One free proposal per tenant, once only, capped at 50 drafted pages. Control details moved to item 66 (06 s3).
43. **CLOSED 17 Oct 2026:** proposal credit points. Reserved at run start, released on no-bid, consumed when the Red draft reaches the tenant. A failed run before the Red draft moved to item 62 (06 s4).
44. 🟨 **OPEN:** a run that starts in one period and ends in the next (06 s4).
45. 🟨 **OPEN:** solicitation key overrides allowed per bid (06 s4).
46. 🟨 **OPEN:** whether completed forms and attachments count toward the 100 drafted pages (06 s5).
47. 🟨 **OPEN:** what happens when the outline or an amendment pushes the total past 100 mid-run (06 s5).
48. 🟨 **OPEN:** the estimate when the solicitation sets no page limit, and whether it shows again after an amendment (06 s7).
49. 🟨 **OPEN:** whether the cost cap scales with page count or a recharge (06 s8).
50. 🟨 **OPEN:** what a lapsed tenant keeps, for how long, and a run in flight at lapse (06 s9; 07 s7).
51. 🟨 **OPEN:** Stripe Tax, from launch or once sales cross a nexus threshold (06 s9).

**Security, legal, and launch**

52. 🟨 **OPEN:** each portal's current login and MFA method. login.gov on SAM.gov is known; PIEE and eBuy need confirming (07 s2).
53. 🟨 **OPEN:** agent session timeout length. 01 s7 proposes 10 minutes idle and 60 minutes hard (01 s7; 07 s2).
54. 🟨 **OPEN:** resume retention. PD deletes at 90 days; the repository keeps them for reuse (07 s7).
55. 🟨 **OPEN:** whether collected third-party items enter the repository, and whether Drive copies follow bid deletion (07 s7).
56. 🟨 **OPEN:** legal review: Indian entity serving US firms, AI-ban clauses, offeror liability (07 s11).
57. 🟨 **OPEN:** email notification channel (05 s7).
58. 🟨 **OPEN:** test set sources. The size is set: at least 10 RFPs, from firms that give written permission (08 Phase 0; 08 Phase 9).
59. 🟨 **OPEN:** beta size and terms (08 Phase 10).

**From the owner decisions of 17 Oct 2026**

60. **CLOSED 17 Oct 2026:** event bus. Redis Streams on the self-hosted Redis container that BullMQ already uses; no NATS. A hosted Redis free tier is too small for production (01 s4; 02 s1; 09 s2).
61. **CLOSED 17 Oct 2026:** identity runs on self-hosted Zitadel (AGPL-3.0), unmodified where possible. Any change to Zitadel's own source is published on our site under AGPL. The identity service wraps it and owns `tenant_id` (06 s1; 07 s11; 09 s4.2).
62. **CLOSED 17 Oct 2026:** a run that fails or is cancelled before the Red draft releases its reserved credit (06 s4).
63. 🟨 **OPEN:** a solicitation that names Times New Roman or Arial. The PDF's font list shows the metric-compatible substitute. Proposed: the checklist names each substitute, and the tenant may supply its licensed font (01 s5.4).
64. **CLOSED 17 Oct 2026:** the 10-RFP test pass bar. Complete packages, zero uncited claims, and at least 8 of 10 rated submittable. Owner confirmed (08 Phase 9).
65. **CLOSED 17 Oct 2026:** PD's open PRs #35 to #38 finish in the renamed repo (08 s1; 09 s6).
66. 🟨 **OPEN:** free-proposal controls: domain proof, shared and umbrella domains, parent firms, signup limits per IP, and whether a card is ever needed. Proposed rules in 06 s3 (06 s3).
67. **CLOSED 17 Oct 2026, accepted:** Zitadel holds credentials, sessions, MFA factors, and identity providers; the identity schema keeps tenants, a user mirror, memberships, invites, and `org_map` (03 s2; 09 s4.2).
68. **CLOSED 17 Oct 2026, accepted:** `appendfsync everysec`, so a crash can drop up to one second of events, which the outbox relay re-publishes (01 s4; 09 s2).

## Decision log

| Date | Decision | Source |
|---|---|---|
| 17 Oct 2026 | Plans v1 drafted from the plan brief: product, platform, run flow, locks, page verification, fonts, portals, eBuy watcher, Shaavir Drive, legal, learning loop, plans and billing | Plan brief |
| 17 Oct 2026 | Rush path for eBuy RFQs and task orders dropped | Plan brief |
| 17 Oct 2026 | Signup, Stripe handling, and the solicitation key rule carry over from PD (06) | PD plans |
| 17 Oct 2026 | Tenant roles named Admin and Member, so "Owner" means only the product owner in these plans | Drafting choice |
| 17 Oct 2026 | Review pass: cross-references normalized to (NN sX), open items merged here, stage order restored to the brief (outline before format lock) | Review |
| 17 Oct 2026 | Owner decisions applied: working name E2E Proposal; hosting after the build; zero-retention terms after a 10-RFP test gate; cost cap from that test | Owner |
| 17 Oct 2026 | Owner decisions applied: microservices (09); identity owns `tenant_id` with MFA, passkeys, and SSO, no SMS; format lock before outline; stage interface with placeholder skills | Owner |
| 17 Oct 2026 | Owner decisions applied: AI-ban flags and continues; credit consumed at the Red draft; code-computed numbering; metric-compatible fonts on Linux; one monorepo | Owner |
| 17 Oct 2026 | Owner update: E2E absorbs PD entirely. Its tabs become features and its plans are dropped | Owner |
| 17 Oct 2026 | Owner decision: no new repo. The PD repo is renamed to E2E Proposal and becomes the monorepo; the first PR restructures it and archives PD's plans under `docs/plans/archive-pd/` | Owner |
| 17 Oct 2026 | Owner decisions: PD's open PRs finish inside E2E; one free proposal per tenant, capped at 50 drafted pages | Owner |
| 17 Oct 2026 | Open items 5, 9, 13, 17, 18, 25, 26, 28, 31, 42, 43, and 65 closed; items 6, 7, 12, and 58 narrowed; items 60 to 66 added | Owner decisions |
| 17 Oct 2026 | Item 5 confirmed. Items 60 (Redis Streams, no NATS), 62 (credit released), and 64 (pass bar) closed. Item 61 stays open | Owner decisions |
| 17 Oct 2026 | Item 61 closed: self-hosted Zitadel for identity (MFA, passkeys, Google and Microsoft sign-in, SAML). Changes to Zitadel's source, if any, are published on our site under AGPL | Owner decision |
| 17 Oct 2026 | Final review: Zitadel carried into every file it touches; credit release on failure or cancel aligned in 03, 06, and 08; "render server" renamed render service; 09 gains local development and configuration (09 s9); items 67 and 68 added | Review |
| 17 Oct 2026 | Items 67 (Zitadel and identity schema split) and 68 (`appendfsync everysec` with outbox re-publish) accepted and closed | Owner decisions |

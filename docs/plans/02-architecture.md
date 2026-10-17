# 02: Architecture

**Status:** Draft v2 · 17 Oct 2026

E2E Proposal is a set of microservices. It absorbs PD entirely. PD already takes a solicitation set from upload to a checked compliance matrix. The PD repo, renamed to E2E Proposal, becomes the E2E monorepo. PD's code becomes ingest, solicitation intel, identity, billing, the web shell, and `infra/`. New services turn the matrix into finished volumes. 09 holds each service's contract. PD plan references read as (PD 02 s4).

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| TypeScript services | Node 20, Fastify, Drizzle, pnpm and Turbo | PD's stack (PD 02 s1). Thirteen of the fifteen services |
| Python services | Python 3.12, FastAPI, one uv workspace | Render and the portal agent. The skill scripts and python-docx are Python |
| Web | React with Vite | PD's web shell, with PD's tabs as E2E features (09 s7) |
| Database | One PostgreSQL 16 cluster, one schema per service, row-level security in each | Strong isolation with one cluster to run and back up |
| Identity | Self-hosted Zitadel (AGPL-3.0), wrapped by the identity service | Decided. Credentials, MFA, passkeys, Google, Microsoft, and SAML live in Zitadel; `tenant_id`, memberships, and invites live in our schema (09 s4.2) |
| Vector search | pgvector in the evidence schema | Repository fetch by meaning, inside the tenant |
| Events | Redis Streams on the self-hosted Redis container, decided | Durable, replayable events between services, on the Redis that BullMQ already uses. No NATS (09 s2) |
| In-service queues | PD's BullMQ on Redis inside ingest and intel | PD's jobs move as built |
| Object storage | S3-compatible, encrypted | Run files, the repository, and packages outgrow one disk |
| Render | python-docx, LibreOffice headless (MPL 2.0), Poppler, pdfplumber, librsvg | DOCX, PDF, page images, page geometry, SVG (01 s5) |
| Model access | The model gateway service, built from PD's provider layer | One place for keys, rate limits, metering, and the cost cap |
| Email | Gmail and Microsoft 365 connections, in the comms service | Mail leaves from the tenant's own address (s7.1) |
| Working documents | Shaavir Drive, in the Drive service | Pink and working documents per tenant (s7.2) |
| Containers | One per service, deployed with PD's hosting adapters | Hosting stays OPEN until the tool is built (01 s1) |

## 2. Services

Fifteen services. 09 s3 lists language, server role, and PD source for each.

```
Browser (E2E web, with PD's tabs as features)
   │  HTTPS (Cloudflare → nginx)
   ▼
[1] Gateway / BFF ── verifies tokens from [2], routes, composes screens, streams run updates
   │
   ├── [2] Identity and tenancy   tenant_id, memberships, roles; wraps Zitadel (MFA, passkeys, SSO)
   ├── [3] Billing                plans, credits, recharge, font fee, Stripe
   ├── [4] Ingest                 upload, ClamAV, sandbox, OCR, marking, classify   (from PD)
   ├── [5] Solicitation intel     shred, matrix, dates, bid facts, amendments, fit  (from PD)
   ├── [6] Orchestrator           run state machine, stages, gates, resume, cost cap
   ├── [8] Drafting               worksheet, outline, pages, blocks, locks, NEEDs
   ├── [9] Review                 Red, Gold, White Glove, findings, diff
   ├── [10] Render (Python)       format lock, assembly, numbering, PDF, page count, package
   ├── [11] Evidence and repo     evidence, repository, pgvector, learning
   ├── [12] Comms                 Gmail and M365, Q&A, request and collect, eBuy inbound
   ├── [13] Portal agent (Python) isolated host, human-approved logins
   ├── [14] Drive                 Shaavir Drive folders and read-back
   └── [15] Notifications, audit  alerts, email notices, audit log

[7] Model gateway ── Anthropic, reviewer model, image provider, rate buckets, metering
    (called by 5, 6, 8, 9, 10, 11, 12, 13; never by the browser)

Shared: Postgres cluster (schema per service) · Redis Streams events · object storage
```

Rules that hold across services:
- No service reads another service's schema. It calls an API or consumes an event.
- No service opens an uploaded file except ingest, through PD's sandbox. Files reach a model only as text and page images that ingest or render produced.
- Only the model gateway holds model keys.
- The orchestrator never drafts. It asks the owning service to run a stage.

## 3. PD reuse map

PD's code stays in its own repo, which is renamed to E2E Proposal and restructured into services (09 s6). No code is copied. No PD app survives on its own.

| PD component | E2E service | Status |
|---|---|---|
| Hosting adapters, LUKS volumes, host firewall, Borg and B2 backups (PD 01 s4, s9) | Shared `infra/` | As is |
| Cloudflare, nginx, chunked upload sessions (PD 01 s3, PD 02 s3) | Gateway, ingest | As is |
| Auth, sessions, organizations, members, invites | Identity. Organization becomes tenant; `org_id` maps to `tenant_id`. Zitadel takes over passwords, sessions, MFA, and SSO; PD's password and session code retires. Members and invites carry over. SMS dropped | Replace and extend |
| Row-level security and `withOrg` (PD 02 s4) | Every service, through `withTenant` in `packages/core` | Extend |
| ClamAV, sandbox: encryption check, DOCX to PDF, text, OCR (PD 01 s2.1) | Ingest | As is |
| Marking check (CUI, export control) | Ingest | As is |
| Classify, chunk, pre-scan | Ingest | As is |
| Compliance matrix passes 1 to 6, quote check | Solicitation intel | As is |
| AI-ban check | Solicitation intel, beside the marking result (s5) | New |
| Amendment key check and diff (PD 04 s3.1) | Solicitation intel. The orchestrator reopens pages from its event (04 s9) | Extend |
| Dates task and schedule | Solicitation intel; comms reads schedule events for the Q&A alert | Extend |
| Bid facts, outline, production rules, resume matrix, review scoring tasks | Intel, drafting, evidence, and review, by table (09 s4) | Extend |
| Provider layer and `ai_runs` (PD 02 s5) | Model gateway; adapters added for image and reviewer | Extend |
| Skill loader (PD 02 s6) | `packages/stage-interface` | Extend |
| BullMQ queues and per-bid caps | Inside ingest and intel; run caps move to the orchestrator | Extend |
| Exports: ExcelJS, docx library | Matrix exports stay in intel. Volumes come from render | Extend |
| Stripe Billing, Checkout, Portal (PD 01 s8) | Billing: new plans, credits, recharge, font fee (06) | Extend |
| Credits, seats, retention in `packages/core` | Billing (credits, seats); retention runs in each owning service | Extend |
| Telnyx phone verification | Dropped. SMS verification is not required (06 s1) | Dropped |
| pdf.js viewer with quote highlight | Web | As is |
| PD web UI and tabs | Web shell in the gateway. Overview, schedule, compliance matrix, outline, resumes, reviews, production, orals, and lessons become E2E features (09 s7) | Extend |
| PD plans (Free, Starter, Growth) | Dropped. E2E's plans replace them (06 s3) | Dropped |
| Evidence library on pp.shaavir.com | Not used. Each tenant's evidence lives in the evidence service | Replaced |
| Word Relay loop (`word-critic`, `relay-producer`) | Not used. Review and drafting run the patch loop on the server | Replaced |
| Word COM page count (`word-page-verify`) | Not used. Render's PDF check replaces it (01 s5.5) | Replaced |

## 4. Skills and the stage interface

Every stage runs behind one stage interface in `packages/stage-interface`. A stage handler declares its inputs, outputs, gate check, and skill version. The orchestrator calls handlers through that contract only.

Today's bid-autopilot skills sit behind the interface as placeholders. The Owner will rebuild each stage's skill later. A rebuilt skill swaps in without a change to the orchestrator or to any other stage. Each stage record stores the skill name and version it ran.

Skills live in the repo under `skills/{name}/SKILL.md`. Only tenant-neutral copies ship. No service reads a SKILL.md file except through the interface.

| Use | Skills | Service |
|---|---|---|
| Stage prompts | `amendment-gate`, `compliance-matrix` | Solicitation intel |
| Stage prompts | `rfp-format-lock`, `client-format-specs` | Render |
| Stage prompts | `scoresheet-first`, `proposal-outline-generator`, `proposal-response-writer`, `federal-proposal`, `exec-summary`, `federal-sled-pricing` | Drafting |
| Stage prompts | `evidence-capture`, `case-vignette` | Evidence, drafting |
| Reviews | `red-team-review` (separate reviewer model), `gold-white-review` | Review |
| Page checks before the content gate | `kill-words`, `plain-language`, `term-mirror`, `customer-focus`, `strength-test`, `story-placement` | Drafting |
| Rewritten as code | `word-page-verify` becomes render's PDF verifier | Render |
| Replaced | `bid-autopilot` (orchestrator state machine), `word-critic` and `relay-producer` (server-side patch loop) | Orchestrator, review |

Skill scripts are tools the model can call through render's toolrunner (01 s5.3). 04 maps each stage to its skills and scripts.

## 5. Data flow per stage

Detail lives in 04. This table shows which service runs each stage and what it leaves behind.

| Stage | Input | Service | Output stored |
|---|---|---|---|
| Intake fetch | Tenant repository, evidence, format spec | Evidence, intel | "We already have this" and "we still need this" lists, mandatory items marked |
| Document processing | Solicitation set | Ingest | Pages, text, page images, marking result |
| AI-ban check | Solicitation text | Intel (code first, model to confirm) | Flag with quote and page. The run continues |
| Shred and matrix | Pages | Intel (PD passes 1 to 6) | Requirements with quotes, "check these" list |
| Bid/no-bid scoring (Gate 0b) | Matrix, bid facts, repository coverage | Intel, evidence | Fit, eligibility, coverage, and risk scores. A human decides |
| Amendment gate | Uploads, eBuy mail, Drive additions | Intel, orchestrator | Amendment log or diff, reopened pages |
| Worksheet | Matrix, evaluation pages | Drafting | Blank Register, page and word budgets |
| Format lock | Instruction pages, format spec, shell, fonts | Render | Locked format spec, empty volume shells |
| Outline | Matrix, Blank Register, locked spec, shells | Drafting | Outline with page budgets inside the shells |
| Q&A draft | Matrix, ambiguous rows, questionnaire if given | Comms | Draft questions in the required format, draft email |
| Pink document | Outline, worksheet, matrix | Drafting, Drive | Pink review document in the tenant's Drive folder |
| Evidence, vignettes, agency intel | Tenant evidence, repository, official sources | Evidence, drafting, render (egress allow list) | Cited evidence picks, vignettes, agency notes |
| Drafting | Outline, evidence, locks | Drafting, in parallel by volume and section | Pages and blocks, NEEDs, per-page scores |
| Graphics | Call-outs in the draft | Drafting, model gateway, render | SVG source, PNG for Word, art from the image provider |
| Executive summary, pricing narrative | Drafted volumes, pricing inputs | Drafting | Draft text. Pricing figures wait for human approval |
| Red review | Assembled draft, scoresheet | Review | Findings, predicted rating per factor, ranked NEEDs. Gate 1 opens; billing consumes the credit |
| Gate 1 | Findings, NEEDs, scores | Review, drafting | Dispositions, filled NEEDs, locks on edited blocks |
| Re-draft and sweep | Dispositions, locks | Drafting | New page versions written around locked blocks |
| Assembly and render | Pages, shells, graphics, fonts | Render | DOCX with computed numbering, PDF, page images, page counts, layout findings |
| Gold and White Glove | Assembled volumes | Review | Gold record, production findings |
| Gate 2 | Round-by-round diff | Review | Sign-off |
| Package | Volumes, forms, attachments, matrix | Render | One download, named per the solicitation, with the signature and review notice |
| Request and collect (any time) | Request items | Comms, ingest | Sent requests, replies, uploaded items, status per item |

Every stage writes its record before it ends. A rerun with the same inputs hash reuses the stored output (01 s4).

## 6. Tenancy model

The identity service owns `tenant_id`. A tenant is one client firm, the offeror on its bids.

| Layer | Rule |
|---|---|
| Database | Every tenant table in every schema has `tenant_id` and `FORCE ROW LEVEL SECURITY`. Each transaction sets `app.tenant_id` locally. No setting, no rows |
| PD tables | PD's `org_id` holds the same value as `tenant_id`. `withTenant` sets both settings during the transition (09 s2) |
| Service boundary | Each service role can reach only its own schema. Cross-service reads go through APIs and events |
| Requests | The gateway forwards a signed token with `tenant_id`. Each service checks it before any read or write |
| Events | Every event carries `tenant_id`. A consumer sets it before it writes |
| Object storage | Every key starts with `tenant_id`. Signed links are short-lived and bound to a session, as in PD's viewing tokens |
| Model calls | One tenant's text per call. Skill instructions sit before the cache breakpoint and hold no tenant data |
| Render jobs | One tenant per container. Fonts, shells, and format specs mount from that tenant only |
| Evidence and repository | Per tenant. Never searched, ranked, embedded, or learned across tenants |
| Learning loop | Dispositions, filled NEEDs, and award outcomes tune that tenant's own retrieval and gate calibration only |
| Mailbox, Drive, inbound address, portal sessions | One tenant each, as before |

Tests carry over from PD (PD 02 s4): user A gets 404 on every endpoint with user B's ids, and a pool of one connection never leaks rows between tenants. Added: a service role cannot read another service's schema, and a render job for tenant A cannot list tenant B's fonts or files.

## 7. Integrations

### 7.1 Email: Gmail and Microsoft 365

| Item | Design |
|---|---|
| Owner | The comms service |
| Connect | A tenant Admin connects a Gmail or Microsoft 365 mailbox through OAuth in settings |
| Transport | Comms calls the email MCP server's tools from code |
| Send | Q&A goes only after a human reviews the questions and the email, then clicks send. Proposed: each request email takes the same click (🟨 **OPEN**, 07 s3). The model drafts; code sends. No model call can trigger a send |
| Q&A | Draft questions in the required format, a filled agency questionnaire when one exists, and a draft email. All three shown for review (05 s4.5) |
| Requests | Commitment letters, partner past performance forms, resume consents. One thread per item |
| Replies | Comms polls the connected mailbox for replies on threads it started. Attachments go to ingest |
| Scope | Searches cover only the tool's own thread ids |
| Upload option | A user can also upload any item by hand. Status tracks either route |
| Tokens | Comms stores OAuth refresh tokens encrypted per tenant. A tenant Admin can revoke them in settings |

🟨 **OPEN:** which email MCP servers (hosted or self-run) and the narrowest scopes each needs. 🟨 **OPEN:** confirm that storing mailbox OAuth tokens fits the credentials rule (07 s2).

### 7.2 Shaavir Drive

| Item | Design |
|---|---|
| Owner | The Drive service |
| Folder | One per tenant, created on `identity.tenant.created`, shared only with that tenant's users |
| Contents | The Pink review document and working documents for each bid |
| Write | Drive writes a new version when a stage produces one |
| Read back | Drive picks up tenant edits and added files and sends them to ingest. An edited block becomes a locked block (04 s8) |
| Copy | The tool keeps its own copy of every document it puts in Drive |
| Disclosure | The privacy notice states that Shaavir's Drive stores client data (07 s8) |

🟨 **OPEN:** Drive's interface for folders, sharing, versions, and change notices.

### 7.3 eBuy inbound

1. Each tenant gets an inbound address, such as `tenantname@in.<tool domain>`.
2. The tenant adds it in eBuy or sets a forwarding rule.
3. The inbound mail service posts each message to comms. Comms checks the sender, parses the RFQ number, and emits `comms.ebuy.rfq_received`. Intel opens a bid for that tenant.
4. Documents come in through the existing eBuy connector, or through the portal agent with a login the user approves. Either way they enter ingest.
5. A daily check covers missed emails, through the same connector or the portal agent.

🟨 **OPEN:** nobody has yet verified how a tenant registers its address in eBuy. Test on one tenant first.

🟨 **OPEN:** how the daily check authenticates per tenant. The existing connector holds one login, and the tool stores no portal credentials (07 s2). Proposed: the daily check runs through the portal agent with a user-approved login until the connector supports per-tenant sessions without stored secrets.

### 7.4 Portals

Users choose one route per portal:

| Route | How |
|---|---|
| (a) Agent | The portal agent checks the portal and downloads documents. The human approves each login and MFA prompt in a live view. Credentials are never stored |
| (b) Upload | The user uploads the files |
| Banned portals | SAM.gov bans bots, so it gets upload or a guided checklist only. The same holds for any portal that bans automation |
| Final submit | Always a human's click |

The portal agent host and its controls are in 01 s7. 🟨 **OPEN:** the agent implementation.

SAM.gov also publishes public APIs for opportunity notices, attachments, and entity data, used with an API key. Those are not browser automation. 🟨 **OPEN:** whether the tool pulls opportunity attachments through that API, within its terms and daily quota.

### 7.5 Model providers

All model and image calls go through the model gateway. Anthropic covers drafting, checks, vision, and the portal agent. A separate reviewer model covers Red (🟨 **OPEN** which). GPT Image 2 makes illustrative art only. The gateway meters every call and enforces the run's budget (01 s6; 01 s8).

## 8. API outline

The gateway exposes PD's endpoints (PD 02 s7) and the areas below, prefix `/api`. Each route forwards to its owning service.

| Area | Endpoints | Service |
|---|---|---|
| Auth | `/auth/*` (OIDC sign-in with Zitadel, which hosts the MFA, passkey, and SSO screens), `/members`, `/invites` | Identity |
| Intake | `GET /bids/:id/intake`, `POST /bids/:id/intake/items` | Intel, evidence |
| Bid/no-bid | `GET /bids/:id/fit`, `POST /bids/:id/fit/decision` | Intel, orchestrator |
| Runs | `POST /bids/:id/runs/estimate`, `POST /bids/:id/runs`, `GET /runs/:id`, `POST /runs/:id/pause`, `/resume`, `/cancel` | Orchestrator |
| Stages | `GET /runs/:id/stages`, `POST /stages/:id/retry` | Orchestrator |
| Gates | `GET /runs/:id/gates/:gate`, `POST /runs/:id/gates/:gate/approve` | Orchestrator |
| Pages and blocks | `GET /runs/:id/pages`, `GET /pages/:id`, `PATCH /blocks/:id` (edit locks the block), `POST /blocks/:id/unlock`, `POST /change-proposals/:id/approve`, `/reject` | Drafting |
| Findings | `GET /runs/:id/findings`, `POST /findings/:id/disposition` | Review |
| NEEDs | `GET /runs/:id/needs`, `PATCH /needs/:id` (fill) | Drafting |
| Round diff | `GET /runs/:id/diff?from=&to=` | Review |
| Q&A | `GET /bids/:id/qa`, `PATCH /qa/:id`, `POST /qa/:id/approve-send` | Comms |
| Requests | `GET /bids/:id/requests`, `POST /bids/:id/requests`, `POST /requests/:id/approve-send`, `POST /requests/:id/upload` | Comms |
| Packages | `POST /runs/:id/package`, `GET /packages/:id`, `GET /packages/:id/download` | Render |
| Repository | `GET /repo?agency=&factor=&section_type=&contract=&from=&to=`, `GET /repo/:id` | Evidence |
| Fonts | `GET /fonts`, `POST /fonts/requests` (upload plus license confirmation) | Render, billing |
| Connections | `POST /connections/mailbox`, `DELETE /connections/mailbox/:id`, `GET /connections/drive` | Comms, Drive |
| Portals | `POST /portal-sessions`, `GET /portal-sessions/:id/live`, `POST /portal-sessions/:id/stop` | Portal agent |
| Inbound | `POST /inbound/mail` (signed webhook from the inbound mail service) | Comms |
| Billing | `/billing/*` | Billing |

Internal, private network only: render's `/tools/{name}`, the model gateway's `/v1/messages` and `/v1/images`, identity's `/tokens/verify`, billing's `/credits/*`, and evidence's `/ledger/*` for the ledger scripts.

## 9. Code layout

The repo layout, the restructure steps, the CLAUDE.md rules, and the local stack with its environment variables live in 09 s5, 09 s6, 09 s8, and 09 s9.

## Decision log

| Date | Decision |
|---|---|
| 17 Oct 2026 | PD's stack carries over; orchestrator in TypeScript, toolrunner in Python on the render server |
| 17 Oct 2026 | The conductor skill becomes the orchestrator's state machine; server-side code replaces the Word Relay loop and Word COM verify |
| 17 Oct 2026 | pp.shaavir.com evidence library not used; each tenant's evidence lives in the tool behind row-level security |
| 17 Oct 2026 | Email goes through the tenant's Gmail or Microsoft 365 connection; code sends only after human approval; the tool reads only its own threads |
| 17 Oct 2026 | Shaavir Drive holds Pink and working documents in one folder per tenant; the tool keeps its own copy |
| 17 Oct 2026 | eBuy inbound by per-tenant address plus a daily check; test on one tenant first |
| 17 Oct 2026 | Portals by agent with human-approved login, or by upload; SAM.gov upload or checklist only; final submit always human |
| 17 Oct 2026 | Review pass: request email send marked Proposed; eBuy daily-check authentication and SAM.gov public API added as OPEN |
| 17 Oct 2026 | Owner decision: microservices. Fifteen services on one Postgres cluster with a schema per service and row-level security in each, events on NATS, S3-compatible storage (09) |
| 17 Oct 2026 | Owner decision, then owner updates: E2E absorbs PD entirely. PD's code becomes E2E services and features; no PD lighter UI. One deployment question closed |
| 17 Oct 2026 | Owner decision: the PD repo is renamed to E2E Proposal and becomes the monorepo; no new repo, no code copy |
| 17 Oct 2026 | Owner decision: the identity service owns `tenant_id`; PD's `org_id` maps to it. Telnyx SMS verification dropped |
| 17 Oct 2026 | Owner decision: PD reuse map settled by service (s3; 09 s4) |
| 17 Oct 2026 | Owner decision: stages run behind one stage interface; current skills are placeholders until the Owner rebuilds them |
| 17 Oct 2026 | Owner decision: AI-ban hit flags and lets the run continue |
| 17 Oct 2026 | Owner decision: events on Redis Streams, on the self-hosted Redis that BullMQ uses. NATS dropped (item 60 closed) |
| 17 Oct 2026 | Owner decision: self-hosted Zitadel behind the identity service; PD's password and session code retires (item 61 closed) |

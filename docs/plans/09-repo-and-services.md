# 09: Repo and Services

**Status:** Draft v1 · 17 Oct 2026

This file defines the E2E Proposal services, the platform rules under them, and the repository that holds them. 02 gives the system view. This file gives each service's contract. PD plan references read as (PD 02 s4).

## 1. Shape

E2E Proposal runs as microservices. Each service owns its data, its API, and its events. No service reads another service's tables. Services talk over HTTP for commands and queries, and over the event bus for facts that already happened.

E2E absorbs PD entirely. The PD repo itself becomes the E2E monorepo, renamed to E2E Proposal. PD's code becomes E2E's ingest, solicitation intel, identity, and billing services, the web shell, and `infra/`. PD's tabs become E2E features. PD does not survive as a separate app (s6; s7).

## 2. Platform rules

| Item | Rule |
|---|---|
| Database | One Postgres 16 cluster. One schema per service, named after the service. Each service connects with its own role, granted on its own schema only. Zitadel keeps its own database in the same cluster, under its own role |
| Tenancy | Every tenant table carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. Each transaction sets `app.tenant_id`. No setting, no rows (PD 02 s4) |
| PD mapping | PD's `org_id` holds the same UUID as `tenant_id`. Until PD's tables rename the column, `withTenant` in `packages/core` sets both `app.tenant_id` and `app.org_id`, so PD's RLS policies keep working |
| Tenant owner | The identity service issues every `tenant_id`. No other service creates one |
| Events | Redis Streams: decided. Events run on the self-hosted Redis container already in the stack, which BullMQ uses. No NATS. A hosted Redis free tier is too small for production |
| Event rules | Decided 17 Oct 2026: each service writes events to an `outbox` table in its own transaction, and a relay publishes them with `XADD` and marks the row sent. Each consuming service reads through its own consumer group, acknowledges with `XACK` after its write commits, and dedupes on event id. A reclaim job takes over entries left pending by a dead consumer. Every event carries `tenant_id`, `event_id`, `schema_version`, and `occurred_at`. Redis AOF can lose up to one second on a crash; the outbox relay re-publishes, item 68 (01 s4; 00 s7) |
| Stream names | `e2e.<service>.<entity>.<verb>`, for example `e2e.review.red.delivered`. These plans drop the `e2e.` prefix when they name an event |
| Object storage | S3-compatible. Every key starts with `tenant_id`, then the owning service (03 s11) |
| Service auth | Proposed: the gateway forwards a short-lived token signed by the identity service, carrying `tenant_id`, user id, and roles. Service-to-service calls add mutual TLS on the private network |
| Containers | One container per service. Deploys use PD's hosting adapters (`ovh-us`, `hetzner`, `ssh`) and compose files (PD 01 s9) |
| Contracts | OpenAPI files and event JSON schemas live in `packages/contracts`. A contract changes first, in its own commit, before any service code that uses it |
| Queues inside a service | PD's BullMQ on Redis stays inside ingest and solicitation intel. Other services use Redis Streams consumer groups as work queues |

## 3. Service catalog

| # | Service | Language | Runs on (01 s2) | PD source |
|---|---|---|---|---|
| 1 | Gateway and web | TypeScript | App role | `apps/api` routing and security, `apps/web` |
| 2 | Identity and tenancy | TypeScript, plus the Zitadel container | App role | `apps/api` org, members, and invites; `packages/core` tenant code. Zitadel replaces PD's password and session code |
| 3 | Billing | TypeScript | App role | `apps/api` billing and credits, `apps/worker` credit gate, `packages/core` credits and seats |
| 4 | Ingest | TypeScript, plus PD's sandbox image | App role | `apps/api` uploads and documents, `apps/worker` file jobs, `apps/sandbox`, `infra/sandbox-runner` |
| 5 | Solicitation intel | TypeScript | App role | `apps/api` bids, amendments, tabs; `apps/worker` AI and amendment jobs; `packages/ai` compliance pipeline |
| 6 | Orchestrator | TypeScript | App role | `apps/worker` enqueue and job ids; mostly new |
| 7 | Model gateway | TypeScript | App role | `packages/ai` providers and active model |
| 8 | Drafting | TypeScript | App role | New |
| 9 | Review | TypeScript | App role | PD review and finding tables |
| 10 | Render | Python | Render role | None. bid-autopilot scripts |
| 11 | Evidence and repository | TypeScript | App role | PD resume matrix tables |
| 12 | Comms | TypeScript | App role | None |
| 13 | Portal agent | Python | Portal agent role | None |
| 14 | Drive | TypeScript | App role | None |
| 15 | Notifications and audit | TypeScript | App role | PD `audit_log` |

## 4. Services

Tables name the service's own schema. Section numbers in 03 hold the columns.

### 4.1 Gateway and web

| Item | Detail |
|---|---|
| Owns | Public routes, request auth check, rate limits, screen composition, live run updates, chunked upload pass-through, the E2E web app with PD's tabs as features (s7) |
| API | The public `/api` surface (02 s8). It calls the owning service for each route and never writes data itself |
| Events in | `orchestrator.run.*`, `orchestrator.stage.*`, `orchestrator.gate.*`, `drafting.page.gated`, `notification.created`, for live updates over server-sent events |
| Events out | None |
| Tables | None. Stateless |
| Language | TypeScript: Fastify for the BFF, React with Vite for web |
| PD source | `apps/api` app, security, and scope code; `apps/web` as the web shell |

### 4.2 Identity and tenancy

| Item | Detail |
|---|---|
| Owns | Tenants and `tenant_id`, the Zitadel organization per tenant, the user mirror, memberships, roles, invites, SSO connection records, service tokens. Zitadel owns passwords, sessions, MFA factors, passkeys, and identity providers |
| Sign-in | Work email, then MFA by authenticator app (TOTP) or passkey. Google and Microsoft SSO for every plan. SAML SSO for Enterprise. No SMS verification (06 s1) |
| API | `/auth/*` (OIDC code flow against Zitadel), `/tenants`, `/members`, `/invites`; internal `/tokens/verify` and a JWKS endpoint. Zitadel's own login, MFA, and SSO screens serve the browser directly |
| Events in | `billing.subscription.changed` (suspend or restore a tenant); Zitadel user and organization events over its event API or webhook, to keep the mirror current |
| Events out | `identity.tenant.created`, `identity.tenant.suspended`, `identity.user.joined`, `identity.user.removed`, `identity.role.changed` |
| Tables | `tenants`, `users` (mirror), `memberships`, `invites`, `sso_connections`, `org_map` (PD `org_id` to `tenant_id`, same value). The split with Zitadel's database is Proposed, item 67 (03 s2; 00 s7) |
| Language | TypeScript |
| PD source | `apps/api` auth, org, and context code; `packages/core` tenant code (`withOrg`, memberships, tenant role checks) |

Decided 17 Oct 2026: the identity service runs self-hosted Zitadel on the shared Postgres cluster, pinned by version and unmodified where possible. Zitadel handles MFA, passkeys, Google and Microsoft sign-in, and SAML. Our identity service wraps it, maps one Zitadel organization to each `tenant_id`, and keeps PD's invites, roles, and seats logic. Zitadel's current releases carry AGPL-3.0; confirm the pinned release's license file at install (07 s11). Any change to Zitadel's own source gets published on our site under AGPL. Our services talk to it over its APIs, so our code stays ours (item 61 in 00 s7).

### 4.3 Billing

| Item | Detail |
|---|---|
| Owns | Plans, subscriptions, seats, proposal credits, recharges, font fees, Stripe webhooks, usage roll-ups for pricing |
| Credit rule | Reserve at run start. Release on no-bid at Gate 0b, and when a run fails or is cancelled before the Red draft. Consume when the Red draft reaches the tenant at Gate 1 (06 s4) |
| API | `/billing/*`; internal `/credits/reserve`, `/credits/consume`, `/credits/release` |
| Events in | `orchestrator.run.started`, `orchestrator.gate.decided` (no-bid), `orchestrator.run.failed`, `orchestrator.run.cancelled`, `review.red.delivered`, `modelgw.usage.metered`, `identity.tenant.created` |
| Events out | `billing.credit.reserved`, `billing.credit.consumed`, `billing.credit.released`, `billing.subscription.changed` |
| Tables | `subscriptions`, `proposal_credits`, `charges`, `stripe_events`, `run_usage` |
| Language | TypeScript |
| PD source | `apps/api` billing and credits; `apps/worker` credit gate; `packages/core` credits, seats, and plan limits |

### 4.4 Ingest

| Item | Detail |
|---|---|
| Owns | Uploads, upload sessions, documents, solicitation pages, ClamAV scan, sandbox convert, text extraction, OCR, marking check, classify, chunk, pre-scan, file retention |
| API | `/uploads`, `/documents`, `/documents/:id/pages` |
| Events in | `comms.attachment.received`, `portal.file.downloaded`, `drive.file.added` |
| Events out | `ingest.document.ingested`, `ingest.document.held` (marking), `ingest.document.classified` |
| Tables | `documents`, `upload_sessions`, `pages`, `archive_objects`, `jobs` |
| Language | TypeScript; the sandbox image as in PD |
| PD source | `apps/api` uploads and documents; `apps/worker` file job and steps; `apps/sandbox`; `infra/sandbox-runner`; `packages/ai` document processor |

### 4.5 Solicitation intel

| Item | Detail |
|---|---|
| Owns | Bids and the solicitation key, bid facts, shred, compliance matrix, quote matching, dates and schedule, amendment key check and diff, glossary and search terms, AI-ban check, bid/no-bid scores |
| API | `/bids`, `/bids/:id/matrix`, `/bids/:id/amendments`, `/bids/:id/fit`, `/bids/:id/schedule` |
| Events in | `ingest.document.classified`, `comms.ebuy.rfq_received` |
| Events out | `intel.shred.done`, `intel.amendment.diffed`, `intel.ai_ban.flagged`, `intel.fit.scored`, `intel.schedule.changed` |
| Tables | `bids`, `bid_facts`, `compliance_rows`, `schedule_activities`, `amendments`, `amendment_links`, `outline_items`, `production_items`, `personnel_requirements`, `glossary_terms`, `search_terms`, `bid_scores`, `intake_items` |
| Language | TypeScript |
| PD source | `apps/api` bids, amendments, and tabs; `apps/worker` AI and amendment jobs; `packages/ai` compliance pipeline; `packages/core` amendment numbers, amendment tabs, schedule |

### 4.6 Orchestrator

| Item | Detail |
|---|---|
| Owns | The run state machine, stages, gates, resume, stage leases and run locks, the cost cap, the stage interface |
| Stage interface | Each stage is a handler with one contract: inputs, outputs, gate check, and skill version. Today's bid-autopilot skills sit behind it as placeholders. The Owner rebuilds each stage's skill later without touching the orchestrator (04 s4) |
| Cost cap | Owns the cap value and the pause. It pushes each run's budget to the model gateway, which checks every call (01 s8) |
| API | `/runs`, `/runs/:id/stages`, `/stages/:id/retry`, `/runs/:id/gates/:gate` |
| Events in | `intel.shred.done`, `intel.amendment.diffed`, stage results from services 5, 8, 9, 10, 11, and 12, `modelgw.budget.exhausted`, `billing.credit.*` |
| Events out | `orchestrator.run.started`, `orchestrator.stage.requested`, `orchestrator.stage.done`, `orchestrator.stage.failed`, `orchestrator.gate.opened`, `orchestrator.gate.decided`, `orchestrator.run.paused`, `orchestrator.run.failed`, `orchestrator.run.cancelled`, `orchestrator.run.done`, `orchestrator.run.budget_set` |
| Tables | `runs`, `stages`, `gates`, `tool_calls`, `run_artifacts`, `cost_ledger` |
| Language | TypeScript |
| PD source | `apps/worker` enqueue and job id code; `packages/core` job ids |

### 4.7 Model gateway

| Item | Detail |
|---|---|
| Owns | Provider adapters (Anthropic, the reviewer model, the image provider; PD's DeepInfra and Ollama for development), rate buckets, metering, prompt cache layout, the reviewer-differs-from-drafter check |
| API | Internal only: `/v1/messages` and `/v1/images`, each call tagged with `tenant_id`, run, stage, and role |
| Events in | `orchestrator.run.budget_set`, `orchestrator.run.done` |
| Events out | `modelgw.usage.metered`, `modelgw.budget.exhausted` |
| Tables | `ai_runs`, `ai_settings`, `provider_settings`, `run_budgets` |
| Language | TypeScript |
| PD source | `packages/ai` providers and active model; PD's `ai_runs` |

### 4.8 Drafting

| Item | Detail |
|---|---|
| Owns | Worksheet, outline, volumes, sections, the Blank Register, draft pages, blocks and block locks, block versions, change proposals, page checks, the 90% page gate, strengths, claims, citations, visuals, vignettes, NEEDs. Stages: worksheet, outline, pink (with Drive), evidence (with the evidence service), agency intel, draft, visuals, executive summary, pricing, recovery, sweep (04 s3) |
| API | `/runs/:id/pages`, `/pages/:id`, `/blocks/:id`, `/change-proposals/:id`, `/runs/:id/needs`, `/needs/:id` |
| Events in | `orchestrator.stage.requested`, `review.finding.disposed`, `comms.request.received`, `evidence.item.confirmed` |
| Events out | `drafting.page.gated`, `drafting.section.drafted`, `drafting.need.opened`, `drafting.need.filled`, `drafting.round.done` |
| Tables | `volumes`, `proposal_sections`, `blanks`, `draft_pages`, `blocks`, `block_versions`, `change_proposals`, `page_checks`, `strengths`, `claims`, `citations`, `visuals`, `evidence_links`, `vignettes`, `needs` |
| Language | TypeScript. Scripts run through the render service's toolrunner |
| PD source | None |

### 4.9 Review

| Item | Detail |
|---|---|
| Owns | Red review on the reviewer model, Gold Team, White Glove, findings, dispositions, predicted factor ratings, the round diff |
| API | `/runs/:id/findings`, `/findings/:id/disposition`, `/runs/:id/diff` |
| Events in | `orchestrator.stage.requested` |
| Events out | `review.red.delivered` (Gate 1 opens; billing consumes the credit), `review.finding.disposed`, `review.gold.done` |
| Tables | `reviews`, `review_findings`, `dispositions`, `factor_ratings` |
| Language | TypeScript |
| PD source | PD `reviews` and `review_findings` tables and review scoring task |

### 4.10 Render

| Item | Detail |
|---|---|
| Owns | The toolrunner and script containers, the format lock stage, format specs and shells, fonts and font requests, python-docx assembly, code-computed numbering, DOCX to PDF, rasterize, page geometry, page count, packages |
| Numbering | Code computes the contents table, caption numbers, and cross-reference text, and writes the results into the DOCX. LibreOffice headless (MPL 2.0) renders DOCX to PDF. No field refresh runs (01 s5.1) |
| Fonts | Linux only, so it ships metric-compatible open fonts in place of Microsoft fonts (01 s5.4) |
| API | Internal: `/tools/{name}`, `/render`, `/packages`; public through the gateway: `/fonts`, `/fonts/requests`, `/packages/:id/download` |
| Events in | `orchestrator.stage.requested` (format lock, assembly, render and verify, package) |
| Events out | `render.done`, `render.issue.found`, `render.package.ready` |
| Tables | `format_specs`, `client_shells`, `tenant_fonts`, `font_requests`, `renders`, `render_issues`, `packages`, `package_files`, `signature_items` |
| Language | Python 3.12, FastAPI, in the uv workspace |
| PD source | None. The 29 bid-autopilot scripts and 7 prose scripts (01 s5.3) |

### 4.11 Evidence and repository

| Item | Detail |
|---|---|
| Owns | Evidence documents, contracts, evidence items, the needs register, repository items with pgvector embeddings, intake fetch ("have" and "need"), outcomes, learning events, gate calibration, the internal evidence API for ledger scripts |
| API | `/repo`, `/repo/:id`, `/evidence`, `/bids/:id/intake/fetch`; internal `/ledger/*` |
| Events in | `ingest.document.ingested` (evidence kinds), `render.package.ready` (harvest), `drafting.need.filled` (register), outcome entries |
| Events out | `evidence.item.staged`, `evidence.item.confirmed`, `evidence.repo.item_added` |
| Tables | `evidence_documents`, `contracts`, `evidence_items`, `needs_register`, `repo_items`, `repo_embeddings`, `candidates`, `resume_matches`, `outcomes`, `learning_events`, `gate_calibration` |
| Language | TypeScript |
| PD source | PD `candidates` and `resume_matches` |

### 4.12 Comms

| Item | Detail |
|---|---|
| Owns | Gmail and Microsoft 365 connections and their tokens, Q&A drafting and send, request and collect, reply polling, outbound and inbound email, eBuy inbound and the daily check |
| API | `/bids/:id/qa`, `/qa/:id/approve-send`, `/bids/:id/requests`, `/requests/:id/approve-send`, `/connections/mailbox`, `/inbound/mail` |
| Events in | `orchestrator.stage.requested` (Q&A draft), `drafting.need.opened` (request candidates), `intel.schedule.changed` |
| Events out | `comms.email.sent`, `comms.request.received`, `comms.attachment.received`, `comms.ebuy.rfq_received` |
| Tables | `mail_connections`, `oauth_tokens`, `outbound_emails`, `inbound_messages`, `qa_sets`, `qa_questions`, `third_party_requests`, `request_replies`, `ebuy_checks` |
| Language | TypeScript |
| PD source | None |

### 4.13 Portal agent

| Item | Detail |
|---|---|
| Owns | Portal sessions, the live view, per-session allow lists, downloads to the drop folder |
| API | `/portal-sessions`, `/portal-sessions/:id/live`, `/portal-sessions/:id/stop` |
| Events in | None |
| Events out | `portal.session.ended`, `portal.file.downloaded` |
| Tables | `portal_sessions`. No credential column exists |
| Language | Python, in the uv workspace. Model calls go through the model gateway |
| PD source | None |

### 4.14 Drive

| Item | Detail |
|---|---|
| Owns | One Shaavir Drive folder per tenant, sharing, the Pink document and working documents, read-back of tenant edits |
| API | `/connections/drive`, internal `/drive/write` |
| Events in | `identity.tenant.created`, `identity.user.joined`, `identity.user.removed`, `orchestrator.stage.done` (Pink) |
| Events out | `drive.file.added`, `drive.doc.edited` |
| Tables | `drive_folders`, `drive_documents` |
| Language | TypeScript |
| PD source | None |

### 4.15 Notifications and audit

| Item | Detail |
|---|---|
| Owns | In-app notifications, email notifications, alerts and deadlines, the append-only audit log |
| API | `/notifications`, `/audit` (Admin only) |
| Events in | Every subject. It writes each auditable event to the log |
| Events out | `notification.created` |
| Tables | `notifications`, `alerts`, `audit_log` |
| Language | TypeScript |
| PD source | PD `audit_log` and its action list |

## 5. Repository

E2E Proposal lives in the existing PD GitHub repo (`pd` under the vendor's account, local clone `C:\Tools\PD`), renamed to E2E Proposal. GitHub redirects the old URL. History, CI, the secret scan, hooks, infra tests, and the open PR branches all stay. `C:\Tools\E2E` holds working files only, never code. The layout below is the target after the restructure PR (s6).

```
E2E Proposal repo (renamed from pd; local C:\Tools\PD)
├── CLAUDE.md                 rules for every session (s8)
├── package.json              pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── pyproject.toml            uv workspace root
├── services/
│   ├── gateway/              service 1 (BFF) and the web app, built from PD's web shell
│   ├── identity/             service 2
│   ├── billing/              service 3
│   ├── ingest/               service 4, with PD's sandbox image
│   ├── intel/                service 5
│   ├── orchestrator/         service 6
│   ├── modelgw/              service 7
│   ├── drafting/             service 8
│   ├── review/               service 9
│   ├── evidence/             service 11
│   ├── comms/                service 12
│   ├── drive/                service 14
│   └── notify/               service 15
├── python/
│   ├── render/               service 10 (FastAPI, toolrunner, scripts)
│   └── portal-agent/         service 13
├── packages/
│   ├── contracts/            OpenAPI files and event JSON schemas
│   ├── core/                 PD's packages/core, in place (s6)
│   ├── ai/                   PD's packages/ai, in place (s6)
│   ├── stage-interface/      the stage handler contract and the skill loader
│   └── testing/              tenant fixtures, contract test helpers
├── skills/                   tenant-neutral skill copies, versioned
├── infra/                    PD's: hosting adapters, compose, LUKS, Borg and B2, infra tests; plus zitadel/ (pinned image, config)
├── evals/                    the 10-RFP test harness and golden sets
└── docs/plans/               these plans; PD's plans under docs/plans/archive-pd/
```

- TypeScript services use pnpm and Turbo, as PD does.
- Python services share one uv workspace and lock file.
- Each service has its own Dockerfile, migrations folder, and tests.

## 6. Turning the PD repo into E2E

The PD repo becomes E2E in place. No code is copied, no commit is pinned, and no parity check runs.

1. Rename the PD GitHub repo (`pd`) to E2E Proposal. GitHub redirects the old URL, so clones and links keep working. The local clone stays at `C:\Tools\PD`.
2. Keep history, CI, the secret scan, hooks, and infra tests as they are.
3. Finish PD's open PRs #35 to #38 in this repo, in PD's handoff order: #37, #35, #36, then #38. Proposed: land all four before the restructure PR, since moving paths first would force a rebase of each.
4. The first E2E PR restructures the repo. Its description records the path map below; no separate migration note exists.
   - `apps/*` move into `services/*`, and new service folders join them.
   - `packages/core` and `packages/ai` stay under `packages/`.
   - `python/` starts as a uv workspace for render and the portal agent.
   - CLAUDE.md is rewritten from the outline in s8.
   - The E2E plans move into `docs/plans/`. PD's plans move to `docs/plans/archive-pd/`.
   - Any PD-to-E2E parity check is removed.
5. `C:\Tools\E2E` holds working files only: scratch notes, test RFPs, exports. It never holds code.

| PD path | E2E home after the restructure |
|---|---|
| `packages/core` | `packages/core` (tenancy, credits, seats, retention, schema helpers) |
| `packages/ai` | `packages/ai` (providers serve `services/modelgw`; the compliance pipeline serves `services/intel`) |
| `apps/api` auth, org, context | `services/identity` |
| `apps/api` billing, credits; `apps/worker` credit gate | `services/billing` |
| `apps/api` uploads, documents; `apps/worker` file jobs; `apps/sandbox`; `infra/sandbox-runner` | `services/ingest` |
| `apps/api` bids, amendments, tabs; `apps/worker` AI and amendment jobs | `services/intel` |
| `apps/api` app, security, scope; `apps/web` | `services/gateway` (BFF and web shell) |
| `infra/` | `infra/` |
| `docs/plans` | `docs/plans/archive-pd/` |

## 7. PD tabs as E2E features

| PD tab | E2E feature | Owning service |
|---|---|---|
| Overview | Bid overview screen | Gateway, over intel |
| Schedule | Schedule and deadlines | Intel |
| Compliance matrix | Compliance matrix | Intel |
| Outline | Outline, fed into the outline stage | Drafting |
| Resumes | Resumes and candidate matching | Evidence |
| Reviews | Review screens (Gate 1, Gate 2, findings) | Review |
| Production | Production rules and the package checklist | Render |
| Orals | Orals preparation | Drafting |
| Lessons | Lessons learned, fed into the learning loop | Evidence |

PD's Free, Starter, and Growth plans are dropped. E2E's plans replace them (06 s3).

## 8. CLAUDE.md outline

The repo's CLAUDE.md holds these rules. Every Claude Code session reads it first.

1. **Who edits what.** Each service folder names its owner in a CODEOWNERS file. A session works inside one service folder plus `packages/contracts`. Shared packages change only in their own PR.
2. **One service per PR.** A PR touches one service. A contract change goes in its own PR, merged before the services that use it.
3. **Contracts first.** Change the OpenAPI file or event schema in `packages/contracts` first. Then regenerate types. Then change the service.
4. **`tenant_id` on every query.** Every query runs inside `withTenant`. A query without it fails review. Tests cover a second tenant on every endpoint.
5. **No cross-service database access.** A service reads only its own schema. It gets other data through an API call or an event.
6. **Tests and typecheck before commit.** Run the service's tests, `pnpm typecheck`, and the contract tests. Python runs `uv run pytest` and the type checker.
7. **Skills load through the stage interface.** No service reads a SKILL.md file directly. The stage interface loads it and records its version.
8. **No PD side copy.** PD's code lives in this repo only. Nothing keeps a copy in sync, and no parity check runs.
9. **Writing rules.** No em dashes. Sentences of 30 words or fewer, varied in length. Active voice.
10. **Secrets.** None in git. Keys live only in the model gateway's environment.

## 9. Local development and configuration

Proposed. This section gives a Claude Code session enough to boot Phase 0 and build Phase 1 without guessing.

### 9.1 Local stack

The file `infra/compose/local.yml` starts Postgres 16 with pgvector, Zitadel (pinned image), and Redis 7 (`appendonly yes`, `maxmemory-policy noeviction`). It also starts MinIO as the S3-compatible store, ClamAV, and the sandbox image. One command boots it: `docker compose -f infra/compose/local.yml up`. Then `pnpm dev` starts every TypeScript service with Turbo. The Python services start with `uv run render` and `uv run portal-agent`. Every service answers `GET /healthz` with its name, version, and schema migration level.

### 9.2 Environment variables

Each service reads a `.env` from its own folder; `.env.example` ships in git, `.env` never does. Names follow `<SERVICE>_<SETTING>`.

| Variable | Who | Meaning |
|---|---|---|
| `<SERVICE>_DATABASE_URL` | Every service | Connection as that service's role, `search_path` set to its own schema |
| `REDIS_URL` | Every service | Streams, consumer groups, BullMQ, and rate buckets |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Ingest, render, evidence, drafting | Object storage; MinIO locally |
| `IDENTITY_ZITADEL_URL`, `IDENTITY_ZITADEL_CLIENT_ID`, `IDENTITY_ZITADEL_SERVICE_KEY` | Identity | OIDC issuer, the web app's client, and the service account for the management API |
| `GATEWAY_JWKS_URL` | Gateway and every service | Where to fetch the signing keys for request tokens |
| `MODELGW_ANTHROPIC_API_KEY`, `MODELGW_REVIEWER_API_KEY`, `MODELGW_IMAGE_API_KEY` | Model gateway only | Provider keys. Root-only env file in production (01 s6) |
| `BILLING_STRIPE_SECRET_KEY`, `BILLING_STRIPE_WEBHOOK_SECRET` | Billing | Stripe test keys locally |
| `COMMS_INBOUND_WEBHOOK_SECRET` | Comms | Verifies the inbound mail webhook |
| `RENDER_TOOLRUNNER_URL`, `BID_LEDGER_URL` | Drafting, review, render scripts | Tool calls and the ledger API (01 s5.3) |
| `APP_SETTINGS_SCHEMA` | Every service | The shared `app` schema name for `app_settings` (03 s10) |

### 9.3 Migrations

Each service keeps `migrations/` in its own folder and migrates only its own schema. The command `pnpm migrate` runs them in a fixed order, because later schemas carry ids that earlier services issue. The order: `app`, `identity`, `billing`, `ingest`, `intel`, `orchestrator`, `modelgw`, `drafting`, `review`, `render`, `evidence`, `comms`, `portal`, `drive`, `notify`. No migration references another schema. Each migration ends by creating the schema's `outbox` table if it is missing. Zitadel migrates its own database on start.

### 9.4 Contracts and tests

The folder `packages/contracts` holds one OpenAPI file per service and one JSON schema per event, both versioned. A PR fails `pnpm contracts:check` when its service code drifts from its contract. The folder `packages/testing` ships two tenant fixtures and a helper that runs every endpoint as tenant B with tenant A's ids. Phase 0 is done when the skeletons pass these with empty handlers (08 Phase 0).

## Decision log

| Date | Decision |
|---|---|
| 17 Oct 2026 | E2E Proposal runs as 15 microservices on one Postgres cluster, one schema per service, row-level security in each |
| 17 Oct 2026 | The identity service owns `tenant_id`; PD's `org_id` maps to it with the same value |
| 17 Oct 2026 | Events on NATS JetStream, Proposed, with Redis Streams as the fallback; S3-compatible object storage; one container per service on PD's hosting adapters |
| 17 Oct 2026 | Render and portal agent in Python; every other service in TypeScript |
| 17 Oct 2026 | One monorepo: pnpm and Turbo for TypeScript, a uv workspace for Python. Work starts now |
| 17 Oct 2026 | Owner update: E2E absorbs PD entirely; PD's tabs become E2E features; no shared package, no parity check |
| 17 Oct 2026 | Owner decision, overriding the new-repo plan: the PD repo is renamed to E2E Proposal and becomes the monorepo. History, CI, secret scan, hooks, infra tests, and PR branches stay. No code copy, no pinned commit, no MIGRATION.md. `C:\Tools\E2E` holds working files only |
| 17 Oct 2026 | Owner decision: PD's open PRs #35 to #38 finish in the renamed repo |
| 17 Oct 2026 | Owner update: no PD lighter UI, no shared platform package, no parity check. PD's tabs become E2E features (s7) |
| 17 Oct 2026 | Owner update: PD's Free, Starter, and Growth plans dropped for E2E's plans |
| 17 Oct 2026 | Stages run behind one stage interface; current skills are placeholders until the Owner rebuilds them per stage |
| 17 Oct 2026 | Owner decision: events on Redis Streams, on the self-hosted Redis container; NATS dropped (item 60 closed) |
| 17 Oct 2026 | Owner decision: billing releases the credit when a run fails or is cancelled before the Red draft (item 62 closed) |
| 17 Oct 2026 | Owner decision: self-hosted Zitadel behind the identity service, pinned and unmodified; its database joins the cluster (item 61 closed) |
| 17 Oct 2026 | Final review: s2 renamed Platform rules; event acknowledgment and reclaim rules stated; gateway event names fixed; s9 added for the local stack, environment variables, migration order, and contract tests (Proposed) |

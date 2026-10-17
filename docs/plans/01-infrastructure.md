# 01: Infrastructure

**Status:** Draft v2 · 17 Oct 2026

This file places the E2E Proposal services on server roles and sizes them. It covers the event bus, the render service, the portal agent, and the model providers. It reuses PD's infrastructure wherever it fits. 09 lists every service. PD plan references read as (PD 01 s2.1).

## 1. Hosting

| Item | Choice |
|---|---|
| Provider | 🟨 **OPEN.** The Owner chooses it after the tool is built, in 08 Phase 10. Deploys use PD's pluggable adapters (`ovh-us`, `hetzner`, `ssh`) from the start, so the choice changes no code (PD 01 s9) |
| During the build | Docker Compose on a development machine. Proposed: a staging host through PD's `ssh` adapter |
| Region | US, east coast preferred, as in PD (PD 01 s1). Federal buyers and most tenants sit near Washington DC |
| OS | Ubuntu 24.04 LTS on every server |
| PD | E2E absorbs PD. PD's code becomes E2E services, and PD does not run as its own app (09 s6). PD's current 8 GB server retires once E2E serves PD's tenants |
| Root and SSH | Owner decides who holds root. Same key-only SSH and logged sessions as PD (PD 01 s3) |

## 2. Server roles

Every service runs in its own container (09 s2). A role is a group of containers that share a host. Moving a service to another host is a compose change, not a code change. Each role grows by adding a server of the same kind.

| Role | Services and shared parts | Starting size |
|---|---|---|
| App role | nginx; services 1 to 9, 11, 12, 14, and 15; Zitadel; Postgres; Redis; ClamAV; the sandbox runner and sandbox | 8 vCPU, 32 GB RAM, 240 GB disk |
| Render role | Service 10: the render API, toolrunner, script containers, LibreOffice, Poppler, pdfplumber, python-docx, librsvg, fonts | 8 vCPU, 16 GB RAM, 160 GB disk |
| Portal agent role | Service 13: one throwaway browser container per portal session | 2 vCPU, 4 GB RAM, 40 GB disk |

The app role grew from the v1 plan. Thirteen service containers at about 256 MB to 512 MB each need room beside Postgres. The load test in 08 Phase 8 sets final values. A later split moves Postgres and Redis to a data role of their own.

```
App role (Ubuntu 24.04)
├── nginx            TLS (Cloudflare Origin certificate), reverse proxy to the gateway
├── sandbox runner   host service, one sandbox container per file job (PD 01 s2.1)
└── Docker Compose
    ├── gateway       [1]  BFF and the E2E web app
    ├── identity      [2]  tenant_id, memberships, wraps Zitadel
    ├── zitadel            self-hosted Zitadel: credentials, MFA, passkeys, SSO; own database in the cluster
    ├── billing       [3]  plans, credits, Stripe
    ├── ingest        [4]  PD's upload and file jobs (BullMQ)
    ├── intel         [5]  PD's shred, matrix, amendments (BullMQ)
    ├── orchestrator  [6]  run state machine, cost cap
    ├── modelgw       [7]  model and image calls, rate buckets, metering
    ├── drafting      [8]  pages, blocks, locks, NEEDs
    ├── review        [9]  Red, Gold, White Glove
    ├── evidence      [11] evidence, repository, pgvector
    ├── comms         [12] mailboxes, Q&A, requests, eBuy inbound
    ├── drive         [14] Shaavir Drive sync
    ├── notify        [15] notices, audit log
    ├── sandbox       file processing, no network, no secrets
    ├── postgres      one cluster, one schema per service plus Zitadel's database, on the LUKS volume
    ├── redis         Redis Streams events, BullMQ inside ingest and intel, rate buckets
    │                 (appendonly yes, appendfsync everysec, maxmemory-policy noeviction, on the LUKS volume)
    └── clamav        virus scan

Render role (Ubuntu 24.04), private network only
├── render           [10] Python API and toolrunner; one script container per tool call
└── script image     Python 3.12, python-docx, pdfplumber, LibreOffice, Poppler, librsvg, fonts

Portal agent role (Ubuntu 24.04), private network plus a portal allow list
└── portal-agent     [13] one container per session: Chromium, virtual display, live view

Off the servers: S3-compatible object storage, off-site backups, Anthropic API,
the image provider, Shaavir Drive, tenant mailboxes
```

Why the render role stands apart:
- LibreOffice and rasterizing burn CPU in bursts. On the app role they would slow the gateway and the event bus.
- Render jobs open tenant documents and fonts. Keeping them on a host with no database credentials limits what a broken job can reach.
- Render load grows with page count, not with users. A second render role host is the first scale step.

Why the portal agent stands apart: it holds live sessions on government portals. A bug there must not reach the database or another tenant's files (s7).

## 3. Orchestrator

The orchestrator is service 6, a container on the app role (09 s4.6). It owns the `orchestrator` schema and talks to other services by API and event only.

| Item | Setting |
|---|---|
| Job | Moves a run through its stages (04 s3). It emits `orchestrator.stage.requested`; the owning service runs the stage behind the stage interface and reports back |
| State | Postgres is the source of truth: every stage writes its status, inputs hash, outputs, and cost before it ends (03 s4) |
| Resume | After a crash or a deploy, the orchestrator reloads each open run and requests its next stage. Finished stages never run again |
| Model calls | None of its own. Stage services call the model gateway (s6) |
| Tenancy | Each stage request carries `tenant_id`. Every service sets `app.tenant_id` before any read or write (02 s6) |
| Size | 1 vCPU and 1 GB RAM to start. It mostly waits on other services |

No service but ingest opens an uploaded file. Files go through PD's sandbox, and documents the tool builds go to the render service.

## 4. Events and queues

Services exchange events on Redis Streams: decided. They run on the self-hosted Redis container already in the stack, which BullMQ also uses. Inside ingest and intel, PD's BullMQ on Redis carries over as built (PD 02 s1). No NATS.

A hosted Redis free tier is too small for production. Production uses the self-hosted Redis container on the app role.

| Rule | How |
|---|---|
| Durable | Redis persists streams with append-only files on the LUKS volume. With `appendfsync everysec` a crash can drop up to one second of events (🟨 **OPEN**, 00 s7 item 68). The outbox is the safety net: each service writes events to its outbox table in the same transaction as its data, and a relay publishes them and marks them sent (09 s2). Consumer groups track delivery; a consumer acknowledges with `XACK` only after its write commits, and a reclaim job takes over pending entries from a dead consumer. Streams trim by `MAXLEN` once every group has read past the point |
| Source of truth | Postgres holds the stage record. The orchestrator's sweep rebuilds a lost request from the database |
| Idempotent | Each stage request has a key: run, stage, scope, and inputs hash. Consumers dedupe on event id. A repeat finds the finished record and exits |
| Retries | 3 retries with backoff for network errors, timeouts, and 5xx replies. A stage that keeps failing marks the run `needs_attention` and alerts |
| Rate limits | A 429 from a provider does not count as a failure. The model gateway waits for `retry-after`, then retries |
| Fairness | Per-tenant and per-run caps on running stages, as in PD's per-bid cap (PD 01 s2.2). One large run cannot hold every slot |
| Work queues | Redis Streams consumer groups per service: `drafting.pages`, `render.jobs`, `render.vision`, `modelgw.images`, `comms.out`, `comms.in`, `drive.sync`, `portal.sessions`, plus PD's BullMQ queues |
| Sweep | Every 5 minutes the orchestrator finds stages marked running with no live work and requests them again |

## 5. Render service

The render service is service 10, written in Python (09 s4.10). It runs alone on the render role.

### 5.1 What it does

| Job | Tool | Notes |
|---|---|---|
| Word assembly | python-docx 1.1 or later | Volumes start from the tenant's cover and contents shell (`client_shell.py`). Captions and NEED comments come from the scripts |
| DOCX to PDF | LibreOffice headless | One profile folder per slot (`-env:UserInstallation`), so parallel conversions do not collide |
| Page images | Poppler `pdftoppm` at 150 dpi | The default in `visual_gate.py`. Render scales images down to the vision model's maximum before sending them through the model gateway |
| Page geometry | pdfplumber | Text boxes, images, and rectangles per page, for the overflow and margin checks in `visual_gate.py` |
| Page count | `pdfinfo` on the exact PDF the tenant submits | The count comes from that file and no other (04 s6) |
| Graphics | librsvg (`rsvg-convert`) | SVG from the model becomes PNG at 300 dpi for Word. The repository keeps the SVG source |
| Format audit | `audit_format.py`, `visual_mix.py`, `caption_fields.py`, `compliance_check.py` | Read the DOCX and report findings as JSON |
| PDF export | LibreOffice, fonts embedded | The submitted PDF and the page images come from the same render |
| Numbering | Code in the render service | Decided. python-docx writes field codes but not their results, and LibreOffice does not refresh them by default. So render computes the contents table, caption numbers, and cross-reference text in code. It writes the results into the DOCX. LibreOffice headless (free, MPL 2.0) then renders DOCX to PDF with no field refresh |

The Windows Word COM step (`word-page-verify`) does not move here. The PDF check replaces it (s5.5). The Word Relay loop (`word-critic`, `relay-producer`) does not move either. Review and drafting run that loop on the server (02 s3).

### 5.2 Sizing

Starting values. The load test in 08-build-phases sets the real ones.

One run drafts up to 100 pages. The visual gate renders again after every graphic insertion. Estimated render work per run:

| Work | Count per run | CPU seconds each | Total |
|---|---|---|---|
| Section renders while drafting | about 30 | about 12 (convert, rasterize, measure about 10 pages) | about 360 |
| Full renders (Red recovery, sweep, assembly, Gold, final) | about 5 | about 110 (100 pages) | about 550 |
| Assembly and script tools | about 60 calls | 1 to 5 | about 150 |
| **Total** | | | **about 1,060 CPU seconds, near 18 CPU minutes** |

At 8 vCPU the server holds about 28,800 CPU seconds an hour. That covers more than 20 runs an hour in theory. Throughput is not the limit. Peak memory and wait time are.

Starting limits on the 8 vCPU, 16 GB render role:

| Slot | Count | CPU each | Memory each |
|---|---|---|---|
| LibreOffice convert | 4 | 1.0 | 1.5 GB |
| Python script tools (python-docx, pdfplumber) | 3 | 1.0 | 2 GB |
| Rasterize and SVG | 1 | 1.0 | 1 GB |
| toolrunner | 1 | 0.25 | 256 MB |
| **Total** | | **8.25 peak** | **about 13.3 GB** |

That leaves about 2.7 GB for the OS and disk cache. CPU above 8 only queues briefly.

Disk: the script image with LibreOffice and fonts is about 3 GB. A run's working folder peaks near 500 MB with page images. The toolrunner deletes working folders when the run's package ships.

🟨 **OPEN:** the render role's plan name and price at the provider chosen after the build. An 8 vCPU, 16 GB VPS listed between about $30 and $60 a month at budget providers in mid-2026 (provisional).

### 5.3 Scripts as tools

The plugin's 29 scripts in `scripts/` move to the render service, with the seven prose scripts and their shared `prose_text.py` from the skill folders (04 s5). Stage services call them as tools through the toolrunner.

| Item | Setting |
|---|---|
| Call | `POST /tools/{name}` on the toolrunner with tenant id, run id, arguments, and file references. Private network only, mutual TLS |
| Run | A fresh script container per call, non-root, read-only image, Docker's default seccomp plus AppArmor |
| Files | The toolrunner copies the run's working folder from object storage, mounts it, and copies outputs back. One tenant per container |
| Network | None by default. `agency_intel.py` goes out through an egress proxy with the official-domain allow list the script already keeps |
| Ledger scripts | `capture_ingest.py`, `needs_register.py`, and `outcome_and_sweep.py` call a remote evidence ledger. `BID_LEDGER_URL` points at the evidence service's internal `/ledger` API, with a token scoped to one tenant |
| Client data | The plugin's `clients/` folder and `clients.seed.json` never ship. Each tenant's shell and format spec load from that tenant's storage only |
| Output | JSON on stdout, validated against a schema before it reaches the database |
| Timeouts | Per tool. 240 seconds for a LibreOffice convert, as in `visual_gate.py`; 60 seconds for most others |
| Cache | Same tool, same arguments, same input hashes: the toolrunner reuses the stored output |
| Acceptance | `preflight.py --selftest` runs every script's self-test on each image build. A failure blocks the deploy |

What each script needs:

| Needs | Scripts |
|---|---|
| Standard library only | The seven skill-folder prose scripts and `prose_text.py`; `pipeline`, `scaffold_pursuit`, `content_gate`, `prose_deductions`, `page_cascade`, `lead_sentence`, `style_sheet`, `responsiveness`, `hot_buttons`, `shred_checks`, `assembly_artifacts`, `review_records`, `outcome_and_sweep`, `detector_risk`, `heading_differentiator`, `format_harden`, `client_shell`, `capture_ingest`, `preflight` |
| python-docx 1.1 or later | `need_comments`, `placeholders`, `audit_format`, `visual_mix`, `caption_fields`, `compliance_check`, `client_spec`, `needs_register`, `agency_intel` (export) |
| pdfplumber | `visual_gate`, `agency_intel` (PDF sources) |
| LibreOffice and `pdftoppm` | `visual_gate` |
| Network egress | `agency_intel` (allow list), the three ledger scripts (internal API only) |

### 5.4 Fonts install

Microsoft licenses its fonts with Windows and Windows Server. The render service runs on Linux, so it ships no Microsoft fonts. It uses metric-compatible open fonts instead. Fonts sit in the script image, in two layers.

| Layer | Contents | Source |
|---|---|---|
| Base, metric-compatible | Liberation Serif (for Times New Roman), Liberation Sans (Arial), Liberation Mono (Courier New), Carlito (Calibri), Caladea (Cambria), Gelasio (Georgia) | Ubuntu packages where they exist, else upstream releases pinned by hash |
| Base, open-licensed | Noto Sans and Serif, Source Sans and Serif, Roboto, Open Sans, Lato | Same |
| Tenant | Fonts a tenant requested and uploaded with its license confirmation | That tenant's storage, mounted read-only into its own jobs only |

- Each job builds its own fontconfig file: the base fonts plus that tenant's folder. No other tenant's fonts are visible.
- Fontconfig cache per tenant, rebuilt once whenever the tenant adds a font. Jobs never share a writable cache.
- Aliases map each Microsoft font name to its metric-compatible font, unless the tenant supplied its own licensed copy.
- A metric-compatible font keeps line breaks and page count in most cases, but the glyphs look different. A Microsoft font with no metric-compatible match raises a NEED for the font request (06 s6).
- The PDF export embeds every font used. The render log lists the fonts each volume used, and any substitutes.
- The embedded font list names the substitute, for example Liberation Serif. 🟨 **OPEN:** how the package handles a solicitation that names Times New Roman or Arial outright. Proposed: the checklist names each substitute, and the tenant may supply its licensed font through a request (00 s7).

### 5.5 Page verification on the server

About 99% of submissions are PDF (04 s6).
1. Render the volume to PDF.
2. Rasterize every page with `pdftoppm`.
3. Run the geometry checks from `visual_gate.py`.
4. Send each page image to a vision model for layout: overflow, broken tables, cut-off graphics, orphan headings, margins.
5. Count pages on that exact PDF with `pdfinfo`.

For the about 1% that require Word files, the package carries a note telling the user to check the page limit in Word.

The count holds for the PDF the tool produced. A PDF the tenant re-exports from Word after editing the DOCX may paginate differently. 🟨 **OPEN:** whether the package tells the user to submit the tool's PDF or re-check after any Word edit (04 s5.20).

## 6. Model providers

Every model and image call goes through the model gateway, service 7 (09 s4.7). No other service holds a provider key.

### 6.1 Anthropic API

| Item | Setting |
|---|---|
| Use | Drafting, every skill stage, vision checks, the portal agent |
| Interface | The model gateway, built from PD's provider layer (PD 02 s5) and its Anthropic adapter. A settings table maps each task to a model |
| Keys | One vendor key in the model gateway's root-only env file. Never in any other service, the sandbox, or the portal agent container |
| Rate limits | A token bucket in Redis per model tracks requests, input tokens, and output tokens a minute, from the account's limits. Jobs wait for room before they call |
| 429 and 529 | Wait for `retry-after`, then retry. Not counted as a stage failure (s4) |
| Concurrency | Per-model setting plus per-tenant and per-run caps, set from the 10-RFP test (08 Phase 9) |
| Prompt caching | Skill instructions go first, before the cache breakpoint. Tenant text comes after it. Cost plans do not assume cache hits |
| Vision | Image tokens scale with pixel area, roughly width times height over 750. A letter page at the model's long-edge limit costs about 2,500 input tokens. 100 pages over 5 rounds is near 1.3 million tokens a run. 🟨 **OPEN:** confirm against current Anthropic docs before the 10-RFP test |
| Logging | Every call writes PD's `ai_runs` row: tokens, cost, model, task, run, stage (PD 02 s5) |

Zero-retention and no-training terms: decided and confirmed. The tool runs the 10-RFP test first on documents the Owner may send under standard terms. The terms then change, and only then does the tool ship (07 s9; 08 Phase 10).

### 6.2 Separate reviewer

The Red review runs on a different model from the drafter (04 s7.2). The model gateway selects it by setting. If it comes from another provider, that provider gets its own adapter, key, rate bucket, and `ai_runs` rows.

🟨 **OPEN:** which reviewer model.

### 6.3 Image provider

| Item | Setting |
|---|---|
| Use | GPT Image 2, for illustrative art only. Diagrams, charts, and process graphics stay SVG from the model |
| Call | From drafting through the model gateway's image adapter, work queue `modelgw.images`. Prompts never carry tenant names, contract numbers, or personal data |
| Output | PNG stored in the run's files, then placed by the render service |
| Cost | Every image call counts against the run's cost cap (s8) |

The image provider follows the same terms path as Anthropic: the 10-RFP test, then zero-retention terms, then launch.

## 7. Portal agent sandbox

The portal agent, service 13, checks portals and downloads documents while the human approves each login and MFA prompt (02 s7.4).

| Control | Setting |
|---|---|
| Host | The portal agent role only (s2) |
| Session | One container per portal session, started on request and destroyed at the end. No profile, cookie, or cache survives |
| Human present | The user watches a live view of the browser. The user types credentials and MFA codes there. The agent waits on every login and MFA screen |
| Credentials | Never stored. Not in the database, logs, model prompts, or screenshots kept after the session |
| Screenshots | The model never sees a screen with a password or MFA field, and the session keeps none |
| Network | Egress only to the portal's allow list for that session, through a proxy. The proxy blocks SAM.gov and any portal that bans automation outright |
| Downloads | Go to a drop folder, then to the ingest service: scan, sandbox, extract (02 s5) |
| Limits | Proposed: idle timeout 10 minutes, hard limit 60 minutes (🟨 **OPEN**, 07 s2). 1 vCPU and 1.5 GB per session, 2 sessions per host to start, one per tenant at a time |
| Final submit | The agent never clicks a final submit button. A human does |

🟨 **OPEN:** the portal agent implementation: Anthropic computer use, or Playwright driven by the model. Either fits this sandbox.

## 8. Cost cap per run

| Rule | How |
|---|---|
| What counts | Every model call (drafter, reviewer, vision, portal agent) and every image call in the run |
| Owner | The orchestrator owns the cap value and the pause. It pushes each run's budget to the model gateway with `orchestrator.run.budget_set` |
| Ledger | The model gateway meters each call as it ends and emits `modelgw.usage.metered`. The orchestrator's cost ledger records it (03 s4) |
| Check before a call | The model gateway estimates the call's cost against the run's budget. If that would pass the cap, the call does not start, and the gateway emits `modelgw.budget.exhausted` |
| At 80% | Proposed: the run monitor shows a warning, and the vendor gets an alert |
| At 100% | Proposed: the run pauses with its state saved. Nothing is lost. The vendor and the tenant Admin get an alert. It resumes once the cap is raised. 🟨 **OPEN:** who may raise it (06 s8) |
| Estimate | The estimate shown before a run comes from page count and volume count (06 s7) |
| Global caps | PD's monthly spend cap and per-tenant daily cap carry over (PD 04 s6) |

Cap value: decided. The 10-RFP test measures cost per run, and the Owner sets the cap from it (08 Phase 9). Until then the cap is a high placeholder that only guards against runaway loops. 🟨 **OPEN:** whether a tenant may approve going past the cap, tied to the recharge rate (06 s5). 04 s12, 05 s4.3, and 06 s8 follow the behavior here.

## 9. Network, DNS, and inbound mail

- DNS on Cloudflare, proxied, with PD's rate limits, Full (strict) TLS, and chunked uploads (PD 01 s3).
- Host firewall as in PD: 443 from Cloudflare only, SSH from the admin network.
- The render role and the portal agent role take traffic only from the app role's private address.
- Inbound mail: each tenant gets an address such as `tenantname@in.<tool domain>` (02 s7.3). MX for `in.<tool domain>` points at an inbound mail service. That service posts each message to the comms service through a signed webhook.
- Outbound calls from the app role: Anthropic, the image and reviewer providers (model gateway only), Gmail, Microsoft Graph, Shaavir Drive, Stripe, the email provider, object storage, backups, and error tracking.

Working product name: E2E Proposal. 🟨 **OPEN:** the final name and domain, after a trademark and domain check (00 s7). 🟨 **OPEN:** the inbound mail service (for example Cloudflare Email Routing to a webhook, or a mail provider's inbound parse). It becomes a subprocessor.

## 10. Monitoring and alerts

PD's monitoring carries over (PD 01 s5): uptime, disk at 80%, backup age, error tracking with scrubbed bodies, 14-day logs with no document text.

New checks:

| Check | Alert when |
|---|---|
| Stuck stage | A stage runs past twice its expected time |
| Event lag | A consumer falls more than 2 minutes behind its stream, or an outbox holds unsent events for 5 minutes |
| Run cost | A run passes 80% of its cap |
| Rate limits | 429 replies pass a set share of calls in an hour |
| Render queue | Wait time passes 5 minutes, or a convert times out |
| Render service | Down, or memory above 90% for 5 minutes |
| Vision check | A page check fails to return twice |
| Portal sessions | A session passes its hard limit, or the allow list blocks a request |
| Inbound mail | The daily eBuy check finds an RFQ that no email announced |
| Mailbox | A tenant's mailbox token expires or a send fails |
| Drive sync | A sync to a tenant's Drive folder fails twice |
| Spend | Daily model and image spend by tenant, with PD's monthly cap alert |

Logs never hold document text, prompts, credentials, or personal data. Run and stage ids are enough to trace a problem.

## 11. Backups

| What | How | Kept |
|---|---|---|
| Database | One cluster: all service schemas and Zitadel's database. PD's hourly `pg_dump` into encrypted Borg, then rclone crypt to Backblaze B2 (PD 01 s4) | 2 days hourly, 30 days daily |
| Repository and final packages | Object storage with versioning, plus a nightly encrypted copy off-site | 🟨 **OPEN** (07 s7) |
| Run working files | No backup. The orchestrator rebuilds a lost one from the stage record and the repository | Until the package ships |
| Tenant fonts | In the repository backup | While the tenant is active |
| Shaavir Drive | Drive's own backups. The tool keeps its own copy of each Pink and working document | Drive's terms |
| Event streams | No backup. Outbox tables and stage records rebuild lost events | n/a |
| Render and portal agent roles | No backups. Both rebuild from images | n/a |

Unlike PD, the tool must back up stored files. The repository holds years of a tenant's proposals, and users do not hold every original.

PD's recovery targets apply: RPO 1 hour and RTO 4 hours, proposed and still 🟨 **OPEN** (PD 01 s4). PD's monthly restore drill also covers one repository restore.

## 12. Deployment

PD's pipeline carries over (PD 01 s6): GitHub Actions tests and builds images, and a manual deploy job runs `deploy.sh` over SSH.

Added for E2E Proposal:
- CI builds one image per service. Turbo builds only the services a change touches. The uv workspace builds the Python services.
- Contract tests run on every PR (09 s2).
- Each service deploys on its own. A service with a schema migration deploys its migration first, in its own schema only.
- The render image builds once per release and runs `preflight.py --selftest`. The build pins every font file by hash.
- The render role and the portal agent role pull their images by tag and restart. Only the model gateway holds model keys.
- A render deploy drains `render.jobs` first, or lets running tool calls finish. Open runs resume on their own (s3).
- Skill files ship with the code, versioned. A run records the skill versions it used (02 s4).

## 13. Monthly running cost (provisional)

| Item | Monthly |
|---|---|
| App role, 8 vCPU and 32 GB | 🟨 **OPEN** with the provider, chosen after the build (s1) |
| Render role, 8 vCPU and 16 GB | about $30 to $60 (s5.2, provisional) |
| Portal agent role, 2 vCPU and 4 GB | about $5 to $15 (provisional) |
| Object storage and off-site backup | Small; grows with the repository |
| Inbound mail service | Small; 🟨 **OPEN** with the service |
| Anthropic, reviewer, and image calls | Per run, under the cap. Measured in the 10-RFP test (08 Phase 9) |

Model cost dwarfs server cost. The cost cap (s8) and the estimate before a run (06) carry the real control.

## Decision log

| Date | Decision |
|---|---|
| 17 Oct 2026 | Hosting stays on PD's pluggable adapters; the production provider stays OPEN |
| 17 Oct 2026 | Three server roles: app, render, and browser agent host. The tool gets its own servers, apart from PD's production server |
| 17 Oct 2026 | Orchestrator runs as a container on the app server. Postgres holds stage state; BullMQ only delivers work |
| 17 Oct 2026 | Render server starts at 8 vCPU and 16 GB, with 4 LibreOffice slots and 3 Python slots; the load test sets final values |
| 17 Oct 2026 | Skill scripts run as tools in one container per call, one tenant per container, no network by default |
| 17 Oct 2026 | Ledger scripts point at the tool's internal evidence API; the plugin's `clients/` data never ships |
| 17 Oct 2026 | Fonts in two layers: base for every tenant, tenant fonts mounted only into that tenant's jobs |
| 17 Oct 2026 | Word COM verify replaced by render, rasterize, vision check, and `pdfinfo` count on the submitted PDF |
| 17 Oct 2026 | Browser agent on its own host, one throwaway container per session, credentials never stored, final submit always human |
| 17 Oct 2026 | Cost cap checked before each call; the run pauses at 100% with state saved; the cap value stays OPEN |
| 17 Oct 2026 | Repository and final packages get off-site backups, unlike PD's live files |
| 17 Oct 2026 | Review pass: cost cap behavior marked Proposed and aligned across 04, 05, and 06; field refresh, fonts EULA, vision token cost, and Word re-export added as OPEN |
| 17 Oct 2026 | Owner decision: hosting is chosen after the tool is built. Deploys use PD's adapters, so the choice changes no code |
| 17 Oct 2026 | Owner decision: microservices. Server roles now group service containers: app role (8 vCPU, 32 GB), render role, portal agent role. Events on NATS JetStream, Proposed |
| 17 Oct 2026 | Owner decision: E2E absorbs PD; PD's code becomes E2E services. The one-deployment-or-two question is closed |
| 17 Oct 2026 | Owner decision: the per-run cost cap comes from the 10-RFP test. The orchestrator owns the cap; the model gateway enforces it per call |
| 17 Oct 2026 | Owner decision: code computes the contents table, captions, and cross-references; LibreOffice headless renders DOCX to PDF. Field refresh closed |
| 17 Oct 2026 | Owner decision: the Linux render service ships metric-compatible open fonts and no Microsoft fonts. The core fonts EULA question is closed |
| 17 Oct 2026 | Owner decision: zero-retention terms follow the 10-RFP test and come before launch |
| 17 Oct 2026 | Owner decision: events on Redis Streams, on the self-hosted Redis container that BullMQ already uses. NATS dropped. A hosted free tier is too small for production (item 60 closed) |
| 17 Oct 2026 | Owner confirmed: the 10-RFP test runs under standard provider terms; terms move to zero retention before shipping |
| 17 Oct 2026 | Owner decision: self-hosted Zitadel joins the app role with its own database in the cluster |
| 17 Oct 2026 | Final review: Redis AOF loss window stated and the outbox named as the safety net; consumer acknowledgment and reclaim rules added; python-docx floor set to 1.1 |

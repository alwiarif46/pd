# 01 — Infrastructure

**Status:** Draft v3 · 16 Oct 2026

## 1. Hosting

PD lives on the Shaavir Drive server: the same server and stack as Shaavir Drive (section 1.1).

| Item | Choice |
|---|---|
| Provider | Contabo, Cloud VPS 8, US East. Shaavir Drive moved here from OVH (account permissions blocked, US VPS range out of stock) and, before that, Hetzner (price rise). Paid on a monthly term; not provisioned yet (16 Oct 2026). The Contabo customer ID is in the Drive's records, not here |
| Region | US East (closer to Washington DC area contractors) |
| Server | Contabo Cloud VPS 8: one 150 GB NVMe disk, no automatic backup. 🟨 **OPEN:** confirm its vCPU count and RAM from the Contabo order; the resource table in section 2.2 was sized for a dedicated 8 GB, 4 vCore server |
| OS | Ubuntu 24.04 LTS |
| Separation | Shared with Shaavir Drive. Nothing from shaavir-prod-01 (Payroll, HRA, Score) runs here, and this app does not run there |
| Root and SSH access | SSH only over the Drive's Headscale tailnet (`vpn.shaavir.com`); no public SSH port (section 3). Root on this server is root for both products. 🟨 **OPEN:** who gets root (07 s1) |

Why not shaavir-prod-01: a public upload endpoint must not share a machine with payroll and HR data. The Drive also takes client files through a public endpoint, so it is the same risk class. PD's uploaded files are still opened only in its sandbox (section 2.1).

- 🟨 **OPEN:** a compromise of either product on a shared server exposes both. Accept this for launch, or run PD on a second VPS (section 1.2).

### 1.1 PD and Shaavir Drive

- **Two separate products.** A client can buy PD, the Drive, or both.
- **Integration is optional.** PD is built to stand alone; integration is offered, not required.
- **Hosting.** PD runs inside the Drive's hosting (same server and stack) rather than on a server of its own.
- **One login when integrated.** If a client has both and they are integrated, one login covers both: single sign-on through the Drive's identity, with 2FA. Until then PD keeps its own sign-up and login (06 s1).
- **Nothing is built yet.** This section records the plan only.

### 1.2 Shared server limits

One VPS with one 150 GB disk carries both products. PD's footprint must fit next to the Drive's Nextcloud AIO, OnlyOffice, ClamAV and Elasticsearch, or PD moves to a second VPS.

- **Memory and CPU.** PD's containers were sized at about 5.6 GB and 4.0 CPU on a dedicated server (section 2.2). That cannot sit unchanged next to the Drive stack on one VPS. 🟨 **OPEN:** a measured budget for each product before PD deploys.
- **ClamAV.** The Drive already runs ClamAV, and PD's clamd needs about 1.5 GB. 🟨 **OPEN:** whether PD uses the Drive's clamd (saves the memory, but PD's 300 MB scan limits and its sandbox-first rule must still hold) or keeps its own.
- **Disk.** PD needs room for its images (the sandbox image with OCR and LibreOffice runs to a few GB), Postgres, Redis, logs, and live files. Live files are the large part: up to 300 MB per paid bid, kept live at least 90 days. At 100 RFPs a month that can reach tens of GB, close to 90 GB at the worst, which does not fit next to Nextcloud's data on 150 GB. 🟨 **OPEN:** cap PD's share of the disk, keep live files in object storage, or move to a second VPS.
- **When to move PD out.** 🟨 **OPEN:** set the trigger, for example disk above 70 % used, sustained memory pressure, or a client that needs PD isolated.
- **Staging.** There is no room for a staging copy on this server (section 6).

## 2. Server layout

```
Contabo Cloud VPS 8, US East (Ubuntu 24.04): the Shaavir Drive server
├── Drive reverse proxy  the only public listener (80, 443); routes pd.shaavir.com to PD, request size limit
├── Drive stack          Nextcloud AIO, OnlyOffice, ClamAV, Elasticsearch (the Drive's; listed for sizing)
├── sandbox runner       small host service; starts one sandbox container per file job
└── PD Docker Compose
    ├── web       Front end (static build served by nginx container)
    ├── api       Application server (HTTP API)
    ├── worker    Background jobs: AI calls, database writes, exports, retention, archive moves
    ├── sandbox   File processing: encryption check, DOCX to PDF, text extraction, OCR (no network)
    ├── postgres  Database (data volume on local disk)
    ├── redis     Job queue and rate-limit counters (appendonly yes)
    └── clamav    Virus scan for uploads

Off the server: encrypted file archive in object storage, and database backups (section 4)
```

- Every container has CPU and memory limits, the same pattern as the BlokClients stack on shaavir-prod-01.
- Files live on a Docker volume at `/data/files`, laid out by organization (see 03-data-model.md).

### 2.1 Sandbox

Uploaded files are opened only in the sandbox, never in the worker or the api.

| Control | Setting |
|---|---|
| Network | None (`network_mode: none`) |
| Secrets | No database credentials, no AI keys, no Stripe, Telnyx, or archive keys |
| User | Non-root |
| Files | Read-only mount of the one file for the job, plus an empty output folder |
| Kernel | Docker's default seccomp profile plus an AppArmor profile |
| Limits | Hard wall-clock, CPU, and memory limits per job. The wall-clock limit is a setting, set from Phase 1 OCR measurements |
| Checks first | Encryption type and page count, before any OCR (04 s2) |
| Output | JSON with page text, plus page images when needed. Nothing else leaves the sandbox |

- The sandbox runner is a small host service, not a container. It takes requests from the job queue and starts `docker compose run --rm sandbox` with a fixed command. The worker never holds the Docker socket.
- The sandbox processes one file at a time to start. OCR inside it runs 2 pages in parallel (`ocrmypdf --jobs 2`) within the sandbox CPU limit. Both are settings, adjusted after the load test.
- LibreOffice (headless, for DOCX to PDF) adds several hundred MB to the sandbox image. That is disk space. It uses memory only while it converts a file.

### 2.2 Starting limits

On a dedicated 8 GB, 4 vCore server (adjust after the load test). On the shared Drive server these must fit inside PD's share of the machine, which is not set yet (section 1.2):

| Container | CPU | Memory |
|---|---|---|
| api | 0.5 | 512 MB |
| worker | 0.5 | 768 MB |
| sandbox | 2.0 | 1.5 GB |
| postgres | 0.5 | 1 GB |
| redis | 0.15 | 256 MB |
| clamav | 0.25 | 1.5 GB |
| web | 0.1 | 64 MB |
| **Total** | **4.0** | **about 5.6 GB** (5,696 MB) |

That leaves about 2.4 GB for the OS, nginx, the sandbox runner, and disk cache.

- The worker mostly waits on AI calls, so it needs little CPU now that file processing runs in the sandbox.
- ClamAV needs about 1 GB for its signatures alone. `ConcurrentDatabaseReload no` stops it loading a second copy during signature reloads (scans pause briefly instead). The other option, ClamAV at 2 GB, does not fit this table.
- clamd limits: `MaxFileSize`, `MaxScanSize`, and `StreamMaxLength` set to 300 MB or more, the largest allowed upload. The defaults are near 25 MB and silently skip larger files.

**Concurrency:**
- AI calls: a per-provider limit, starting value 3, set from the Phase 1 benchmark and the provider's concurrent-call limit (04 s5). A per-bid cap below it keeps one large bid from taking every slot. Both are settings.
- File jobs: one at a time in the sandbox, with OCR 2 pages in parallel (section 2.1).

## 3. Network and DNS

- DNS on Cloudflare, like the rest of shaavir.com.
- Subdomain `pd.shaavir.com` (working name 🟨 **OPEN**), proxied (orange cloud) for DDoS protection and caching of static files.
- Cloudflare rate limiting on `/api/auth/*` and on uploads (`/api/bids/*/uploads`, `/api/uploads/*`).
- TLS ends at the Drive's reverse proxy, which serves PD over HTTPS only. 🟨 **OPEN:** whether `pd.shaavir.com` stays proxied through Cloudflare ("Full (strict)" with a Cloudflare Origin certificate, as first planned) or uses the reverse proxy's own certificates as the Drive does. The Cloudflare rate limits above apply only if it stays proxied; otherwise the reverse proxy or the api must carry them.
- The reverse proxy's request body limit for PD is 300 MB as an upper bound; in practice each request carries one 20 MB chunk.
- Cloudflare's free plan caps each request at 100 MB, so the browser uploads files in 20 MB chunks through an upload session (02 s3). There is no flat per-file limit. A file may use whatever is left of the bid's MB cap: 50 MB per bid on Free, 300 MB per bid on Starter and Growth, all files on the bid added together (06 s3).
- Server firewall, the Drive's model: public ports 80 and 443 only, both to the Drive's reverse proxy. No public SSH: admin access is SSH over the Drive's Headscale tailnet (`vpn.shaavir.com`) only. SSH key login only, no passwords. SSH sessions are logged (07 s1). PD's containers publish no ports to the internet; the reverse proxy reaches them on the host.
- `infra/scripts/setup-server.sh` does not match this yet: it opens 22 and 443 to everyone with `ufw`. It must change before it is used on the Drive server (no public 22, and no firewall or nginx setup that fights the Drive's). Code change later.
- Outbound calls: DeepInfra, Anthropic (for comparison tests), Stripe, Telnyx, the email provider, the archive storage provider, the off-site backup target, and the error tracking service. The sandbox has no outbound access.

## 4. Backups and archive

| What | How | Kept |
|---|---|---|
| Database | Continuous WAL archiving plus a nightly base backup, encrypted, copied off the server. Fallback: hourly encrypted dumps | 30 days |
| Live files | Not backed up. Users hold the originals, and files past their live date go to the archive | n/a |
| Archive | Originals and viewer copies past their live date, encrypted, in off-server object storage (03 s5, 07 s2). This is the only off-server copy of files | Archive lifetime (07 s2) |
| Server | None. The Contabo plan has no automatic backup, so the off-server database backup and the archive are the only copies | n/a |

- 🟨 **OPEN:** backup method and recovery targets. Proposed: RPO 1 hour (at most 1 hour of database changes lost) and RTO 4 hours (service back within 4 hours of losing the server). WAL archiving meets the RPO with room; hourly dumps meet it only at the edge. With no server backup and one disk, losing the server means rebuilding it and restoring from these copies, for both products.
- 🟨 **OPEN:** off-site backup target (object storage with another provider, or the Drive's own backup target if it has one).
- 🟨 **OPEN:** archive provider (for example Backblaze B2 or Contabo Object Storage). It becomes a subprocessor (07 s4).
- Archive files are encrypted before they leave the server. The key is held outside the archive: in a root-only file on the server, plus an offline copy Amaan holds.

Restore test, once a month: restore the latest base backup and WAL (or the latest dump) to a scratch server, time it against the RTO, and log the result. Restore one archived file the same day.

## 5. Monitoring and alerts

- Uptime check on `https://pd.shaavir.com/health` every minute.
- Disk alert at 80% used. The disk is shared with the Drive, so the alert covers both products. The per-organization storage quota (06 s3) keeps one organization from filling the disk.
- Daily AI spend report from the usage table (see 04-ai-pipeline.md). Alert when spend passes 80% of the monthly cap.
- Daily Telnyx SMS spend alert (06 s1).
- Alert on failed archive moves, failed restores, and sandbox jobs stopped by a limit.
- Error tracking for api and worker. 🟨 **OPEN:** service choice. The service must scrub request bodies, headers, and cookies before sending, since request bodies can hold document text and phone numbers.
- Logs: Docker logs rotated daily, kept 14 days. Logs never contain document text, resumes, or phone numbers.

## 6. Deployment

- Code in a private GitHub repository under the Shaavir organization. 🟨 **OPEN:** the repository is public today (`alwiarif46/pd`). It was made public because CI failed on the private repository with a GitHub billing error. Public exposes the internal plans, including this file. Decide whether to fix billing and make it private.
- GitHub Actions: run tests, build Docker images, push to GitHub Container Registry.
- Deploy: SSH into the server over the Drive's tailnet, pull images, `docker compose up -d`. 🟨 **OPEN:** how an automated deploy reaches the server with no public SSH (a tailnet key for CI, or deploys run by hand from a tailnet machine). Database migrations run as the owner role `pd_owner` in a separate step before the api restarts. The running app uses `pd_app` (02 s4).
- `infra/scripts/deploy.sh` does this in order: pull, build images (build context is the repo root), start `postgres` and `redis`, run `db:migrate` as `pd_owner` in the one-off `migrate` compose service, then `docker compose up -d`. A failed migration stops the deploy before the api and worker restart. The script never prints secrets; they come from `/opt/pd/.env` (root-only, mode 600).
- **Setting the `pd_app` password (out of band, never in a script or a migration).** The migration creates `pd_app` with `LOGIN` and no password. After the first successful migration on a server, set it once from the server shell, reading the value from the root-only env file so it never lands in shell history or a process list:

  ```
  docker compose --env-file /opt/pd/.env -f /opt/pd/infra/docker-compose.yml exec -T postgres \
    sh -c 'psql -U pd_owner -d pd -v ON_ERROR_STOP=1' <<< "ALTER ROLE pd_app PASSWORD '$(grep ^PD_APP_PASSWORD= /opt/pd/.env | cut -d= -f2-)';"
  ```

  Then run `deploy.sh` again (or restart `api` and `worker`). To rotate: change `PD_APP_PASSWORD` in `.env`, run the same `ALTER ROLE`, restart `api` and `worker`. `PD_APP_PASSWORD` must differ from `POSTGRES_PASSWORD`, and the value must not contain a single quote. Until it is set, the api and worker fail to log in and exit.
- **Cut-over: migration 0008 (amendment key check).** Before 0008, classify sent an amendment straight to the `ai:amendment` queue; after it, the key check creates the `amendments` row and only then queues `ai:amendment`, and the `ai:amendment` step skips an amendment with no row. An amendment caught between the two (classified before the deploy, its `ai:amendment` job not yet run) would stay unprocessed. Do one of these:
  1. Before deploying, stop new uploads and let the `ai:amendment` queue drain (no waiting or active jobs), then deploy.
  2. After deploying, run the one-off `apps/worker/scripts/requeue-amendments.ts` with the worker's environment. For each organization named with `--org <uuid>` (row-level security shows one at a time; list the ids from a superuser `psql` session), it finds every amendment that is not deleted, finished extraction (`extract_status = 'ready'`), is not waiting on a marking confirmation, and has no `amendments` row. It is a dry run by default; with `--apply` it inserts a `classify` job row for each and queues it, so the key check runs. Rerunning it is safe: the key check is idempotent.
- Two environments: `staging` and `production`. The shared Drive server has no room for a staging copy (section 1.2). If there is a staging server, it is a separate small VPS. 🟨 **OPEN:** whether to run a separate staging VPS.

## 7. Monthly running cost (estimate, provisional)

Assumptions: 50 users, up to 100 RFPs a month, ₹97 per US dollar. One RFP is a solicitation set: the solicitation, its amendments, and its attachments (04 s2), up to 50 MB on Free and 300 MB on paid plans. Its token count is larger than the 200 pages of solicitation that the v1 estimate used, and amendment runs add more.

🟨 **OPEN:** the AI figures on this page and in 04 s7 are provisional. Re-derive them from the providers' current price lists and Phase 1 measurements, with no provider caching assumed (04 s7 has the arithmetic).

| Item | Monthly |
|---|---|
| Contabo Cloud VPS 8, shared with Shaavir Drive | about ₹2,600 ($26.78) plus 18% GST (about ₹470): about ₹3,070 for the whole server. 🟨 **OPEN:** PD's share of it |
| AI, DeepInfra Qwen3.5-397B (first test model) | ₹6,000 to ₹11,300 (v1 estimate, provisional) |
| Telnyx SMS for phone verification | Small; depends on signups, plus a monthly 10DLC campaign fee 🟨 **OPEN:** check Telnyx US SMS and 10DLC rates |
| Email, monitoring, backups | ₹0 to ₹500 on free or low tiers |
| Archive storage | Small; depends on the provider and volume (archive provider OPEN, section 4) |
| If separate staging | A few dollars (🟨 **OPEN**, section 6) |
| Domain, TLS, Cloudflare | ₹0 (existing) |
| Buffer, 15% | about ₹1,360 to ₹2,230 |
| **Total** | **about ₹10,400 to ₹17,100 if PD carries the whole server; less by the Drive's share. Plus archive and staging. Provisional** |

AI cost changes with the model the test selects (v1 estimates, provisional; see 04 s7):

| Model | 100 RFPs a month |
|---|---|
| Anthropic Haiku 5.5 | about ₹1,100 |
| DeepInfra Qwen3.5-397B | about ₹6,000 to ₹11,300 |
| DeepInfra DeepSeek V4 Pro | about ₹9,500 |
| Anthropic Sonnet 5.5 | about ₹21,200 |

Add 18% GST under reverse charge for foreign providers (claimable as input credit if Shaavir is GST-registered) and card forex fees. Confirm with the accountant.

## 8. Stripe setup

Billing (06 s5) works once these are done in the Stripe dashboard, in test mode first, then live. Prices exist only in Stripe; the app never shows or stores an amount.

1. **Products and prices.** Two products, Starter and Growth, each with one recurring monthly USD price. Put the Price ids (`price_...`) in `STRIPE_PRICE_STARTER` and `STRIPE_PRICE_GROWTH`. A subscription on any other price is not applied: the webhook records it in `audit_log` (`billing.unknown_price`) and logs an error.
2. **API key.** `STRIPE_SECRET_KEY`. A restricted key needs: Customers write (create, update, retrieve), Checkout Sessions write (create, list, expire), Customer Portal sessions write, and Subscriptions read (retrieve, list). Nothing else; the webhook signing secret comes from step 3, not from the key.
3. **Webhook endpoint.** `https://<api host>/api/billing/webhook`, pinned to API version `2026-08-26.dahlia` (the version the `stripe` package in `apps/api` is written against). Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. **Customer Portal.** Turn it on. Its product catalog must contain only the Starter and Growth prices from step 1. Allow switching between them with proration; downgrades take effect at the end of the billing period; cancellation at the end of the period, not immediately. Allow payment method updates and invoice history. Set the business name and the privacy and terms links.
5. **Failed payments.** Under subscription settings, choose what happens after the last retry: cancel the subscription or mark it unpaid. Either moves the organization to Free (06 s5).
6. **Stripe Tax.** Off. 🟨 **OPEN** (06 s5).
7. **App URL.** `APP_URL` is the web app's public origin. Checkout returns to `APP_URL/#/org?billing=success` or `?billing=cancelled`; the Portal returns to `APP_URL/#/org`.
8. **Check.** In test mode, forward events with `stripe listen --forward-to <api>/api/billing/webhook`, upgrade a test organization, change plan in the Portal, and cancel. `GET /api/org` shows `billingAvailable: true` only when the secret key, both price ids, and `APP_URL` are set.
9. **Two live subscriptions.** If an error log or an `audit_log` row `billing.second_live_subscription` appears, one customer has two live subscriptions. The app keeps the first and never cancels anything itself; cancel the extra one in the dashboard and refund if needed.

## Decision log

| Date | Decision |
|---|---|
| 13 Oct 2026 | OVHcloud US, separate from shaavir-prod-01 |
| 13 Oct 2026 | Chunked uploads to pass Cloudflare's 100 MB request cap |
| 13 Oct 2026 | OVHcloud US account confirmed; no further check needed |
| 13 Oct 2026 | Flat 200 MB per-file limit replaced: a file may use what is left of the bid's MB cap (50 MB Free, 300 MB paid). nginx upper bound 300 MB |
| 13 Oct 2026 | File processing moved to a `sandbox` container with no network and no secrets; resource table rebalanced to about 5.6 GB and 4.0 CPU |
| 13 Oct 2026 | clamd size limits raised to 300 MB or more; `ConcurrentDatabaseReload no` |
| 13 Oct 2026 | AI concurrency is a per-provider setting (starting value 3, set from the Phase 1 benchmark) plus a per-bid cap; OCR runs 2 pages in parallel |
| 13 Oct 2026 | Files past their live date move to an encrypted off-server archive; key held outside the archive |
| 13 Oct 2026 | Database backups by WAL archiving or hourly dumps; RPO 1 hour and RTO 4 hours proposed (OPEN) |
| 13 Oct 2026 | Root and SSH: Amaan only until decided. Staging stays OPEN; it does not fit on the 8 GB server |
| 13 Oct 2026 | AI cost figures marked provisional until Phase 1 measurements |
| 13 Oct 2026 | Error tracking service must scrub request bodies |
| 15 Oct 2026 | Stripe dashboard setup recorded (section 8): two monthly prices, restricted-key permissions, webhook events and API version, Portal catalog limited to Starter and Growth, end-of-period downgrade and cancel, Stripe Tax off |
| 15 Oct 2026 | Cut-over for migration 0008 (section 6): drain `ai:amendment` before the deploy, or run `requeue-amendments.ts` after it |
| 16 Oct 2026 | Hosting moves with Shaavir Drive to Contabo Cloud VPS 8, US East (OVH blocked and out of stock in the US; Hetzner raised prices). PD lives on the Drive server. Supersedes the OVHcloud US rows above |
| 16 Oct 2026 | PD and the Drive are separate products with optional integration; one login through the Drive's identity with 2FA when integrated (section 1.1) |
| 16 Oct 2026 | Shared-server limits recorded (section 1.2): PD fits next to Nextcloud AIO, OnlyOffice, ClamAV and Elasticsearch on one 150 GB disk, or moves to a second VPS |
| 16 Oct 2026 | Admin access: SSH only over the Drive's Headscale tailnet; public ports 80 and 443 only, through the Drive's reverse proxy. `setup-server.sh` to change to match |

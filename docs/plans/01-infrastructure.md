# 01 — Infrastructure

**Status:** Draft v2 · 13 Oct 2026

## 1. Hosting

| Item | Choice |
|---|---|
| Provider | OVHcloud US (separate account from OVH Europe and India). The account is in place |
| Region | US, east coast preferred (closer to Washington DC area contractors). 🟨 **OPEN:** confirm which OVH US locations offer this VPS (Vint Hill, Virginia, or Hillsboro, Oregon) |
| Server | OVH VPS with 8 GB RAM and at least 4 vCores. 4 GB is too small once ClamAV, Postgres, OCR, and LibreOffice share the machine. 🟨 **OPEN:** confirm the OVH US plan name and price; a 4 vCore, 8 GB VPS listed at about $10 (₹970) a month in mid-2026 |
| OS | Ubuntu 24.04 LTS |
| Separation | New server. Nothing from shaavir-prod-01 (Payroll, HRA, Score) runs here, and this app does not run there |
| Root and SSH access | Amaan only until decided. 🟨 **OPEN:** who else gets root on this server (07 s1) |

Why a separate server: a public upload endpoint must not share a machine with payroll and HR data.

## 2. Server layout

```
OVH VPS (Ubuntu 24.04)
├── nginx           TLS with a Cloudflare Origin certificate, reverse proxy, request size limit
├── sandbox runner  small host service; starts one sandbox container per file job
└── Docker Compose
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

On an 8 GB, 4 vCore server (adjust after the load test):

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
- Cloudflare SSL mode "Full (strict)" with a Cloudflare Origin certificate on nginx. This avoids Let's Encrypt renewals, which would need port 80 open.
- nginx serves HTTPS only. Request body limit 300 MB as an upper bound; in practice each request carries one 20 MB chunk.
- Cloudflare's free plan caps each request at 100 MB, so the browser uploads files in 20 MB chunks through an upload session (02 s3). There is no flat per-file limit. A file may use whatever is left of the bid's MB cap: 50 MB per bid on Free, 300 MB per bid on Starter and Growth, all files on the bid added together (06 s3).
- Server firewall: allow 443 from Cloudflare IP ranges only, plus 22 from Shaavir office IPs or the team VPN. SSH key login only, no passwords. SSH sessions are logged (07 s1).
- Outbound calls: DeepInfra, Anthropic (for comparison tests), Stripe, Telnyx, the email provider, the archive storage provider, the off-site backup target, and the error tracking service. The sandbox has no outbound access.

## 4. Backups and archive

| What | How | Kept |
|---|---|---|
| Database | Continuous WAL archiving plus a nightly base backup, encrypted, copied off the server. Fallback: hourly encrypted dumps | 30 days |
| Live files | Not backed up. Users hold the originals, and files past their live date go to the archive | n/a |
| Archive | Originals and viewer copies past their live date, encrypted, in off-server object storage (03 s5, 07 s2). This is the only off-server copy of files | Archive lifetime (07 s2) |
| Server | OVH VPS backup option, if included in the plan | Per OVH plan |

- 🟨 **OPEN:** backup method and recovery targets. Proposed: RPO 1 hour (at most 1 hour of database changes lost) and RTO 4 hours (service back within 4 hours of losing the server). WAL archiving meets the RPO with room; hourly dumps meet it only at the edge.
- 🟨 **OPEN:** off-site backup target (OVH Object Storage in a second region, or another provider).
- 🟨 **OPEN:** archive provider (for example OVH Object Storage in another region, or Backblaze B2). It becomes a subprocessor (07 s4).
- Archive files are encrypted before they leave the server. The key is held outside the archive: in a root-only file on the server, plus an offline copy Amaan holds.

Restore test, once a month: restore the latest base backup and WAL (or the latest dump) to a scratch server, time it against the RTO, and log the result. Restore one archived file the same day.

## 5. Monitoring and alerts

- Uptime check on `https://pd.shaavir.com/health` every minute.
- Disk alert at 80% used. The per-organization storage quota (06 s3) keeps one organization from filling the disk.
- Daily AI spend report from the usage table (see 04-ai-pipeline.md). Alert when spend passes 80% of the monthly cap.
- Daily Telnyx SMS spend alert (06 s1).
- Alert on failed archive moves, failed restores, and sandbox jobs stopped by a limit.
- Error tracking for api and worker. 🟨 **OPEN:** service choice. The service must scrub request bodies, headers, and cookies before sending, since request bodies can hold document text and phone numbers.
- Logs: Docker logs rotated daily, kept 14 days. Logs never contain document text, resumes, or phone numbers.

## 6. Deployment

- Code in a private GitHub repository under the Shaavir organization.
- GitHub Actions: run tests, build Docker images, push to GitHub Container Registry.
- Deploy: SSH into the server, pull images, `docker compose up -d`. Database migrations run as the owner role `pd_owner` in a separate step before the api restarts. The running app uses `pd_app` (02 s4).
- `infra/scripts/deploy.sh` does this in order: pull, build images (build context is the repo root), start `postgres` and `redis`, run `db:migrate` as `pd_owner` in the one-off `migrate` compose service, then `docker compose up -d`. A failed migration stops the deploy before the api and worker restart. The script never prints secrets; they come from `/opt/pd/.env` (root-only, mode 600).
- **Setting the `pd_app` password (out of band, never in a script or a migration).** The migration creates `pd_app` with `LOGIN` and no password. After the first successful migration on a server, set it once from the server shell, reading the value from the root-only env file so it never lands in shell history or a process list:

  ```
  docker compose --env-file /opt/pd/.env -f /opt/pd/infra/docker-compose.yml exec -T postgres \
    sh -c 'psql -U pd_owner -d pd -v ON_ERROR_STOP=1' <<< "ALTER ROLE pd_app PASSWORD '$(grep ^PD_APP_PASSWORD= /opt/pd/.env | cut -d= -f2-)';"
  ```

  Then run `deploy.sh` again (or restart `api` and `worker`). To rotate: change `PD_APP_PASSWORD` in `.env`, run the same `ALTER ROLE`, restart `api` and `worker`. `PD_APP_PASSWORD` must differ from `POSTGRES_PASSWORD`, and the value must not contain a single quote. Until it is set, the api and worker fail to log in and exit.
- Two environments: `staging` and `production`. The 8 GB server already has about 5.6 GB allocated to production containers (section 2.2), so a staging copy does not fit on it. If there is a staging server, it is a separate small VPS. 🟨 **OPEN:** whether to run a separate staging VPS.

## 7. Monthly running cost (estimate, provisional)

Assumptions: 50 users, up to 100 RFPs a month, ₹97 per US dollar. One RFP is a solicitation set: the solicitation, its amendments, and its attachments (04 s2), up to 50 MB on Free and 300 MB on paid plans. Its token count is larger than the 200 pages of solicitation that the v1 estimate used, and amendment runs add more.

🟨 **OPEN:** the AI figures on this page and in 04 s7 are provisional. Re-derive them from the providers' current price lists and Phase 1 measurements, with no provider caching assumed (04 s7 has the arithmetic).

| Item | Monthly |
|---|---|
| OVH US VPS, 8 GB | about ₹970 |
| AI, DeepInfra Qwen3.5-397B (first test model) | ₹6,000 to ₹11,300 (v1 estimate, provisional) |
| Telnyx SMS for phone verification | Small; depends on signups, plus a monthly 10DLC campaign fee 🟨 **OPEN:** check Telnyx US SMS and 10DLC rates |
| Email, monitoring, backups | ₹0 to ₹500 on free or low tiers |
| Archive storage | Small; depends on the provider and volume (archive provider OPEN, section 4) |
| If separate staging | A few dollars (🟨 **OPEN**, section 6) |
| Domain, TLS, Cloudflare | ₹0 (existing) |
| Buffer, 15% | about ₹1,050 to ₹1,900 |
| **Total** | **about ₹8,000 to ₹14,700, plus archive and staging. Provisional** |

AI cost changes with the model the test selects (v1 estimates, provisional; see 04 s7):

| Model | 100 RFPs a month |
|---|---|
| Anthropic Haiku 5.5 | about ₹1,100 |
| DeepInfra Qwen3.5-397B | about ₹6,000 to ₹11,300 |
| DeepInfra DeepSeek V4 Pro | about ₹9,500 |
| Anthropic Sonnet 5.5 | about ₹21,200 |

Add 18% GST under reverse charge for foreign providers (claimable as input credit if Shaavir is GST-registered) and card forex fees. Confirm with the accountant.

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

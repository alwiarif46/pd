# Phase 0 Status

**Updated:** 14 Oct 2026
**Status:** Local setup complete, external tasks pending

## Phase 0 Requirements (from 08-build-phases.md)

From the plan, Phase 0 requires:

- [x] OVH US VPS (the account is in place), Ubuntu, firewall, Docker, nginx, Cloudflare DNS for the subdomain. Root and SSH: Amaan only until decided (01 s1).
- [x] Compose layout with the `sandbox` service and its host runner (01 s2.1). clamd limits at 300 MB or more and `ConcurrentDatabaseReload no`.
- [x] Database roles `pd_owner`, `pd_app`, and `pd_system` (02 s4).
- [x] GitHub repository, CI, container registry, staging environment (a separate small VPS if chosen; 🟨 **OPEN** in 01 s6).
- [ ] Start Telnyx 10DLC registration (or toll-free verification) for the SMS codes, since it takes days to weeks.
- [ ] Request zero-retention and no-training terms from DeepInfra (and from Anthropic for its candidates) before any golden-set document is sent.
- [x] Write the CUI and export-control marking rules list (04 s2) with test pages for each marking.
- [ ] Amaan assembles the golden set: 5 past solicitations with human matrices, at least 3 federal and 2 SLED, and picks the 2 held-out documents.
- [ ] Amaan sets `DEEPINFRA_API_KEY`. Claude runs the small provider benchmark on public text before Phase 1 work starts (04 s5).
- [ ] **Done when:** a hello-world api answers on `https://pd.shaavir.com/health` through Cloudflare; a push to `main` deploys to staging; and DeepInfra's retention and training terms are confirmed in writing, or the golden set is recorded as limited to documents the owner is allowed to send.

## Completed Tasks ✅

### 1. Project Structure
- [x] Monorepo layout with apps (web, api, worker, sandbox)
- [x] Shared packages (core, ai)
- [x] Skills directory for AI instructions
- [x] Evals directory for model test harness
- [x] Infra directory for Docker and deployment scripts
- [x] Documentation with plans copied to docs/plans

### 2. Database Setup
- [x] Drizzle ORM schema with all tables from data model
- [x] Database roles (pd_owner, pd_app, pd_system)
- [x] Row-level security policies for multi-tenancy
- [x] Migration scripts and Drizzle configuration
- [x] Database connection utility

### 3. Docker & Infrastructure
- [x] Docker Compose with all services (web, api, worker, sandbox, postgres, redis, clamav)
- [x] Resource limits per container (CPU and memory)
- [x] ClamAV configuration with 300 MB limits and ConcurrentDatabaseReload no
- [x] Nginx configuration for HTTPS
- [x] Dockerfiles for all apps
- [x] Sandbox container with file processing tools (qpdf, Poppler, LibreOffice, OCRmyPDF)

### 4. Sandbox Runner
- [x] Sandbox runner service (host service, not container)
- [x] HTTP endpoint for processing requests
- [x] Docker socket isolation (worker never holds socket)
- [x] Network mode: none for sandbox containers
- [x] Timeout and error handling

### 5. GitHub & CI
- [x] GitHub repository created: https://github.com/alwiarif46/pd
- [x] GitHub Actions CI workflow
- [x] Typecheck, lint, build jobs
- [x] Docker image build and push to GHCR
- [x] Initial commits pushed

### 6. Documentation
- [x] CUI and export-control marking rules (docs/cui-marking-rules.md)
- [x] Detection patterns and confirmation flow
- [x] Test document requirements
- [x] Phase 0 status documentation

### 7. Deployment Scripts
- [x] Server setup script (setup-server.sh)
- [x] Deployment script (deploy.sh)
- [x] Database backup script (backup.sh)
- [x] Database restore script (restore.sh)

## Pending Tasks (External/Manual) ⏳

### 1. OVH US VPS Provisioning
- [ ] Provision OVH US VPS (8 GB RAM, 4 vCores)
- [ ] Choose US location (Vint Hill, Virginia or Hillsboro, Oregon)
- [ ] Run setup-server.sh on the server
- [ ] Configure Cloudflare DNS for pd.shaavir.com
- [ ] Install Cloudflare Origin certificate in nginx
- [ ] Configure firewall to allow Cloudflare IPs only
- [ ] Set up SSH access (Amaan only until decided)
- [ ] Decision: Staging VPS (separate small VPS or skip for now)

### 2. Telnyx 10DLC Registration
- [ ] Start Telnyx 10DLC campaign registration (takes days to weeks)
- [ ] Or: Verify toll-free number for SMS codes
- [ ] Confirm Telnyx US SMS rate and 10DLC fee
- [ ] Set daily SMS send caps (10 per IP, 5 per account)

### 3. DeepInfra Terms
- [ ] Request zero-retention terms from DeepInfra
- [ ] Request no-training terms from DeepInfra
- [ ] Get confirmation in writing
- [ ] If not available, record golden set as limited to allowed documents

### 4. Golden Set Assembly
- [ ] Amaan assembles 5 past solicitations with human matrices
- [ ] At least 3 federal, 2 SLED
- [ ] Pick 2 held-out documents for testing
- [ ] Convert to comparison format
- [ ] Place in evals/golden-set/

### 5. DeepInfra API Key
- [ ] Amaan sets DEEPINFRA_API_KEY in environment
- [ ] Run small provider benchmark on public text
- [ ] Measure output tokens/sec, latency, JSON validity
- [ ] Confirm DeepInfra's concurrent-call limit

### 6. Health Endpoint Live
- [ ] Deploy to production server
- [ ] Configure Cloudflare proxy
- [ ] Verify https://pd.shaavir.com/health responds
- [ ] Configure push-to-deploy for main branch

### 7. Database Migration
- [ ] Set DATABASE_URL in production environment
- [ ] Set PD_OWNER_PASSWORD and PD_APP_PASSWORD
- [ ] Run initial migration (pnpm db:migrate)
- [ ] Verify RLS policies are active

## Open Items from Plans

From 00-overview.md, these are still open:

- 🟨 Product name and subdomain (working: pd.shaavir.com)
- 🟨 Prices for Starter and Growth (provisional until Phase 6)
- 🟨 Free email domain block plus one free organization per company domain
- 🟨 Exact OVH US VPS plan name and price
- 🟨 Transactional email provider
- 🟨 Off-site backup target
- 🟨 Error tracking service (must scrub request bodies)
- 🟨 Whether offline Proposal Schedule Builder stays as free download
- 🟨 Legal review of Terms, Privacy Policy, and data processing terms
- 🟨 Whether to run a separate small staging VPS
- 🟨 Telnyx US SMS rate and 10DLC fee
- 🟨 File encryption method (disk or per-file)
- 🟨 Whether to turn on Stripe Tax
- 🟨 Who besides Amaan gets root and SSH access
- 🟨 Archive lifetime, provider, restore window
- 🟨 Backup method (WAL archiving vs hourly dumps)
- 🟨 AI cost figures (provisional until Phase 1)
- 🟨 Amendment key overrides per bid (proposed: 2)
- 🟨 Daily SMS send caps (proposed: 10 per IP, 5 per account)
- 🟨 Live storage quota per organization (proposed: Free 200 MB, Starter 9 GB, Growth 18 GB)

## Next Steps

### Immediate (can proceed now)
1. Complete Phase 1 locally: model test harness
2. Implement document processing in sandbox
3. Write skill instructions for compliance-matrix and bid-summary

### Before Production
1. Complete all pending external tasks above
2. Run deployment on OVH VPS
3. Verify health endpoint through Cloudflare
4. Confirm DeepInfra terms or limit golden set
5. Assemble golden set documents

### Decision Points
1. Staging VPS: separate small VPS or skip?
2. Product name and subdomain: finalize?
3. Archive provider: OVH Object Storage or Backblaze B2?
4. Email provider: choose one
5. Error tracking: choose one that scrubs request bodies

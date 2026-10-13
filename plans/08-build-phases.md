# 08 — Build Phases, Testing, and Launch

**Status:** Draft v2 · 13 Oct 2026

The model test comes before the app UI because its result sets the model, the cost, and the prices.

## Phase 0 — Setup

- OVH US VPS (the account is in place), Ubuntu, firewall, Docker, nginx, Cloudflare DNS for the subdomain. Root and SSH: Amaan only until decided (01 s1).
- Compose layout with the `sandbox` service and its host runner (01 s2.1). clamd limits at 300 MB or more and `ConcurrentDatabaseReload no`.
- Database roles `pd_owner`, `pd_app`, and `pd_system` (02 s4).
- GitHub repository, CI, container registry, staging environment (a separate small VPS if chosen; 🟨 **OPEN** in 01 s6).
- Start Telnyx 10DLC registration (or toll-free verification) for the SMS codes, since it takes days to weeks.
- Request zero-retention and no-training terms from DeepInfra (and from Anthropic for its candidates) before any golden-set document is sent.
- Write the CUI and export-control marking rules list (04 s2) with test pages for each marking.
- Amaan assembles the golden set: 5 past solicitations with human matrices, at least 3 federal and 2 SLED, and picks the 2 held-out documents.
- Amaan sets `DEEPINFRA_API_KEY`. Claude runs the small provider benchmark on public text before Phase 1 work starts (04 s5).
- **Done when:** a hello-world api answers on `https://pd.shaavir.com/health` through Cloudflare; a push to `main` deploys to staging; and DeepInfra's retention and training terms are confirmed in writing, or the golden set is recorded as limited to documents the owner is allowed to send.

## Phase 1 — Model test harness

- Document processing as a library, run in the sandbox: scan, encryption check, DOCX to PDF (Mammoth fallback), extract, OCR (`--jobs 2`), marking check, classify, chunk, pre-scan.
- Compliance matrix passes 1 to 6 with the provider layer and skill loader. Quote normalization and cross-page matching (04 s1). Pass 3 flags instead of drops.
- Amendment run with the amendment-diff step (04 s3.1), tested on golden solicitations that have amendments.
- Golden set converted to a comparison format and split: 3 for tuning, 2 held out.
- Harness scoring with the 80% quote-overlap match rule, both ways, plus a manual check of disagreements.
- Benchmark on the full pipeline: output tokens per second, latency per chunk, JSON validity rate, and the provider's concurrent-call limit.
- Run Qwen3.5-397B on DeepInfra first, then the other candidates.
- **Done when:** a report per model shows recall and precision on the held-out documents (and on all 5), due-date accuracy, the quote-check failure rate before drops and the count of dropped rows, time per 200-page text-layer PDF on an idle worker, measured time for scanned documents, the benchmark measures, and cost per RFP using the 04 s7 arithmetic; Amaan picks the model; and starting values are written down for provider concurrency, the per-bid cap, chunk size, the token budget per RFP, and the scanned-document time expectation.

## Phase 2 — Core app (free tabs)

- Auth (signup, email link, SMS code, login, reset) with `sessions` and `auth_tokens` in Postgres. SMS controls: +1 numbers only, daily caps per IP and per account, Telnyx spend alert.
- Organizations, members, invites. Row-level security with transaction-local `app.org_id` on every request and job.
- Bids list, new bid with bid type, upload sessions (20 MB chunks, declared size and sha256, MB cap per bid, 24-hour expiry), job progress with queue position.
- Encryption refusals, the marking prompt, and the upload refusals in 05 s3.10.
- Tabs: Overview and kickoff, Schedule (port), Compliance matrix with the source viewer (viewing tokens about 1 hour).
- Row detail slider (05 s3.12) and `row_history`.
- Amendment display: superseded, withdrawn, and added rows; "Confirm amendment changes"; date changes into the schedule prompt.
- Documents tab with MB used of the cap, live-until date, and archive status. Restore is a stub that shows the status flow; the real archive arrives in Phase 5.
- XLSX exports.
- **Done when:** a new user signs up, uploads a 200-page text-layer solicitation, and gets a compliance matrix with working source links in under 10 minutes on an idle staging worker; an amendment marks the right rows superseded, withdrawn, and added; and the slider shows every field in 05 s3.12.

## Phase 3 — Plans and billing

- Free plan periods: 2 then 1; a new free period with 1 on return to free; day of month clamped. `rfp_credits` as the source of truth.
- RFP credit rule: reserve at upload, consume when the compliance matrix succeeds, release on failure. One `solicitation_key` per bid. Same-sha256 re-uploads free. Amendment match and owner override limit.
- Seat limits, MB caps per plan, storage quota per organization, plan gating in the UI.
- Stripe Checkout; Customer Portal set so downgrades take effect at period end; webhooks stored in `stripe_events`, with plan and status taken from the fetched subscription.
- **Done when:** in Stripe test mode with test clocks, an organization upgrades, downgrades, goes `past_due`, then fails its final payment, and limits, credits, and free periods change correctly each time; out-of-order webhook events still give the right plan.

## Phase 4 — Paid tabs

- Outline and status tracker.
- Resume and key personnel matrix.
- Color team reviews.
- Production checklist.
- Orals.
- Lessons learned.
- Row detail slider and amendment rules on the paid tabs that hold source rows.
- **Done when:** each tab works on two golden solicitations, with resume matching checked by hand on 5 resumes.

## Phase 5 — Hardening

- Retention job: archive moves to off-server storage with the key held outside the archive, restores, archive purges on bid, organization, and user deletion, and resume deletion at 90 days.
- Backups by WAL archiving (or hourly dumps) with a restore test timed against the proposed RPO and RTO (01 s4). Monitoring and alerts, spend caps.
- Security review against 07-security-privacy.md, including:
  - cross-tenant access test (user A with user B's IDs);
  - row-level security pool test: a pool of size 1 serving two requests in a row from different organizations never sees the other's rows;
  - sandbox escape review: no network, no secrets, and limits hold against crafted PDF, DOCX, and XLSX files;
  - ClamAV scan of a 300 MB test file, to prove large files are scanned, not skipped.
- Load test: 50 users, 10 uploads at the same time, one 500-page scanned PDF. Before the test, write down the expected wait per upload from the measured concurrency. Judge the result against it.
- Legal pages live, with the disclosures in 07 s4.
- **Done when:** every item above passes and no tenant can read another tenant's data in testing.

## Phase 6 — Beta and launch

- Private beta with about 10 contractors from Shaavir's network, free plan only.
- Collect issues for 3 weeks; fix anything that breaks the 98% recall mark or the source links.
- Set final Starter and Growth prices from measured cost per RFP. Earlier prices are provisional.
- Public launch on shaavir.com.
- **Done when:** for every beta solicitation, a Shaavir writer checks the matrix against the solicitation and finds recall at 98% or higher, and prices are live in Stripe.

## Post-v1

- Admin tooling: screens and endpoints for AI settings, caps, credits, and plan changes. Until then Amaan changes these directly in the database (03 s4).
- More held-out test data from public solicitations (SAM.gov, state portals). This can start earlier if time allows.

## Testing summary

| Type | Where |
|---|---|
| Unit tests | Plan rules, credit rule, credit reservation (reserve, consume, release), free periods (2 then 1, new period with 1 on return, day-of-month clamp), MB cap per bid, one solicitation key per bid, same-sha256 re-upload, supersede and withdraw logic, quote normalization and cross-page match, marking detector, date logic, solicitation key |
| Model tests | `evals/` harness, scored on the held-out documents, rerun on every prompt or skill change |
| Integration tests | Upload to matrix on staging with a fixed sample solicitation; amendment run; DOCX conversion; owner-password PDF accepted and user-password PDF refused |
| Tenant isolation | User A requests every endpoint with user B's IDs and gets 404. A pool of size 1 serving two organizations in a row never returns the other's rows. Worker jobs checked the same way |
| Sandbox | No network, no secrets in its environment, runaway jobs stopped by the limits |
| Retention | Archive move, restore, purge on deletion, resume deletion at 90 days |
| Billing | Stripe test clock for period changes; out-of-order webhooks |
| Manual | Each tab against two golden solicitations before each release |

## Decision log

| Date | Decision |
|---|---|
| 13 Oct 2026 | Model test runs before the app UI |
| 13 Oct 2026 | 10DLC registration and golden set moved into Phase 0 |
| 13 Oct 2026 | Phase 0 adds provider terms confirmation in "done when", the sandbox service, database roles, the marking rules list, the held-out pick, and the provider benchmark |
| 13 Oct 2026 | Phase 1 adds benchmark measures, the held-out split, the 80% match rule, pre-drop quote failure reporting, the amendment-diff step, and DOCX conversion |
| 13 Oct 2026 | Phase 2 adds the row detail slider, amendment display, MB cap and upload sessions, and a restore stub |
| 13 Oct 2026 | Phase 3 adds credit reservation, free-period rules, and webhook handling by fetched subscription |
| 13 Oct 2026 | Phase 5 adds the archive job, the row-level security pool test, the sandbox escape review, and a load test judged against measured concurrency |
| 13 Oct 2026 | Admin tooling moved to Post-v1; final prices set in Phase 6 |
| 13 Oct 2026 | Testing summary updated for MB cap, supersede logic, credit reservation, free-period clamp, sandbox, and retention |

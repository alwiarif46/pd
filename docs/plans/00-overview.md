# Proposal Development Tool — Overview

**Status:** Draft v2 · 13 Oct 2026 · Owner: Amaan
**Folder:** `C:\Tools\PD\plans`
**How to use these plans:** each file covers one area. Update the "Decision log" in the relevant file when a decision changes during the build. Open items carry 🟨 **OPEN** and also appear in section 7 of this file.

## 1. What we are building

A web app on shaavir.com that helps government contractors plan and manage a proposal, for federal and SLED (state, local, education) bids. A user creates a bid, uploads the solicitation set (the solicitation, its amendments, and its attachments), and the app builds a compliance matrix, a schedule, and other proposal tools. Each bid opens in one workspace with tabs in a sidebar.

The app serves two goals:
1. Give small contractors a self-serve tool at a price they can pay.
2. Bring proposal service clients to Shaavir.

## 2. Plan files

| File | Covers |
|---|---|
| 00-overview.md | Product, decisions, scope, open items (this file) |
| 01-infrastructure.md | Hosting, server, sandbox, network, backups, archive, monitoring, cost |
| 02-architecture.md | Components, services, data flow, tenancy model, APIs |
| 03-data-model.md | Database tables and storage layout |
| 04-ai-pipeline.md | Document processing, AI steps, amendments, skills, model test |
| 05-ui.md | Layout, sidebar tabs, screens, row detail slider, states, plan gating |
| 06-accounts-billing.md | Signup, organizations, roles, plans, Stripe, usage limits |
| 07-security-privacy.md | Security controls, retention, archive, legal, abuse |
| 08-build-phases.md | Build order, acceptance checks, testing, launch |
| 09-ui-workflow.md | v0, Claude Code, and Cursor split; folder rules; CLAUDE.md; component contracts per tab |

## 3. Decisions made

| Area | Decision |
|---|---|
| Product shape | Web app: front end plus server with uploads and AI |
| Hosting | OVHcloud US VPS. The OVHcloud US account is in place. File processing runs in a sandbox container with no network and no secrets (01 s2.1) |
| AI | Provider-agnostic. First test: DeepInfra Qwen3.5-397B with Shaavir skills loaded by the app. AI concurrency is a per-provider setting (starting value 3) plus a per-bid cap, set from the Phase 1 benchmark |
| Model gate | A model goes live only if it passes every mark on the 2 held-out golden documents (3 others are for tuning): 98% recall, 95% precision (a row matches at 80% quote overlap), correct due dates, no row citing text missing from the solicitation, under 10 minutes per 200-page text-layer PDF on an idle worker. The quote-check failure rate before drops and the dropped-row count are reported (04 s5) |
| Signup | Work email plus phone verification (+1 US numbers at launch) |
| Free plan | 2 RFPs in the first month, then 1 RFP a month. Up to 2 users. 50 MB of files per bid |
| Starter plan | 10 RFPs a month. Up to 5 users. 300 MB of files per bid |
| Growth plan | 20 RFPs a month. Up to 5 users. 300 MB of files per bid |
| Billing | Monthly Stripe subscription per organization. The Stripe account takes USD subscriptions and US card payments |
| Prices | Set from measured cost per RFP. Provisional until Phase 6 sets final prices |
| Unused RFPs | Reset each month |
| One RFP | One solicitation set: the solicitation, its amendments, and its attachments. No page cap; the cap is MB per bid, all files added together. A credit is reserved at upload and consumed when the compliance matrix succeeds. One solicitation number per bid. An amendment counts only if its solicitation number matches, with a limited owner override for SLED addenda that omit it (06 s4) |
| Amendments | Processed as changes only. Rows overruled by an amendment stay, crossed out, marked "Superseded by Amd N" with a link to the new row. New rows show "Added by Amd N"; removed ones "Withdrawn by Amd N". Unsure links go to the user (04 s3.1) |
| Word files | DOCX accepted; converted to PDF in the sandbox so pages are real |
| Retention | Files stay live on the server 90 days (paid: until the later of upload + 90 and due date + 90 days; owner can extend), then move to an encrypted off-server archive the user can restore from. Page text stays until the bid is deleted. Resumes and their text are deleted at 90 days and never archived (07 s2) |
| Disclosures | Terms and Privacy Policy state that staff in India can technically access the server and that a China-origin model may process documents. The Privacy Policy and the app name the AI model and subprocessors |
| Marked files | A CUI and export-control marking check blocks AI processing until the user confirms the file may go to a third party |
| Admin tooling | Post-v1. In v1 Amaan changes AI settings, caps, and credits directly in the database |
| Root access | Amaan only until decided |
| Free tabs | Bid overview and kickoff, Schedule, Compliance matrix |
| Paid tabs | Outline and status tracker, Resume and key personnel matrix, Color team reviews, Production checklist, Orals, Lessons learned |
| Dropped from v1 | Competitor comparison, Win strategy, Section planner, Executive summary |
| Database | PostgreSQL, self-hosted in Docker. Free, with row-level security for tenants |
| Tooling | v0 writes screens into `design/v0/` on branch `v0-ui`; Claude Code integrates them into the app and owns containers, API, worker, and the schedule port; Cursor edits the app (09-ui-workflow.md) |

## 4. Sidebar tabs (v1)

| # | Tab | Plan | AI |
|---|---|---|---|
| 1 | Bid overview and kickoff | Free | Extracts bid facts from the solicitation set |
| 2 | Schedule | Free | Extracts dates; schedule logic ported from the offline Proposal Schedule Builder; amendment date changes trigger the shift, scale, or keep prompt |
| 3 | Compliance matrix | Free | Core: extract, verify, map instructions to evaluation factors (Section L to M on federal bids); amendments mark rows superseded, withdrawn, or added |
| 4 | Outline and status tracker | Paid | Builds the outline from the submission instructions |
| 5 | Resume and key personnel matrix | Paid | Matches resumes to requirements, flags gaps |
| 6 | Color team reviews | Paid | Scores a draft against the evaluation criteria |
| 7 | Production checklist | Paid | Extracts format and submission rules |
| 8 | Orals (switch on per bid) | Paid | Extracts orals instructions |
| 9 | Lessons learned | Paid | None in v1 |

Clicking a row in tabs 1 to 8 opens the row detail slider with the exact quote, document, page, amendment, and edit history (05 s3.12). Documents and Bid settings sit below the tabs on all plans.

## 5. Out of scope for v1

- Proposal drafting (narrative writing).
- Pricing tools and Basis of Estimate.
- FedRAMP or CMMC authorization. The app does not accept CUI or classified material. A marking check pauses AI work on marked files until the user confirms (07 s3).
- Co-editing in real time. The app saves per field; the last save wins.
- Mobile apps. The web app works on phones in read mode.
- Admin screens and endpoints (post-v1).

## 6. Success measures (first 6 months)

- Compliance matrix finds at least 98% of requirements on the held-out test documents, and no row cites text missing from the solicitation.
- Free users who become Shaavir service clients: target set at launch.
- Free organizations that upgrade to Starter or Growth: target set at launch.
- AI and hosting cost stays inside the monthly budget in 01-infrastructure.md.

## 7. Open items 🟨

1. 🟨 **OPEN:** product name and subdomain. Plans use the working subdomain `pd.shaavir.com` (01 s3).
2. 🟨 **OPEN:** prices for Starter and Growth. Provisional until Phase 6 sets them from measured cost (06 s3).
3. 🟨 **OPEN:** whether a free email domain block plus one free organization per company domain applies (proposed in 06 s1).
4. 🟨 **OPEN:** exact OVH US VPS plan with 8 GB RAM and 4 vCores, and its price (01 s1).
5. 🟨 **OPEN:** transactional email provider (02 s1), off-site backup target (01 s4), and error tracking service, which must scrub request bodies (01 s5).
6. 🟨 **OPEN:** whether the offline Proposal Schedule Builder stays as a free download beside the web app.
7. 🟨 **OPEN:** legal review of Terms, Privacy Policy, and data processing terms (US users, India's DPDP Act) (07 s4).
8. 🟨 **OPEN:** which OVH US location offers the chosen VPS (01 s1).
9. 🟨 **OPEN:** whether to run a separate small staging VPS. The 8 GB server has no room for a staging copy; cost a few dollars a month (01 s6, 01 s7, 08 Phase 0).
10. 🟨 **OPEN:** Telnyx US SMS rate and 10DLC fee (01 s7).
11. 🟨 **OPEN:** file encryption method on the server: disk encryption or per-file (03 s5).
12. 🟨 **OPEN:** whether to turn on Stripe Tax, from launch or once a nexus threshold is reached. A quarterly nexus check is decided (06 s5).
13. 🟨 **OPEN:** Telnyx 10DLC campaign registration or a verified toll-free number for SMS codes (06 s1).
14. 🟨 **OPEN:** who besides Amaan gets root and SSH access to the server (01 s1, 07 s1).
15. 🟨 **OPEN:** archive lifetime. Proposed: paid plans until the bid or organization is deleted; free plans 12 months, then deleted (06 s3, 07 s2).
16. 🟨 **OPEN:** archive provider, for example OVH Object Storage in another region or Backblaze B2 (01 s4, 02 s1, 07 s4).
17. 🟨 **OPEN:** restore window length, any restore fee or limit, and whether free users can restore (05 s3.10, 07 s2).
18. 🟨 **OPEN:** backup method and recovery targets. Proposed: WAL archiving, RPO 1 hour, RTO 4 hours (01 s4).
19. 🟨 **OPEN:** AI cost figures per RFP and per month are provisional. Re-derive from providers' current price lists and Phase 1 measurements, with no caching assumed (01 s7, 04 s7).
20. 🟨 **OPEN:** amendment key overrides allowed per bid. Proposed: 2 (06 s4).
21. 🟨 **OPEN:** daily SMS send caps. Proposed: 10 per IP address and 5 per account (06 s1).
22. 🟨 **OPEN:** live storage quota per organization. Proposed: Free 200 MB, Starter 9 GB, Growth 18 GB (06 s3).

## Decision log

| Date | Decision | Source |
|---|---|---|
| 13 Oct 2026 | Plans v1 written from chat decisions, reviewed three times, fixes applied | Chat with Amaan |
| 13 Oct 2026 | Pipeline generalised to federal and SLED bids; chunked uploads; 10DLC added to Phase 0 | Fable review |
| 13 Oct 2026 | Plans v2: MB cap per bid (50 MB Free, 300 MB paid), no page cap; solicitation set defined | Amaan |
| 13 Oct 2026 | Amendments processed as changes only; superseded rows kept and linked; row detail slider | Amaan |
| 13 Oct 2026 | Stripe account and OVHcloud US account confirmed | Amaan |
| 13 Oct 2026 | Model test protocol: 80% overlap match, 3 tuning and 2 held-out documents, pre-drop quote metric, text-layer time gate, Phase 1 benchmark | Amaan |
| 13 Oct 2026 | Archive approach for retention; page text kept until bid deletion except resumes (closes open item on page text) | Amaan |
| 13 Oct 2026 | India staff access and China-origin model disclosed; app names the model (closes open item on naming the model); DeepInfra terms moved into Phase 0 "done when" (closes open item on DeepInfra retention) | Amaan |
| 13 Oct 2026 | DOCX converted to PDF; admin tooling post-v1; staging stays open; root Amaan only until decided | Amaan |
| 13 Oct 2026 | Row-level security hardening, source columns, sandbox, ClamAV limits, quote normalization, cost arithmetic, CUI marking check, credit reservation, free-period rules, Stripe status rules, new tables, upload sessions, backups RPO and RTO, SMS controls, honest admin access statement, viewing tokens | Independent review |
| 13 Oct 2026 | Open items renumbered: 3 closed, 9 added | Plans v2 |
| 14 Oct 2026 | PostgreSQL confirmed; v0 / Claude Code / Cursor split added as 09-ui-workflow.md | Chat with Amaan |

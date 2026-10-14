# Proposal Development Tool — Overview

**Status:** Draft v1 · 13 Oct 2026 · Owner: Amaan
**Folder:** `C:\Tools\PD\plans`
**How to use these plans:** each file covers one area. Update the "Decision log" in the relevant file when a decision changes during the build. Open items carry 🟨 **OPEN** and also appear in section 7 of this file.

## 1. What we are building

A web app on shaavir.com that helps government contractors plan and manage a proposal, for federal and SLED (state, local, education) bids. A user creates a bid, uploads the solicitation, and the app builds a compliance matrix, a schedule, and other proposal tools. Each bid opens in one workspace with tabs in a sidebar.

The app serves two goals:
1. Give small contractors a self-serve tool at a price they can pay.
2. Bring proposal service clients to Shaavir.

## 2. Plan files

| File | Covers |
|---|---|
| 00-overview.md | Product, decisions, scope, open items (this file) |
| 01-infrastructure.md | Hosting, server, network, backups, monitoring, cost |
| 02-architecture.md | Components, services, data flow, tenancy model, APIs |
| 03-data-model.md | Database tables and storage layout |
| 04-ai-pipeline.md | Document processing, AI steps, skills, model test |
| 05-ui.md | Layout, sidebar tabs, screens, states, plan gating |
| 06-accounts-billing.md | Signup, organizations, roles, plans, Stripe, usage limits |
| 07-security-privacy.md | Security controls, retention, legal, abuse |
| 08-build-phases.md | Build order, acceptance checks, testing, launch |
| 09-ui-workflow.md | v0, Claude Code, and Cursor split; folder rules; CLAUDE.md; component contracts per tab |

## 3. Decisions made

| Area | Decision |
|---|---|
| Product shape | Web app: front end plus server with uploads and AI |
| Hosting | OVHcloud US VPS |
| AI | Provider-agnostic. First test: DeepInfra Qwen3.5-397B with Shaavir skills loaded by the app |
| Model gate | A model goes live only if it passes every mark in the model test on 5 past Shaavir RFPs: 98% recall, 95% precision, 100% quote check, correct due dates, under 10 minutes per 200 pages (04-ai-pipeline.md) |
| Signup | Work email plus phone verification |
| Free plan | 2 RFPs in the first month, then 1 RFP a month. Up to 2 users |
| Starter plan | 10 RFPs a month. Up to 5 users |
| Growth plan | 20 RFPs a month. Up to 5 users |
| Billing | Monthly Stripe subscription per organization. Stripe accepts US card payments for Shaavir |
| Prices | Set after the model test |
| Unused RFPs | Reset each month |
| One RFP | One solicitation, including its amendments. An amendment counts only if its solicitation number matches the original |
| Retention | Uploaded files deleted after 90 days |
| Free tabs | Bid overview and kickoff, Schedule, Compliance matrix |
| Paid tabs | Outline and status tracker, Resume and key personnel matrix, Color team reviews, Production checklist, Orals, Lessons learned |
| Dropped from v1 | Competitor comparison, Win strategy, Section planner, Executive summary |
| Database | PostgreSQL, self-hosted in Docker. Free, with row-level security for tenants |
| Tooling | v0 for presentational UI components, Claude Code for containers, API, worker, and the schedule port, Cursor for edits (09-ui-workflow.md) |

## 4. Sidebar tabs (v1)

| # | Tab | Plan | AI |
|---|---|---|---|
| 1 | Bid overview and kickoff | Free | Extracts bid facts from the solicitation |
| 2 | Schedule | Free | Extracts dates; schedule logic ported from the offline Proposal Schedule Builder |
| 3 | Compliance matrix | Free | Core: extract, verify, map instructions to evaluation factors (Section L to M on federal bids) |
| 4 | Outline and status tracker | Paid | Builds the outline from the submission instructions |
| 5 | Resume and key personnel matrix | Paid | Matches resumes to requirements, flags gaps |
| 6 | Color team reviews | Paid | Scores a draft against the evaluation criteria |
| 7 | Production checklist | Paid | Extracts format and submission rules |
| 8 | Orals (switch on per bid) | Paid | Extracts orals instructions |
| 9 | Lessons learned | Paid | None in v1 |

## 5. Out of scope for v1

- Proposal drafting (narrative writing).
- Pricing tools and Basis of Estimate.
- FedRAMP or CMMC authorization. The app does not accept CUI or classified material.
- Co-editing in real time. The app saves per field; the last save wins.
- Mobile apps. The web app works on phones in read mode.

## 6. Success measures (first 6 months)

- Compliance matrix finds at least 98% of requirements on the test set, and no row cites text missing from the solicitation.
- Free users who become Shaavir service clients: target set at launch.
- Free organizations that upgrade to Starter or Growth: target set at launch.
- AI and hosting cost stays inside the monthly budget in 01-infrastructure.md.

## 7. Open items 🟨

1. 🟨 **OPEN:** product name and subdomain. Plans use the working subdomain `pd.shaavir.com`.
2. 🟨 **OPEN:** prices for Starter and Growth (after the model test).
3. 🟨 **OPEN:** whether a free email domain block plus one free organization per company domain applies (proposed in 06-accounts-billing.md).
4. 🟨 **OPEN:** confirm that extracted page text deletes with its file at 90 days, while tab data (matrices, schedules) stays until the user deletes the bid (proposed in 03 and 07).
5. 🟨 **OPEN:** exact OVH US VPS plan with 8 GB RAM and 4 vCores, and its price (see 01-infrastructure.md).
6. 🟨 **OPEN:** transactional email provider, off-site backup storage, and error monitoring service.
7. 🟨 **OPEN:** whether the offline Proposal Schedule Builder stays as a free download beside the web app.
8. 🟨 **OPEN:** legal review of Terms, Privacy Policy, and data processing terms (US users, India's DPDP Act).
9. 🟨 **OPEN:** DeepInfra data retention terms for API inputs.
10. 🟨 **OPEN:** which OVH US location offers the chosen VPS (01).
11. 🟨 **OPEN:** separate staging server or a shared one (01).
12. 🟨 **OPEN:** Telnyx US SMS rate for verification codes (01).
13. 🟨 **OPEN:** file encryption method: disk encryption or per-file (03).
14. 🟨 **OPEN:** whether the app names the AI model in use (04).
15. 🟨 **OPEN:** whether to turn on Stripe Tax for US sales tax (06).
16. 🟨 **OPEN:** Telnyx 10DLC campaign registration or a verified toll-free number for SMS codes (06).

## Decision log

| Date | Decision | Source |
|---|---|---|
| 13 Oct 2026 | Plans v1 written from chat decisions, reviewed three times, fixes applied | Chat with Amaan |
| 13 Oct 2026 | Pipeline generalised to federal and SLED bids; chunked uploads; 10DLC added to Phase 0 | Fable review |
| 14 Oct 2026 | PostgreSQL confirmed; v0 / Claude Code / Cursor split added as 09-ui-workflow.md | Chat with Amaan |

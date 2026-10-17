# 07: Security, Privacy, and Legal

**Status:** Draft v2 · 17 Oct 2026

The tool inherits PD's security controls, retention rules, and abuse controls (PD 07). This file states what the tool adds or changes. Where it says nothing, PD's rule holds.

The tool writes federal offers for other firms. Two risks lead every choice here. One tenant's data must never reach another tenant. And no claim may enter an offer without evidence behind it.

## 1. Tenant isolation

Each client firm is a tenant. Its evidence, format specs, fonts, users, repository, runs, and Drive folder belong to it alone. Nothing crosses tenants.

| Layer | Control |
|---|---|
| Database | One schema per service, each with PD's row-level security on every tenant table: `FORCE ROW LEVEL SECURITY` and a transaction-local `tenant_id` (PD 07 s1). The identity service issues every `tenant_id`. Each service role reaches only its own schema (03 s12) |
| File storage | Every path starts with the tenant id (03 s11). Workers resolve paths from the job's tenant id, never from user input |
| Services and events | One run belongs to one tenant. Every request token and every event carries `tenant_id`, and each service checks it before any read or write (02 s6) |
| Model calls | Each Anthropic API call carries one tenant's data only. Skill text is the same for every tenant. Tenant data never enters a prompt part reused for another tenant |
| Render service | Each job gets its own scratch folder, removed when the job ends. Jobs from two tenants never share a folder or a process (01 s5) |
| Image provider | Prompts carry only the illustrative brief. No tenant documents go to the image provider |
| Browser agent | One sandbox per session, with a fresh browser profile. The tool destroys the profile, cookies, and cache when the session ends (01 s7) |
| Repository and learning loop | Learning from placeholders, dispositions, outcomes, and debriefs stays inside the tenant. No tenant's data trains, tunes, or calibrates another tenant's runs |
| Shaavir Drive | One folder per tenant, shared only with that tenant's users (s8) |
| Inbound email | Each tenant's inbound address maps to that tenant only. The tool drops and logs any message to an unknown address (02 s7) |

**Tests.** PD's cross-tenant tests apply to every new endpoint and job (08 s2). Added: a run for tenant A never reads a repository item, font, or format spec of tenant B.

## 2. Credentials and MFA

| Item | Rule |
|---|---|
| Portal credentials | Never stored. Not in the database, logs, queue, browser profile, or model context |
| Portal login | The user types credentials into the live agent session, or approves each step the agent takes. The session ends when the task ends |
| MFA | The user completes every MFA step: login.gov on SAM.gov, and each portal's own method elsewhere. The agent waits and never handles MFA codes or devices. 🟨 **OPEN:** confirm the current login and MFA method for PIEE, eBuy, and each state portal before the agent supports it |
| Portals that ban automation | SAM.gov's terms ban bots and scrapers. Such portals use upload or a guided checklist, never the agent. SAM.gov's public APIs are a separate, keyed route; whether the tool uses them is 🟨 **OPEN** (02 s7.4) |
| eBuy daily check | Runs only with a per-tenant login the user approves, or through a connector that holds no tenant secret. 🟨 **OPEN:** the method (02 s7.3) |
| Final submit | Always a human click. The agent has no path to it |
| Mailbox connections (Gmail, Microsoft 365) | A tenant Admin connects the tenant's own mailbox through an MCP connection. The tool needs ongoing access to send Q&A and requests and to collect replies |
| Anthropic and image provider keys | Server secrets, held only by the model gateway (PD 07 s1). No other service, the sandbox, or the portal agent gets one |
| Tenant user sign-in | Work email with MFA by authenticator app or passkey. Google and Microsoft SSO; SAML SSO for Enterprise. No SMS codes. Self-hosted Zitadel holds the credentials and MFA factors; no E2E service stores a password (06 s1; 09 s4.2) |

**MFA flow for an agent session:**
1. The user picks "Let the agent help" for a portal (05 s4.10).
2. The tool opens a fresh sandboxed browser and shows its view live.
3. The agent reaches the login page and stops.
4. The user enters credentials or approves the agent's entry, then completes MFA.
5. The agent checks the portal, downloads documents, and stores them in the bid.
6. The user ends the session, or it ends at task completion or timeout. The tool destroys the profile.

- 🟨 **OPEN:** how the tool holds mailbox access tokens. The "never stored" rule covers portal credentials. Sending and collecting replies needs a held token. Proposed: encrypted at rest, scoped to send and read the request threads, revocable from Settings, and removed on disconnect.
- 🟨 **OPEN:** browser agent implementation (Anthropic computer use, or Playwright driven by the model). The rules above hold either way (01 s7).
- 🟨 **OPEN:** session timeout length for agent sessions.

## 3. Email sending

- Email goes from the tenant's own address, through the tenant's connected mailbox. The tool never sends from a Shaavir address on a tenant's behalf.
- Q&A: a human reviews the questions and the email, then clicks Send (05 s4.5).
- Requests to third parties go out the same way, and replies return through the same connection.
- 🟨 **OPEN:** whether each request email needs a human click before sending. Proposed: yes, the same two review checkboxes as Q&A (05 s4.6).
- The audit log keeps every sent message with sender, recipients, time, and a copy of the body.

## 4. AI-ban flag

- At intake, code and one model call check the solicitation for clauses that ban or restrict AI-generated content (04 s5.1).
- A hit shows a banner that quotes the clause with its page (05 s4.1). It also shows in the bid/no-bid risk panel.
- Owner decision: the flag never stops the run. The run continues, and the tenant, as offeror, decides how to proceed.
- The audit log records the flag, and any user who dismisses the banner, with the time.

## 5. Accuracy and citations

An unsupported past performance or staffing claim is misrepresentation in a federal offer. The tool treats it as a defect, not a style issue.

| Rule | How the tool enforces it |
|---|---|
| Every claim cites evidence | Each past performance, staffing, figure, and capability claim carries an evidence citation to a tenant document and page |
| No evidence, no claim | A missing fact becomes a NEED placeholder. The model never invents it |
| Assembly blocks uncited claims | The package does not build while any claim lacks a citation (05 s4.9) |
| Masking is human | Only a person can mask a NEED and write around the missing fact (04 s6) |
| Locks hold | A human-edited block never changes without approval (04 s8) |
| Separate reviewer | The Red review runs on a different model from the drafter, enforced by the model gateway. 🟨 **OPEN:** reviewer model |
| Pricing | The pricing skill suggests; a human approves every price and pricing narrative |
| Tenant responsibility | The Terms state that the tenant, as offeror, owns the content and its accuracy |

## 6. Signatures, reps, and certs

- The tool fills form details: SF 33, SF 1449, reps and certs, pricing sheets, cover letter.
- The tool never signs. It applies no signature, initials, or signature image.
- At package delivery the tool lists what needs a signature and what needs review. Reps and certs always need review (05 s4.10).
- Reps and certs carry legal weight for the offeror. The tool marks every prefilled answer as "Review before you sign".

## 7. Data retention

| Data | Kept |
|---|---|
| Solicitation files, page text, viewer copies | PD's rules (PD 07 s2) |
| Run state, stages, drafts, findings, dispositions | Until the tenant deletes the bid |
| Repository items | Until the tenant deletes the item or the tenant account. The learning loop needs them across bids |
| Resumes | 🟨 **OPEN:** PD deletes resumes at 90 days. The repository keeps resumes for reuse. One rule must win, or the repository needs consent to keep them |
| Collected third-party items (commitment letters, consents, partner forms) | With the bid. 🟨 **OPEN:** whether they also enter the repository |
| Q&A and request emails | With the bid |
| Agent session data | None kept beyond downloaded documents and the action log |
| Final packages | With the bid until the tenant deletes it |
| Shaavir Drive copies | 🟨 **OPEN:** whether Drive copies follow the bid's deletion automatically |
| Database backups | PD's 30 days (PD 07 s2) |

- Deleting a bid or the tenant account follows PD's deletion and backup timing (PD 07 s2), extended to repository items and Drive copies.

## 8. Shaavir Drive storage

- Every tenant uses Shaavir Drive. The Pink review document and working documents live there.
- Each tenant gets its own folder, shared only with that tenant's users.
- Tenant users can open and add to their folder at any time.
- Shaavir administrators can access every folder. The Terms and Privacy Policy say so.
- Removing a user from a tenant removes their access to the folder.
- 🟨 **OPEN:** which Drive service backs Shaavir Drive. It becomes a subprocessor (s9).

## 9. Subprocessors

| Subprocessor | What it processes |
|---|---|
| Anthropic | All model work: drafting, review, extraction, vision page checks, the browser agent |
| Image provider (GPT Image 2) | Illustrative art prompts only |
| Hosting provider | All stored data. 🟨 **OPEN:** provider, chosen after the tool is built (01 s1) |
| Shaavir Drive service | Pink review and working documents |
| Stripe | Billing |
| Inbound email service | eBuy notices sent to tenant inbound addresses |
| Backup target, error tracking, email provider | As in PD (PD 07 s4) |

- The tenant's own Gmail or Microsoft 365 mailbox is the tenant's service, not a Shaavir subprocessor. The Privacy Policy explains the data flow through it.
- Zero-retention and no-training terms: Owner decision. The tool runs the 10-RFP test first, on documents the Owner may send under standard terms. The terms with Anthropic and the image provider then change. Only then does the tool ship (08 Phase 9; 08 Phase 10).

## 10. Disclosures

The Terms of Service and Privacy Policy state:
- Documents go to Anthropic for AI processing, and image prompts go to the image provider.
- The subprocessor list in s9.
- Shaavir's Drive stores client data, and Shaavir administrators can access it.
- Support staff and server administrators in India can technically access the server (inherited from PD 07 s3).
- The CUI and export-control marking check (PD 07 s3).
- The tool flags AI-ban clauses, and the tenant decides how to proceed.
- The tenant owns the accuracy of every claim and every signature.
- Retention and deletion timing (s7).
- The provider terms on retention and training that Anthropic and the image provider actually give.

The app names the AI providers and subprocessors on the Data and AI settings page (05 s6).

## 11. Legal documents before launch

- Terms of Service
- Privacy Policy
- Data processing terms for tenants
- Subprocessor list
- Acceptable use terms: no CUI, classified material, or export-controlled technical data (PD 07 s3)
- Font request terms: the fee covers the request and does not license the font; the tenant confirms it holds the license
- Fonts on the render service: Microsoft licenses its fonts with Windows and Windows Server. The Linux render service ships none and uses metric-compatible open fonts (01 s5.4)
- Zitadel license: Zitadel moved to AGPL-3.0 in late 2024, so confirm the license file of the pinned release at install. Running it unmodified behind our API carries no source-publication duty. Any change to Zitadel's own source gets published on our site under AGPL, as the Owner decided (09 s4.2)

🟨 **OPEN:** legal review. Shaavir is an Indian entity serving US firms. India's Digital Personal Data Protection Act and US state privacy laws both apply. The review should also cover AI-ban clauses and the offeror's liability for claims.

## 12. Abuse and cost controls

PD's abuse table holds (PD 07 s5). Added:

| Risk | Control |
|---|---|
| Runaway run cost | Per-run cost cap counting model and image spend; the run pauses at the cap (01 s8) |
| Oversized proposals | 100 drafted pages per proposal; beyond that, the recharge (06 s5) |
| Inbound email abuse | Unknown inbound addresses dropped; per-address rate limit; attachments scanned like uploads |
| Cross-service access | Each service's database role reaches only its own schema; services share data only through APIs and events (03 s12) |
| Agent misuse | Agent sessions only on portals the tenant picked, with a human present; no stored credentials; full action log |
| Mail sent in error | Q&A always needs a human send click; every message logged |
| Font licensing | Commercial fonts installed only with a license confirmation, logged |

## Decision log

| Date | Decision |
|---|---|
| 17 Oct 2026 | Inherit PD security, retention, and abuse controls; this file lists additions |
| 17 Oct 2026 | Nothing crosses tenants: database, files, model calls, worker jobs, agent sessions, learning loop, Drive |
| 17 Oct 2026 | Portal credentials never stored; human completes every login and MFA; final submit is human |
| 17 Oct 2026 | Banned-automation portals (SAM.gov) use upload or a checklist only |
| 17 Oct 2026 | Email goes from the tenant's own mailbox through its connection; Q&A needs a human send |
| 17 Oct 2026 | AI-ban clauses flagged at intake and logged in the audit log |
| 17 Oct 2026 | Every claim needs an evidence citation; assembly blocks uncited claims |
| 17 Oct 2026 | The tool fills forms and never signs; reps and certs always need review |
| 17 Oct 2026 | Shaavir Drive used for every tenant, one folder per tenant; disclosed |
| 17 Oct 2026 | Disclosures cover AI processing, the image provider, subprocessors, and Drive storage |
| 17 Oct 2026 | Review pass: portal MFA claim hedged per portal; SAM.gov public API and eBuy daily-check login added as OPEN; AI-ban check moved from shred to intake |
| 17 Oct 2026 | Owner decision: an AI-ban hit flags and lets the run continue |
| 17 Oct 2026 | Owner decision: zero-retention terms after the 10-RFP test and before launch |
| 17 Oct 2026 | Owner confirmed: the 10-RFP test runs under the providers' standard terms; terms move to zero retention before shipping |
| 17 Oct 2026 | Owner decision: tenant users sign in with work email and authenticator app or passkey MFA, or Google, Microsoft, or SAML SSO; no SMS |
| 17 Oct 2026 | Owner decision: one schema per service with row-level security in each; no cross-service database access |
| 17 Oct 2026 | Owner decision: no Microsoft fonts on the Linux render service; the core fonts EULA item is closed |
| 17 Oct 2026 | Owner decision: self-hosted Zitadel holds credentials and MFA; its AGPL duty noted in s11 (item 61 closed) |

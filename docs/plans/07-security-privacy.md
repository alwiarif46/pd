# 07 — Security, Privacy, and Abuse

**Status:** Draft v2 · 13 Oct 2026

## 1. Security controls

| Area | Control |
|---|---|
| Transport | HTTPS only via Cloudflare and nginx. HSTS on |
| Passwords | Argon2id hashes. Lockout after 10 failed logins in 15 minutes |
| Sessions | Stored in the Postgres `sessions` table. HttpOnly, Secure, SameSite=Lax cookies. 14-day sessions, revoked on password change. CSRF token on every state-changing request |
| Tenancy | Row-level security with `FORCE ROW LEVEL SECURITY` on every tenant table. Every request and job sets `app.org_id` transaction-local. The app role `pd_app` is not the table owner and has `NOBYPASSRLS`; migrations run as `pd_owner`; jobs with no org context use named `pd_system` functions only. Membership checks in the api as well (02 s4) |
| Files | Virus scan (clamd limits at 300 MB or more), type check by content (not extension), MB cap per bid, encryption check, page-count check before OCR, encrypted at rest, served only through per-document viewing tokens valid about 1 hour and bound to the session |
| File processing | Only in the sandbox container: no network, no secrets, non-root, read-only mount of the one file, seccomp and AppArmor, hard time, CPU, and memory limits (01 s2.1) |
| Secrets | API keys in environment files readable only by root and the containers that need them. Never in the repo. The sandbox gets none |
| Server | SSH keys only, firewall limited to Cloudflare ranges, automatic security updates. Root and SSH: Amaan only until decided. 🟨 **OPEN:** who else gets root. SSH sessions are logged |
| Dependencies | Weekly dependency audit in CI |
| Logs | No document text, resumes, quotes, or phone numbers in logs. The error tracking service scrubs request bodies, headers, and cookies (01 s5) |
| Admin access | No admin screen shows customer documents (there are no admin screens in v1). Staff with root on the server can technically read files and the database. Root is limited to named people (Amaan only until decided), and SSH sessions are logged. Support access to a customer's documents needs the customer's written approval and is logged in `audit_log`. This is a written procedure, not a screen |

## 2. Data retention

| Data | Kept |
|---|---|
| Original files on the server (not resumes) | Free: 90 days from upload. Starter and Growth: until the later of upload + 90 days and the bid due date + 90 days; the owner can extend |
| Viewer copies (OCR'd PDF, Word converted to PDF) | Same as the original |
| Files after their live date | Moved to an encrypted archive in off-server object storage; the server copy is deleted. 🟨 **OPEN:** archive lifetime. Proposed: paid plans until the bid or organization is deleted; free plans 12 months, then deleted |
| Restored files | Back on the server for a limited window after a short wait, then deleted from the server again. The archive copy stays. 🟨 **OPEN:** restore window length, any fee or limit, and whether free users can restore |
| Page text (`pages`), not resumes | Until the bid is deleted. This keeps source quotes, the viewer's page text, and the paid tabs (Outline, Reviews, Production) working after the file leaves the server |
| Resumes (kind `resume`), their page text, and `resume_matches.evidence_quote` | Deleted 90 days after upload. Never archived. Candidate names stay in the resume matrix as part of the tab data |
| Tab data (matrices, schedules, reviews, candidate names) | Until the user deletes the bid or the organization |
| Exports | 24 hours |
| Upload chunks of abandoned sessions | 24 hours |
| Database backups | 30 days |
| Account data after organization deletion | Deleted within 30 days, except billing records kept for tax law |

**Deletion and backups, stated plainly:**
- Deleting a bid or an organization, or a user's deletion request, deletes the rows, page text, server files, and archive copies. The nightly job purges archive copies, normally the next night. The archive provider may keep deleted objects for a short time after that; its stated delay goes into the Privacy Policy once the provider is chosen.
- Database backups hold page text and rows, and are kept 30 days. Deleted data leaves the last backup within 30 days of deletion.
- Organization deletion finishes within 30 days, and backups run 30 days more. So an organization's data can remain in backups for up to about 60 days in total.
- Resume text deleted at 90 days can remain in database backups for up to 30 days more.
- Files are not in database backups. The archive is the only off-server copy of files (01 s4).

Users see the live-until date and the archive status on each document.

## 3. What users may upload

Terms of use and the upload screen state:
- No Controlled Unclassified Information (CUI), classified material, or export-controlled technical data.
- **Marking check.** The app searches pages 1 to 3 and page headers and footers for CUI and export-control markings (04 s2). If it finds one, AI processing stops until the user confirms the file is public or approved for third-party processing. The confirmation, user, and time go to `audit_log`. The Terms and Privacy Policy describe this check. It is a safeguard, not a guarantee; the user stays responsible for what they upload.
- Resumes may hold personal data. The organization confirms it has permission to process them.
- Documents go to a third-party AI provider for processing. The Privacy Policy and the app name the AI model and provider in use. If a China-origin model (for example Qwen or DeepSeek) wins the model test, it may process users' documents. The Terms and Privacy Policy say so plainly.
- Shaavir requests zero-retention and no-training terms from DeepInfra. Confirmation is part of Phase 0's "done when", before any golden-set document is sent (08). The Privacy Policy states the terms the provider actually gives.
- Shaavir's support staff and server administrators are in India and can technically access the server. The Terms and Privacy Policy say so plainly.

## 4. Legal documents needed before launch

- Terms of Service
- Privacy Policy
- Data processing terms for organizations
- Subprocessor list: the hosting provider named by `[infra] provider` (OVHcloud US, Hetzner Online, or the company behind an `ssh`-adapter server), the off-site backup target (Backblaze B2, proposed), DeepInfra (AI), Anthropic (AI, if used), Stripe, Telnyx, email provider, archive storage provider (🟨 **OPEN**, 01 s4), off-site backup target, error tracking service

The Terms and Privacy Policy disclose:
- The AI model and provider in use, and that a China-origin model may process documents.
- That support staff and server administrators in India can technically access the server.
- The subprocessors above, including the archive and its provider.
- Live retention, the archive and its lifetime, restores, resume deletion at 90 days, and backup timing (section 2).
- The CUI and export-control marking check (section 3).

🟨 **OPEN:** legal review. Shaavir is an Indian entity serving US users, so India's Digital Personal Data Protection Act and US state privacy laws both apply.

## 5. Abuse controls

| Risk | Control |
|---|---|
| Fake accounts for free RFPs | Work email only, phone verification, one phone per account, proposed one free organization per domain |
| SMS pumping | +1 (US) numbers only at launch, per-number limit, daily caps per IP and per account, daily Telnyx spend alert (06 s1) |
| Amendment loophole | Amendment must match the solicitation number. Owner override needs a logged reason and is limited per bid |
| Swapping the RFP in a bid | One `solicitation_key` per bid; a solicitation file with a different key is refused (06 s4) |
| Large uploads | MB cap per bid (50 MB Free, 300 MB paid), per-organization storage quota, upload sessions with declared size and sha256 that expire after 24 hours |
| Cost spikes | MB cap per bid, token budget per RFP, per-organization daily AI cap, global monthly spend cap |
| Brute force | Cloudflare rate limits on auth, login lockout |
| Malicious files | ClamAV with 300 MB limits, content-type check, encryption and page-count checks, and all file parsing (PDF, DOCX, XLSX, OCR) in the sandbox with no network, no secrets, and hard limits |
| Scraping or bulk use | Request rate limits per user and per organization |

## Decision log

| Date | Decision |
|---|---|
| 13 Oct 2026 | 90-day file deletion, no CUI uploads, separate server |
| 13 Oct 2026 | Archive replaces deletion: files past their live date go to an encrypted off-server archive; paid live retention runs to the later of upload + 90 and due date + 90 days |
| 13 Oct 2026 | Page text kept until the bid is deleted, except resumes; resumes and evidence quotes deleted at 90 days, never archived; candidate names stay (closes the v1 page-text open item) |
| 13 Oct 2026 | Bid, organization, and user deletion purge archive copies; backup timing stated, up to about 60 days for organization deletion |
| 13 Oct 2026 | Admin access statement made honest: root can technically read files; root limited to named people; SSH logged; support access by written approval |
| 13 Oct 2026 | Disclosed in Terms and Privacy Policy: staff in India can access the server; a China-origin model may process documents; model and subprocessors named |
| 13 Oct 2026 | DeepInfra terms confirmation moved into Phase 0's "done when" |
| 13 Oct 2026 | CUI and export-control marking check blocks AI work until the user confirms; logged and disclosed |
| 13 Oct 2026 | Row-level security hardening, sandbox for file processing, clamd 300 MB limits, encryption check by qpdf and pdfinfo |
| 13 Oct 2026 | Viewing tokens about 1 hour bound to the session; error tracking scrubs request bodies |
| 13 Oct 2026 | Abuse table updated: SMS pumping, RFP swap, large uploads, sandbox |

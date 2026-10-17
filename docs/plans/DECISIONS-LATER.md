# Owner decisions after PLAN-BRIEF.md (17 Oct 2026). These override the brief where they differ.

1. Working name: E2E Proposal. Final name OPEN (trademark and domain check).
2. PD does not exist as a separate app. E2E absorbs PD fully: PD's code becomes E2E services; PD's tabs (overview, schedule, compliance matrix, outline, resumes, reviews, production, orals, lessons) become E2E features. No PD lighter UI. PD's Free/Starter/Growth plans dropped.
3. Repo: no new repo. The PD GitHub repo is renamed to E2E Proposal and becomes the monorepo. History, CI, secret scan, hooks, infra tests, open PR branches stay. PD PRs #35 to #38 are finished inside the renamed repo. First PR restructures into services/, packages/, python/ (uv), rewrites CLAUDE.md, moves E2E plans into docs/plans, archives PD plans under docs/plans/archive-pd/. No code copy, no parity check. C:\Tools\E2E holds working files only.
4. Architecture: microservices (15 services, see 09). One Postgres cluster, schema per service, RLS in each. Events: Redis Streams on the self-hosted Redis (no NATS). S3-compatible object storage. Hosted Redis free tier is test-only.
5. Hosting decided after the tool is built.
6. Identity: self-hosted Zitadel (AGPL-3.0) wrapped by the identity service, which owns tenant_id; PD org_id maps to it. Unmodified where possible; any change to Zitadel source is published on our site. Sign-in: work email plus authenticator app or passkey MFA, Google and Microsoft SSO, SAML for Enterprise. No SMS verification.
7. Stage order: format lock BEFORE outline. Stage skills will be rebuilt later by the owner; tool is built first with current skills behind a stage interface.
8. AI-ban hit at intake: flag, run continues.
9. Proposal credit: reserved at run start; released on no-bid, or when the run fails or is cancelled before the Red draft; consumed when the Red draft is delivered.
10. Free tier: one free proposal per tenant, once only, up to 50 drafted pages. Abuse-control details Proposed/OPEN.
11. Monthly plans unchanged (1800/3, 2200/4, 2500/5, Enterprise), monthly reset, 100 drafted pages per proposal, recharge beyond.
12. Zero-retention: the 10-RFP test runs under providers' standard terms; zero-retention terms in place before shipping.
13. 10-RFP test before launch. Pass bar: every package complete and page-verified, zero uncited claims, zero cross-tenant reads, 8 of 10 rated submittable. Per-run cost cap set from the test.
14. Rendering: LibreOffice headless (free, MPL 2.0) DOCX to PDF on Linux; code-computed field numbering (TOC, captions, cross-references); metric-compatible fonts on Linux (Windows Server licenses its own fonts).

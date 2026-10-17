# Brief: plan set for the one-click proposal tool ("the tool")

Working folder: /tmp/claude-0/-home-claude/72535dff-8a00-5f2e-ad15-68d631db1cd2/scratchpad/plan
Write plan files into `plan/docs/`. This brief is the only source of decisions. Do not invent decisions; anything not settled here is an OPEN item.

## Reference material (read what your files need)
- PD plans (the sibling product this tool reuses): /mnt/user-data/uploads/PD/docs/plans/00-overview.md to 09-ui-workflow.md. Mirror their style: numbered sections, tables, "Decision log" table at the end, open items marked `🟨 **OPEN:**`, cross-references like (04 s3.1).
- bid-autopilot plugin (the skills and scripts the tool runs): /root/.claude/plugins/synced/5cee5d2c-85ee-47b6-a479-f48b0161be9b_1dc6fea8-7a6a-49c7-9676-5ba0c38f16c9/bid-autopilot/ (README.md, skills/*/SKILL.md, scripts/). Read SKILL.md frontmatter and headings; read deeper only where your file needs it.
- Stripped tenant-neutral skill copies and their review: /tmp/claude-0/-home-claude/72535dff-8a00-5f2e-ad15-68d631db1cd2/scratchpad/pd-skills/ and findings/r2-*.md.

## Writing rules (hard)
- Sentences 30 words max, lengths varied. Active voice. No em dashes (U+2014) anywhere. Plain words. Write so it does not read as AI-generated.
- Name no Shaavir staff. Owner of a decision: "Owner" (the product owner).
- The tool is sold to other firms. Each tenant is a client firm (the offeror). Shaavir is the vendor.

## Product
A multi-tenant web app sold to government contractors (federal and SLED). Goal: a proposal done with one click. It runs the bid-autopilot skills as a backend pipeline. It reuses PD's pipeline (upload, scan, sandbox, extraction, OCR, marking check, classify, shred, compliance matrix, schedule, amendment key check and diff). It is a platform for sale, not only for Shaavir's own users.

## Platform decisions
- Each client firm is a tenant with isolated evidence, format specs, fonts, users, and repository. All client data is scoped to its own tenant. Nothing crosses tenants.
- Backend orchestrator runs the 24 skills as a pipeline on the Anthropic API. State is saved per stage for resume. Durable job queue, idempotent stages, retries, Anthropic rate-limit handling, a cost cap per run.
- Skills' scripts move to the render/worker server and are called as tools by the orchestrator.
- Render server: SVG graphics, Word assembly (python-docx), PDF render, page verify, PDF export.
- Image provider (GPT Image 2) only for illustrative art.
- Red review uses a separate reviewer: a different model from the drafter. Which model: OPEN (decide later).
- Built on PD (reuse its pipeline and stack).

## Run flow (decided)
**Gate 0: Intake (soft).** Mandatory input is the RFP (solicitation package) only. Past performances are optional; some are already in the tool (tenant repo). Everything else must be uploaded before the Red review. Intake must stay soft: users get annoyed with many questions ("why use a tool if we do all the work"). So the tool first fetches from the tenant repo and shows "we already have this" and "we still need this", with the mandatory items marked. Drafting proceeds with placeholders (NEEDs) until inputs arrive.
**Gate 0b: Bid/no-bid.** After the shred: the tool scores fit, eligibility, past performance coverage, risk. A human decides.
**AI-ban check at intake.** If the solicitation bans or restricts AI-generated content, flag it at intake.
**Run (automatic):** amendment gate, shred, compliance matrix, scoresheet, outline, format lock; Q&A questions drafted (see Q&A); Pink review document available in Shaavir Drive (see Drive); evidence pull, vignettes, agency intel; page-gated drafting at 90% with per-page checks, in parallel by volume and section; graphics; executive summary; pricing narrative (pricing skill suggests, human approves); Red team review by the separate reviewer model.
**Mid-run, any time:**
- Amendment re-entry: an amendment (uploaded, or caught by the eBuy watcher) is diffed, reopens affected pages, and re-gates.
- Q&A: the pipeline drafts questions in the format the solicitation requires. Sometimes the agency provides a questionnaire document to fill; the tool fills it. The draft questions and the draft email show in the tool. The human reviews the questions, reviews the email, then sends. Email goes from the client's own address, sent from the tool, through Gmail and Microsoft 365 email connections (MCP) the tenant connects. Q&A deadline alert.
- Request and collect: commitment letters, partner past performance forms, resume consents and similar third-party items. The tool sends a request in the required format to the requestee by email (tenant's mailbox via the email connections) and collects the replies through the same email connection, plus an upload option. Status tracked per item.
**Gate 1: after Red.** Reviewer sees Red findings, NEEDs, scores per page; a predicted rating per evaluation factor; NEEDs ranked by score impact. Accepts, edits, or rejects each finding; fills NEEDs; approves to continue. Any block a human edits is locked (see Locks).
**Run (automatic):** applies dispositions; re-drafts flagged pages around locked blocks; re-gates; cross-volume sweep; assembly; PDF render and visual check; page count; Gold Team and White Glove review.
**Gate 2: after Gold.** Reviewer sees a round-by-round diff (what changed between rounds, page by page), confirms final volumes, signs off.
**Final package (one download):** all volumes in Word and PDF, page-verified; completed forms (SF 33/1449, reps and certs, pricing sheets, cover letter); attachments (resumes, past performance forms, commitment letters, certificates); compliance matrix; submission checklist; file naming per the solicitation. Signatures: the tool fills the details, the client signs; at package delivery the tool notifies what needs a signature and what needs review (for example reps and certs need review).
**Submission (optional):** see Portals.

## Locks (decided)
Every block a human edits gets a lock. A re-draft treats locked blocks as fixed text and writes around them. If the model thinks a locked block must change, it proposes a change for approval; it never edits it silently. The sweep obeys locks too.

## Page verification (decided)
About 99% of submissions are PDF: the tool renders to PDF, rasterizes every page, and a vision model checks layout (overflow, broken tables, cut-off graphics, orphan headings, margins). Page count is measured on the exact PDF submitted. For the about 1% that require Word files: accept, and add a note at the end of the package telling the user to check the page limit in Word.

## Fonts (decided)
Preinstall TNR and Arial plus whatever else is free: Microsoft's redistributable core fonts (Times New Roman, Arial, Georgia, Verdana, Trebuchet MS, Courier New) and open-licensed fonts (Liberation, Carlito, Caladea, Noto Sans and Serif, Source Sans and Serif, Roboto, Open Sans, Lato). Render server may use metric-compatible fonts (Liberation Serif for TNR, Liberation Sans for Arial, Carlito for Calibri). A "request a font" option: client requests a font, Shaavir charges the client separately, once. A commercial font (Calibri, Cambria, Garamond) needs the client's own license: the request flow takes a font upload plus the client's license confirmation. The fee does not license the font.

## Portals (decided)
Users choose: (a) give approval while the agent (a browser agent on the Anthropic API) checks the portal, downloads and stores documents, with the human present to approve each login and MFA (login.gov MFA on SAM, PIEE, eBuy); credentials are never stored; or (b) upload files themselves. Portals that ban automation (SAM.gov bans bots) use upload or a guided checklist, never the agent. The final submit click is always a human's.

## eBuy watcher (decided, test first)
Each tenant gets an inbound address (for example tenantname@in.<tool domain>). The tenant adds it in eBuy or sets a forwarding rule. The tool parses the RFQ number and opens a bid. Emails sometimes do not arrive, so a daily check covers misses: through the existing eBuy connector, or the browser agent with user-approved login. How a competitor registers its address in eBuy is unverified; test on one tenant first.

## Shaavir Drive (decided)
Used for every tenant: Pink review document and working documents live there, so tenants can check the doc and add anything at any time. Each tenant gets its own folder shared only with that tenant's users. Privacy disclosures state client data is stored in Shaavir's Drive.

## Legal and disclosure (decided)
- Disclosures cover AI processing (Anthropic, the image provider), subprocessors, and Drive storage.
- AI-ban clauses flagged at intake.
- Accuracy: an unsupported past performance or staffing claim is misrepresentation in a federal offer. Every claim needs an evidence citation; assembly blocks uncited claims.
- Signatures, reps and certs: client signs and reviews; the tool never signs.
- Zero-retention terms from Anthropic and the image provider: OPEN (request).

## Learning loop and repository (decided)
Learning from filled placeholders and reviewer dispositions. A per-tenant repository of past proposal sections, designs, graphics, and every other part of the proposal, stored in an organized way and fetchable in an organized way (by agency, factor, section type, contract, date). Award outcome and debrief feed back into the repo and gate calibration. Never shared across tenants. Intake fetches from it first.

## Plans and billing (decided)
- Monthly plans: 1800 for 3 proposals, 2200 for 4, 2500 for 5. Enterprise by discussion. Currency: USD assumed (OPEN to confirm).
- Unused proposals reset every month.
- One proposal = one solicitation set (solicitation, amendments, attachments), up to 100 drafted pages in total, with all review rounds inside the run. Beyond 100 pages: an additional recharge (rate OPEN).
- Font request: one-time separate charge (amount OPEN).
- Cost and time estimate shown before a run starts, from page count and volume count.
- Image and model cost count against the run's cost cap.

## Dropped
- Rush path for eBuy RFQs and task orders: dropped.

## Still OPEN (list in 00 s7 and in the relevant file)
Red reviewer model; recharge rate beyond 100 pages; font fee; currency; zero-retention terms; product name and domain; hosting provider (inherit PD's pluggable hosting unless reasoned otherwise); browser agent implementation (Anthropic computer use vs Playwright driven by the model); which PD components are reused as-is vs extended; eBuy inbound email registration test; Enterprise terms; per-run cost cap value.

## Plan file set
| File | Covers |
|---|---|
| 00-overview.md | Product, goal, decisions table, run flow summary, scope, success measures, open items, decision log |
| 01-infrastructure.md | Hosting, orchestrator, job queue, render server, worker, fonts install, browser agent sandbox, Anthropic API and image provider, cost cap, monitoring, backups |
| 02-architecture.md | Components, PD reuse map, data flow per stage, tenancy model, integrations (email MCPs, Shaavir Drive, eBuy inbound, portals), APIs |
| 03-data-model.md | Tables (tenants, bids, runs, stages, pages, blocks with locks, findings, dispositions, NEEDs, evidence, repo items, requests, Q&A, packages, billing usage), storage layout |
| 04-pipeline.md | Stage list mapped to the 24 skills and their scripts; inputs and outputs per stage; gates (0, 0b, 1, 2); 90% page gate; separate reviewer; locks; amendment re-entry; Q&A; request and collect; resume and idempotency; failure handling |
| 05-ui.md | Screens: soft intake, bid/no-bid, run monitor, Q&A review and send, request and collect tracker, Gate 1 review, Gate 2 sign-off with round diff, package download and signature notice, repository browser, settings (fonts, mailbox, Drive, portals) |
| 06-accounts-billing.md | Tenants, roles, plans, monthly reset, proposal definition, recharge, font fee, estimate before run, usage metering, Stripe |
| 07-security-privacy-legal.md | Tenant isolation, credentials (never stored), MFA flow, disclosures, AI-ban flag, accuracy and citations, signatures, data retention, Drive storage, subprocessors |
| 08-build-phases.md | Build order, acceptance checks, tests, launch; first phase reuses PD |

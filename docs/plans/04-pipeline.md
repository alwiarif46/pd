# 04: Pipeline

**Status:** Draft v2 · 17 Oct 2026

This file lists every stage of a run, the skill behind it, and the scripts it calls. It also covers the gates, the 90% page gate, the separate reviewer, locks, the mid-run tracks, resume, and failure handling. Table names point to 03-data-model.

## 1. Rules

PD's AI rules carry over unchanged (PD 04 s1). E2E absorbs PD, so these rules now live in the E2E services. Quote or drop, flag on judgement, structured JSON output, one tenant per call, draft not decision, and a logged cost row for every call. The tool adds the rules below.

1. **One tenant per run.** A run reads only its own tenant's evidence, format spec, fonts, repository, and mailbox. No prompt, cache, or tool call mixes two tenants.
2. **Stages run behind one interface.** Each stage is a handler in its owning service, behind the stage interface (02 s4). The handler loads its skill's SKILL.md as the system prompt. The skill's scripts run in the render service as tools (01 s5.3).
3. **The database holds state.** The plugin keeps state in `state.json` and pursuit folders. The tool keeps it in the orchestrator's `runs` and `stages` and in each service's content tables. `pipeline.py` and `scaffold_pursuit.py` do not run in the tool.
4. **Writer and judge are separate calls.** The page gate never sees the drafter's reasoning, only the finished page and the quoted criterion. This follows the plugin's rule that an agent scoring its own work inflates.
5. **Red uses a different model.** See section 7.
6. **Locked blocks stay fixed.** See section 8.
7. **Every claim cites evidence.** A past performance, staffing, or figure claim needs an evidence citation. Assembly blocks any uncited claim (07 s5).
8. **Nothing waits silently.** A missing input becomes a NEED, and drafting goes on. Only Gate 0b, Gate 1, and Gate 2 stop a run for a person. Gate 0 is soft.
9. **Cost checks come before each call.** The model gateway checks the run's budget, set by the orchestrator, before every model or image call (section 12).
10. **Skills are placeholders.** Today's bid-autopilot skills run behind the stage interface until the Owner rebuilds each stage's skill. A rebuilt skill swaps in without a pipeline change.

## 2. Before the run (PD reuse)

The solicitation set goes through the ingest service, which is PD's document processing moved into E2E with no change (PD 04 s2). Upload, ClamAV scan, encryption check, DOCX to PDF, text extraction, OCR, marking check, classify, chunk, and pre-scan all run in the sandbox and worker. A CUI or export-control marking stops AI work on that file until a user confirms, as in PD.

Past performances, resumes, and other tenant files go through the same steps when uploaded. They then feed the tenant's evidence library and repository (03 s7).

## 3. Stage list

Owner decision: format lock runs before the outline, so the outline lands inside the tenant's shell from the start. This differs from the plugin's order. Stage keys are the values stored in `stages.stage_key`. The Service column names the owner of each stage handler (09 s4).

| # | Stage key | What happens | Plugin stage | Service | Stops for a person |
|---|---|---|---|---|---|
| 0 | `intake` | Bid facts, AI-ban check, eligibility, submission mechanics, repository fetch, "have" and "need" list | 0 | Intel, evidence | No (Gate 0 is soft) |
| 1 | `amendment_gate` | Records the conformed version: no amendment, or every amendment diffed | 1 | Intel | No |
| 2 | `shred` | Compliance matrix, term glossary, search terms, readability target | 2 | Intel | No |
| 2g | `gate_0b` | Bid/no-bid score shown; a human decides | none | Orchestrator | Yes |
| 3 | `worksheet` | Blank Register, hot buttons, page and word budgets | 3 | Drafting | No |
| 4 | `format_lock` | Format spec, silent rules filled, shell per volume | 4 | Render | No |
| 5 | `outline` | Outline inside the locked shells, story tags, style sheet | 3b | Drafting | No |
| 6 | `qa_draft` | Draft questions or filled questionnaire, draft email | none | Comms | Send needs a human |
| 7 | `pink` | Pink review document written to the tenant's Drive folder | 3c | Drafting, Drive | No |
| 8 | `evidence` | Evidence pull, register reuse, vignettes, heading differentiators | 5 | Evidence, drafting | No |
| 9 | `agency_intel` | Official-source fetch and index | 5b | Drafting | No |
| 10 | `draft` | Page-gated drafting, in parallel by volume and section | 6 | Drafting | No |
| 11 | `visuals` | Tables, SVG graphics, illustrative art, captions | 6b | Drafting, render | No |
| 12 | `exec_summary` | Executive summary, after the volumes it summarizes | 6 | Drafting | No |
| 13 | `pricing` | Pricing narrative and suggested figures | 6 | Drafting | Approval needs a human |
| 14 | `red` | Red team on the separate reviewer model, adversarial pass, seven pillars | 7, 8d | Review | No |
| 14g | `gate_1` | Findings, NEEDs, scores, predicted ratings; dispositions | none | Orchestrator | Yes |
| 15 | `recovery` | Dispositions applied, flagged pages re-drafted around locks, re-gated | 8 | Drafting | No |
| 16 | `sweep` | Cross-volume consistency, term sweep, lead-sentence read | 8b, 8c | Drafting | No |
| 17 | `assembly` | Word assembly, captions, cross-references, compliance check, citation block | 9 | Render | No |
| 18 | `render_verify` | PDF render, rasterize, vision layout check, page count | 9 | Render | No |
| 19 | `gold_white` | Gold Team and White Glove on the assembled volumes | 9b | Review | No |
| 19g | `gate_2` | Round-by-round diff, final volumes confirmed, sign-off | none | Orchestrator | Yes |
| 20 | `package` | One download: volumes, forms, attachments, matrix, checklist, notices | 10 | Render | No |
| 21 | `submit` | Optional portal submission; the final click is a human's | none | Portal agent | Yes, if used |
| 22 | `outcome` | Award result and debrief fed back to the repository and calibration | 11 | Evidence | Waits for the result |

Stages 6 and 13 run beside the main line. Neither blocks drafting. Mid-run tracks (sections 9 to 11) can start at any stage.

🟨 **OPEN:** whether pricing approval must land before Red or only before assembly.

## 4. Skill map

All 24 skills, mapped to the stages above. "Not used" means the skill does not run in the web pipeline. Each skill is a placeholder behind the stage interface until the Owner rebuilds that stage's skill (02 s4).

| Skill | Stages | Role in the tool |
|---|---|---|
| `bid-autopilot` | all | Not called as a prompt. Its stage table, gate strings, per-volume rules, and hard rules become orchestrator code |
| `amendment-gate` | 1, amendment re-entry | Diff method, change classes, impact map to Req_IDs and Blank_IDs, sections reopened. Event-driven, not a daily question |
| `compliance-matrix` | 2 | Shred method behind PD's passes 1 to 6. Also the final compliance read at 17 |
| `term-mirror` | 2, 10, 16 | Builds the glossary, checks every page, sweeps the volumes |
| `scoresheet-first` | 3, 7 | Blank Register, Evaluator Prompts, page budget from the register, Pink placement |
| `proposal-outline-generator` | 0, 5 | Type detection, eligibility, and submission mechanics at intake; outline at 5 |
| `story-placement` | 5, 10 | Tags `story` or `none` per heading; checks pages against the tag |
| `rfp-format-lock` | 4, 17, amendment re-entry | Extracts format rules, reconciles with the tenant's house style, audits drafts |
| `client-format-specs` | 4, tenant setup | The tenant's stored format spec and shell. Captured once from a submitted document |
| `evidence-capture` | 0, 22 | Ingests tenant files into the tenant's evidence library; harvests submitted volumes |
| `case-vignette` | 8 | Four-slot proof vignettes from evidence records, each figure cited |
| `proposal-response-writer` | 8, 9, 10, 11, 15, 16, 17 | Evidence gate, agency intel, drafting, tables and visuals, recovery, sweep, assembly |
| `federal-proposal` | 10, 15 | Loaded with the writer: per-page scorecard, writing rules, volume guidance |
| `exec-summary` | 12 | Executive summary model, four quality tests, three revision cycles |
| `federal-sled-pricing` | 13 | Suggests the pricing narrative and figures; a human approves |
| `kill-words` | 10, 15 | Banned word check on every page |
| `plain-language` | 10, 15 | Sentence length, voice, acronyms, reading grade on every page |
| `customer-focus` | 10, 15 | Customer to offeror ratio and the customer-first score |
| `strength-test` | 10, 14 | Strength ledger per paragraph at the page gate; strength roll-up at Red |
| `red-team-review` | 14 | Mock SSEB review on the reviewer model; findings, ratings, seven pillars |
| `gold-white-review` | 19 | Gold confirmation pass and White Glove production pass |
| `word-critic` | not used | Word desktop convergence loop. The tool has no Word client in the loop |
| `relay-producer` | not used | Worker side of the same Word loop. Red findings and Gate 1 dispositions replace its patch rounds |
| `word-page-verify` | not used | Needs Word COM on Windows. Replaced by the PDF render check at 18 |

The tool runs the tenant-neutral skill copies, stripped of any client names and desktop steps. Each copy carries an output contract with `sourceQuote` and `sourcePage`.

🟨 **OPEN:** the plugin pins the outline stage to an older model because a newer one broke on it. Confirm which model runs stage 5 on the Anthropic API. The Owner's stage rebuild may settle it.

## 5. Stage detail

Script paths: plain names live in the plugin's `scripts/`. The seven prose scripts (`kill_words_check.py`, `plain_language_check.py`, `term_mirror.py`, `customer_focus_check.py`, `strength_ledger.py`, `story_mode.py`, `vignette_validate.py`) and their shared `prose_text.py` live in their skill's `scripts/` folder. Prose checks exit 0 on pass, 1 on fix or fail, and 2 on bad input. Exit 2 is a setup error, never a page failure.

### 5.1 Intake (Gate 0, soft)

| Item | Detail |
|---|---|
| Skills | `proposal-outline-generator` (Phase 0 type detection, eligibility, submission mechanics), `evidence-capture` |
| Scripts | `capture_ingest.py`, retargeted from the vendor's own library to the tenant's evidence store |
| Inputs | Solicitation set (the only mandatory input), optional past performances, tenant repository |
| Outputs | `bid_facts`, `intake_items` (have, need, mandatory flag), `bids.ai_ban_flag` with quote and page |
| Gate | Soft. The run starts with the RFP alone |

The tool fetches from the tenant repository first. It then shows "we already have this" and "we still need this", with mandatory items marked. It asks no question it can answer from the repository or the solicitation. Each missing item becomes a NEED with an owner and a due point. Every input must arrive before Red (stage 14).

**AI-ban check.** Code and one model call search the solicitation set for clauses that ban or restrict AI-generated content. A hit sets `bids.ai_ban_flag`, with quote and page, and shows on the intake screen. Owner decision: the flag never stops the run. The run continues, and the flag stays on the bid's risk panel (07 s4).

### 5.2 Amendment gate

| Item | Detail |
|---|---|
| Skill | `amendment-gate` |
| Scripts | PD amendment key check and diff code (PD 04 s3.1); `heading_differentiator.py check` after reopened headings change |
| Inputs | Every amendment, addendum, and Q&A release on the bid |
| Outputs | `amendments`, `amendment_links`, an impact report per amendment, reopened sections |
| Gate | Conformed version recorded, including "no amendment yet" |

The plugin asks a person once a day. The tool does not ask. It reacts to uploads and to the eBuy watcher, and its daily eBuy check covers missed emails (02 s7).

### 5.3 Shred

| Item | Detail |
|---|---|
| Skills | `compliance-matrix`, then `term-mirror` |
| Scripts | `shred_checks.py reqs`, `shred_checks.py search-terms`, `prose_deductions.py` (readability target), `term_mirror.py` |
| Inputs | Classified, chunked pages and pre-scan hits |
| Outputs | `compliance_rows`, `glossary_terms`, `search_terms`, readability target on the run |
| Gate | Every shall verbatim and tied to a Req_ID. Glossary validates with no FAIL |

PD's passes 1 to 6 run as built (PD 04 s3). `shred_checks.py reqs` then counts sub-sentence requirements against the matrix.

### 5.4 Gate 0b: bid/no-bid

Covered in section 6.

### 5.5 Worksheet

| Item | Detail |
|---|---|
| Skill | `scoresheet-first` |
| Scripts | `page_cascade.py`, `hot_buttons.py` |
| Inputs | Evaluation pages, compliance rows, page limits |
| Outputs | `blanks` (the Blank Register), hot buttons, page and word budgets per section |
| Gate | Every high-weight subfactor has strength blanks |

Budgets keep the plugin's 40% visual reserve. The words-per-page figure comes from the tenant's format spec. `--wpp-sample prose` applies, since the tool measures no mixed Word sample.

### 5.6 Format lock

| Item | Detail |
|---|---|
| Skills | `rfp-format-lock`, `client-format-specs` |
| Scripts | `format_harden.py harden` and `check`, `client_shell.py start` and `verify --empty`, `audit_format.py` |
| Inputs | Instruction pages, the Blank Register and budgets, the tenant's format spec and shell, tenant fonts |
| Outputs | `format_specs` row for the bid, an empty shell per volume |
| Gate | Every rule has a verify method. `format_harden.py check` passes. Empty shell audits clean |

A font the spec names but the tenant lacks maps to a metric-compatible font when one exists. Otherwise the stage raises a font NEED that points to the font request flow (06 s6).

Format lock runs before the outline, so the outline knows the shell, styles, and words per page it must fit.

### 5.7 Outline

| Item | Detail |
|---|---|
| Skills | `proposal-outline-generator`, then `story-placement` |
| Scripts | `page_cascade.py`, `heading_differentiator.py`, `style_sheet.py new` and `render`, `story_mode.py assign --write` |
| Inputs | Matrix, Blank Register, budgets, the locked format spec and volume shells from stage 4 |
| Outputs | `outline_items`, `proposal_sections`, story tag per heading, style sheet |
| Gate | Skeleton traces to the instructions or a declared fallback rung. Every heading carries `blank_id`, `source`, and `order` |

A REVIEW heading is a flag, not a stop. It shows at Gate 1 and in the Pink document.

### 5.8 Q&A draft

Covered in section 10.

### 5.9 Pink

| Item | Detail |
|---|---|
| Skill | `scoresheet-first` |
| Scripts | `review_records.py pink`, then the Drive writer |
| Outputs | Pink review document in the tenant's Drive folder; `reviews` row of type `pink` |
| Gate | Every section placed, the placement test passed |

Pink does not stop the run. Tenant users can open the document at any time and add material. The tool reads their additions back as inputs on its next stage boundary.

🟨 **OPEN:** how Drive edits are read back (polling or change notifications), and whether they count as human edits that lock blocks.

### 5.10 Evidence

| Item | Detail |
|---|---|
| Skills | `proposal-response-writer` (evidence gate), `case-vignette` |
| Scripts | `needs_register.py apply` and `confirm`, `vignette_validate.py`, `heading_differentiator.py apply` and `check` |
| Inputs | Tenant evidence library, repository, needs fulfilled register, Blank Register |
| Outputs | `evidence_links` per section, `vignettes`, NEEDs reused or opened, final heading text |
| Gate | Every assertable fact maps to a document and page, or to a NEED |

When the register can answer a NEED, the tool fills it as `reused`. It then waits for confirmation at Gate 1.

### 5.11 Agency intelligence

| Item | Detail |
|---|---|
| Skill | `proposal-response-writer` (Phase 3) |
| Scripts | `agency_intel.py`, with its domain allow list |
| Outputs | Fetched pages and an index, each item classified; rejections recorded |
| Gate | Every item fetched, current, relevant, and classified |

### 5.12 Draft

| Item | Detail |
|---|---|
| Skills | `proposal-response-writer` with `federal-proposal`. Page checks: `kill-words`, `plain-language`, `term-mirror`, `customer-focus`. Gate call: `strength-test`, then `story-placement` |
| Scripts | `kill_words_check.py`, `plain_language_check.py`, `term_mirror.py check`, `customer_focus_check.py`, `strength_ledger.py`, `story_mode.py check`, `content_gate.py` with `prose_deductions.py`, `lead_sentence.py`, `audit_format.py --outline --search-terms --volume`, `visual_mix.py check`, `detector_risk.py` (advisory) |
| Inputs | Section slice of the outline, evidence links, vignettes, format spec, glossary, locked blocks |
| Outputs | `draft_pages`, `blocks`, `page_checks`, `strengths`, `citations`, NEEDs |
| Gate | Section 7 (the 90% page gate) |

Drafting runs in parallel by volume and by section. Each worker holds only its own slice. Workers are read-only on shared state and return results. One serial merge step per run then writes every shared table: matrix status, NEED register, strength ledger, glossary hits, and stage state. This mirrors the plugin's per-volume rule. Two workers never write the same row.

`detector_risk.py` never fails a page. A high score routes the section to extra attention at Red.

### 5.13 Visuals

| Item | Detail |
|---|---|
| Skill | `proposal-response-writer` (Phase 6) |
| Scripts | `visual_mix.py check`, `caption_fields.py` (at assembly), SVG render in the render service, image provider call |
| Outputs | `visuals` rows, table blocks, graphic blocks with action captions |
| Gate | Three visuals per two pages, mixed. No table repeats a graphic. A paragraph sits between visuals. Every visual has an action caption and fills a Blank_ID |

The plugin hands graphic call-outs to a designer. The tool makes the graphics. Diagrams, process flows, org charts, and timelines are SVG built in the render service. GPT Image 2 makes illustrative art only, never a diagram that carries facts. Image cost counts against the cost cap.

### 5.14 Executive summary

| Item | Detail |
|---|---|
| Skill | `exec-summary` |
| Scripts | The stage 10 page checks and `content_gate.py` |
| Inputs | Drafted volumes, win themes, hot buttons, Blank Register |
| Outputs | Executive summary section and blocks |
| Gate | The four quality tests and the 90% page gate |

It runs after the volumes, because it summarizes them.

### 5.15 Pricing

| Item | Detail |
|---|---|
| Skill | `federal-sled-pricing` |
| Inputs | Pricing instructions, labor categories, tenant rates, wage determinations |
| Outputs | Pricing narrative draft, suggested figures, risk flags, a pricing approval item |
| Gate | A human approves the figures. The tool never sets a price on its own |

The tenant's indirect rate structure is a NEED until the tenant supplies it.

### 5.16 Red

The reviewer model rules are in section 7.2.

| Item | Detail |
|---|---|
| Skills | `red-team-review`, `strength-test` (roll-up) |
| Scripts | `responsiveness.py`, `review_records.py adversarial`, `review_records.py pillars`, `strength_ledger.py rollup` |
| Inputs | Each section's pages, evaluation factors, compliance rows, Blank Register, strength ledger |
| Outputs | `review_findings`, `factor_ratings`, NEEDs ranked by score impact, adversarial record, seven-pillar scorecard |
| Gate | Weight coverage at 85% or higher. No critical finding left without a disposition at Gate 1 |

Every input must have arrived before Red starts. Items still missing stay as NEEDs and show at Gate 1, ranked by score impact.

### 5.17 Recovery

| Item | Detail |
|---|---|
| Skill | `proposal-response-writer` with `federal-proposal` |
| Scripts | Same page checks and gate as stage 10 |
| Inputs | Gate 1 dispositions, filled NEEDs, locked blocks |
| Outputs | Revised `blocks` and `draft_pages`, new block versions |
| Gate | Every flagged page re-gated at 90. Up to three loops per page, then escalate |

### 5.18 Sweep

| Item | Detail |
|---|---|
| Skills | `proposal-response-writer`, `term-mirror` |
| Scripts | `outcome_and_sweep.py sweep` and `proofing`, `term_mirror.py` sweep, `lead_sentence.py --theme-lens` |
| Outputs | Conflict report, proofing findings, horizontal review record |
| Gate | Figures, names, dates, and approach agree across volumes and with pricing. One term per concept |

The sweep obeys locks. A fix that touches a locked block becomes a change proposal.

### 5.19 Assembly

| Item | Detail |
|---|---|
| Skills | `proposal-response-writer`, `rfp-format-lock`, `compliance-matrix` |
| Scripts | python-docx assembly in the render service, `caption_fields.py apply` and `check`, `assembly_artifacts.py xref`, `style_sheet.py audit`, `heading_differentiator.py check`, `client_shell.py verify`, `audit_format.py`, `need_comments.py promote`, `placeholders.py certify`, `compliance_check.py check` (last) |
| Outputs | One DOCX per volume, cross-reference table, compliance result |
| Gate | Zero open NEEDs or every remaining one masked and listed. Zero uncited claims. Zero em dashes. Format audit clean. `compliance_check.py` exit 0, or every unmet requirement disposed by a human |

**Citation block.** Assembly reads every claim of type past performance, staffing, or figure. A claim with no citation stops assembly and returns to the user as a NEED.

**Numbering.** Owner decision: the render service computes caption numbers, cross-reference text, and the contents table in code. It writes the results into the DOCX, so the PDF needs no field refresh. LibreOffice headless renders the PDF (01 s5.1).

### 5.20 Render and verify

This stage replaces `word-page-verify`.

| Item | Detail |
|---|---|
| Scripts | LibreOffice PDF render, `pdftoppm` rasterize (the `visual_gate.py` path), vision model layout check, page count on the PDF |
| Inputs | Assembled DOCX per volume, installed fonts, page limits |
| Outputs | `renders`, `render_issues` per page, page count per volume and section |
| Gate | Page count at or under the limit on the exact PDF to submit. No layout issue left open |

The vision model checks each rasterized page for overflow, broken tables, cut-off graphics, orphan headings, and margins. A page with an issue returns to recovery for that block only. For a Word-only submission the stage still runs, and the package adds the Word page-limit note.

The page count holds for the PDF the tool produced. 🟨 **OPEN:** what the package says when a tenant edits the DOCX in Word and re-exports (01 s5.5).

### 5.21 Gold and White Glove

| Item | Detail |
|---|---|
| Skill | `gold-white-review` |
| Scripts | `review_records.py gold`, `visual_gate.py`, `style_sheet.py`, `placeholders.py`, `caption_fields.py`, `audit_format.py`, `lead_sentence.py` |
| Inputs | Assembled volumes, PDFs, Red findings with dispositions, NEED register, compliance result |
| Outputs | `reviews` rows of type `gold` and `white`, findings, gold record |
| Gate | Refuses to start until a human disposes every Red finding and every NEED is `filled` or `masked` |

The plugin's own entry gates hold. The tool fixes White Glove defects on its own when no lock blocks them. A defect on a locked block becomes a change proposal for Gate 2.

### 5.22 Package

| Item | Detail |
|---|---|
| Inputs | Final volumes and PDFs, forms, attachments, matrix, naming rules |
| Outputs | `packages`, `package_files`, `signature_items`, one ZIP download |
| Gate | Every file named per the solicitation. Every form filled. Signature and review notice built |

The package holds every volume in Word and PDF, page-verified. It adds filled forms: SF 33 or SF 1449, reps and certs, pricing sheets, and the cover letter. Attachments follow (resumes, past performance forms, commitment letters, certificates), then the compliance matrix and a submission checklist. The tool fills signer details but never signs. The notice lists what needs a signature and what needs review, for example reps and certs.

### 5.23 Submit (optional)

Two paths, chosen by the user: the browser agent with a human approving each login and MFA, or manual upload. Portals that ban automation, such as SAM.gov, get upload or a guided checklist only. The final submit click is always a human's (07 s2).

### 5.24 Outcome

| Item | Detail |
|---|---|
| Skills | `evidence-capture`, `proposal-response-writer` (white hat) |
| Scripts | `outcome_and_sweep.py`, `needs_register.py harvest --final` |
| Inputs | Submitted volumes, award result, debrief |
| Outputs | `repo_items` for every part of the submitted proposal, `outcomes`, `learning_events`, register rows |
| Gate | Waits for the result. Never blocks billing or other bids |

## 6. Gates

| Gate | After | Who | What the person sees | What the person does |
|---|---|---|---|---|
| 0 Intake (soft) | Upload | Any tenant user | "We already have this", "we still need this", mandatory items marked, AI-ban flag | Starts the run with the RFP alone. Adds items any time before Red |
| 0b Bid/no-bid | Shred | Tenant user (06 s2). An approver role is 🟨 **OPEN** | Fit, eligibility, past performance coverage, risk, each scored with its basis | Bid or no-bid. No-bid ends the run |
| 1 After Red | Red | Tenant user (06 s2) | Findings, NEEDs, scores per page, predicted rating per factor, NEEDs ranked by score impact, reused NEEDs to confirm | Accepts, edits, or rejects each finding. Fills NEEDs. Approves to continue |
| 2 After Gold | Gold and White Glove | Tenant user (06 s2) | Round-by-round diff, page by page; open change proposals; compliance result | Confirms final volumes. Signs off |

**Gate 0b scoring.** Fit comes from the scope pages against the tenant repository. Eligibility comes from set-aside, NAICS, and registration facts. Past performance coverage counts relevance hits in the evidence library. Risk counts missing mandatory items and short deadlines. Each score shows its basis.

🟨 **OPEN:** the weights for the four Gate 0b scores, and whether any score sets a recommendation.

Owner decision: no-bid releases the reserved proposal credit. A run that fails or is cancelled before the Red draft also releases it. The credit is consumed only when the Red draft reaches the tenant at Gate 1 (06 s4).

**Gate 1 edits lock.** Any block a user edits at Gate 1 gets a lock (section 8). A filled NEED writes its value into the block, and that block also locks.

## 7. The 90% page gate and the separate reviewer

### 7.1 Page gate

The content gate scores each page out of 100, using the plugin's seven elements. A page passes at 90 or higher.

| Step | Who | What |
|---|---|---|
| 1. Draft | Drafter model | Writes the page from its slice |
| 2. Prose checks | Worker scripts | The six prose checks run first. A FAIL returns the page to the drafter with the finding |
| 3. Automatic fails | `content_gate.py` | Passive voice, sentence length, cross-reference as proof, superlatives, parroting, ownerless commitments, figures without evidence, unfilled blanks, em dashes |
| 4. Score | Gate call (a separate call from the drafter) | Element scores, the lowest element named |
| 5. Repair | Drafter model | Repairs the same page and rescores |
| 6. Escalate | Orchestrator | After three failed cycles the page stops. It shows at Gate 1 with its score and the blocking element |

The gate scores a sentence under a NEED placeholder as the plugin allows. An escalated page never blocks the other pages.

Format checks run per section after its pages pass: `audit_format.py` for heading mirror and required terms, then `visual_mix.py check`. Heading drift from the outline is critical and fails the section.

### 7.2 Separate reviewer

Red runs on a reviewer model that differs from the drafter model. The reviewer never sees the drafter's prompts or reasoning. It reads the finished pages, the evaluation factors, the compliance rows, and the Blank Register. Model choice per role lives in the model gateway's `ai_settings`. The gateway refuses a Red call whose reviewer equals the drafter.

🟨 **OPEN:** which model is the Red reviewer.

🟨 **OPEN:** whether Gold and White Glove also use the reviewer model.

## 8. Locks

1. Every block a human edits gets a lock. This covers Gate 1 edits, filled NEEDs, edits in the tool's editor, and accepted change proposals.
2. A re-draft passes locked blocks to the model as fixed text, marked as such. The model writes around them.
3. Code compares every locked block before and after each model call. Code discards any change to a locked block, and the stage logs it.
4. When the model thinks a locked block must change, it returns a change proposal: block, current text, proposed text, and reason. A human approves or rejects it. Approval writes a new locked version.
5. The sweep, recovery, White Glove fixes, and amendment re-entry all obey locks.
6. A human can unlock a block. `audit_log` records each unlock.

An amendment that changes a requirement behind a locked block does not edit the block. It opens a change proposal with the amendment quote attached.

## 9. Amendment re-entry

An amendment can arrive at any stage, by upload or through the eBuy watcher.

1. PD's key check, number rules, and diff run as built (PD 04 s3.1).
2. `amendment-gate` classifies each change and maps it to Req_IDs and Blank_IDs.
3. The orchestrator finds every section, page, and block tied to those IDs.
4. Affected pages reopen. Their stage rows reset to `pending` at the earliest stage the change touches. A format change reopens format lock; a page limit change reopens the worksheet budgets.
5. Re-drafted pages re-gate at 90. Locked blocks become change proposals, not edits.
6. Dates in the amendment update the schedule and the Q&A deadline (PD 04 s3.1 step 7).
7. If the run has passed Gate 1 or Gate 2, it returns to that gate with the changed pages listed.
8. The orchestrator adds an acknowledgment item to the package checklist.

🟨 **OPEN:** whether an amendment after Gate 2 reopens the run automatically or waits for a user to start it.

## 10. Q&A

| Step | Who | What |
|---|---|---|
| 1. Find rules | Code and model | Q&A deadline, format, submission address, and any agency questionnaire document, each with quote and page |
| 2. Draft | Model (`compliance-matrix` ambiguity flags, `amendment-gate` conflict notes) | Questions tied to Req_IDs, in the required format. If the agency gave a questionnaire, the tool fills it |
| 3. Draft email | Model | Email to the named address, with the questions or the filled questionnaire attached |
| 4. Review | Tenant user | Reviews the questions, then the email. Edits to either are kept as the user's text |
| 5. Send | Tenant user | Clicks send. The email goes from the tenant's own address through its Gmail or Microsoft 365 connection |
| 6. Alert | Orchestrator | Deadline alerts before the Q&A due date |

The agency's answers usually arrive as an amendment or a Q&A release. They enter through section 9.

🟨 **OPEN:** the alert schedule (how many days and hours before the deadline).

## 11. Request and collect

The tool requests third-party items and collects the replies.

| Item kind | Examples |
|---|---|
| `commitment_letter` | Key personnel and partner commitment letters |
| `pp_form` | Partner past performance forms, questionnaires |
| `resume_consent` | Resume use consents |
| `other` | Any similar third-party item the solicitation needs |

1. Stage 0, 2, or 8 opens a request when the solicitation needs an item the tenant lacks.
2. The tool drafts the request in the required format, with the form attached when one exists.
3. Proposed: a tenant user reviews and sends it from the tenant's mailbox, as for Q&A (🟨 **OPEN**, 07 s3).
4. The tool watches the same mailbox thread for replies. Attachments go through PD's document processing.
5. A user can also upload the item by hand.
6. Status moves through `draft`, `sent`, `received`, `accepted`, or `rejected`. Each item shows on the tracker (05 s4).
7. A received item fills its NEED, and the affected blocks re-gate.

🟨 **OPEN:** reminder timing for unanswered requests.

## 12. Resume, idempotency, retries, and cost

| Concern | How the orchestrator handles it |
|---|---|
| State | One `stages` row per stage and scope (run, volume, section, or page). The row saves status, attempt, input hash, and output reference when a stage ends |
| Resume | After a crash or restart, the orchestrator reads `stages` and starts the first row not `done`. Finished rows never re-run |
| Idempotency | Each stage row has an idempotency key: run, stage, scope, and input hash. A duplicate job with the same key does nothing. Writes for one stage land in one transaction |
| Queue | Durable events and work queues on Redis Streams, with PD's BullMQ inside ingest and intel. Work survives a restart (01 s4) |
| Retries | A failed call retries with backoff, up to a set count. Then the stage becomes `failed` with its error |
| Rate limits | On an Anthropic 429 or overload response, the job waits for the retry-after time. A per-tenant and global concurrency limit keeps calls under the account's limits |
| Cost cap | Before each model or image call, the model gateway adds the estimated cost to the run's spend. If the total would pass the cap, the call does not start. The orchestrator pauses the run with state saved. Proposed: the vendor and the tenant Admin get an alert (01 s8) |
| Estimate | The cost and time estimate shown before a run comes from page count and volume count (06 s7) |

Cap value: set from the 10-RFP test (08 Phase 9). 🟨 **OPEN:** who may raise it (01 s8; 06 s8).

## 13. Failure handling

| Failure | What happens |
|---|---|
| Script exit 2 (bad input) | Setup error. Stage `failed`, and the vendor gets an alert. Never shown as a page failure |
| Script exit 1 | A check finding. The page or section returns to the drafter |
| Model output fails the schema | Retried once with the validation error. A second failure marks the stage `failed` |
| Quote check fails | Code drops and counts the row, as in PD |
| Page fails the gate three times | Escalated to Gate 1 with score and blocking element. Other pages go on |
| Render or vision call fails | One retry. A second failure marks `render_verify` failed, and the tool claims no page count |
| Email send fails | The email stays `failed` with the provider error; the user can resend |
| Mailbox or Drive connection lost | The track pauses and the tenant sees a reconnect prompt. The main run goes on |
| Cost cap reached | Run paused (section 12) |
| Amendment held by key check | As in PD: held, with an owner override (PD 04 s3.1) |

A failed stage never marks itself done. The run monitor shows every failed stage with its error and a retry action (05 s4).

## Decision log

| Date | Decision |
|---|---|
| 17 Oct 2026 | Stage order follows the brief and the plugin's 20-stage list; gates 0, 0b, 1, and 2 added as stages |
| 17 Oct 2026 | All 24 skills mapped. `word-critic` and `relay-producer` not used (Word desktop loop). `word-page-verify` replaced by the PDF render check |
| 17 Oct 2026 | `bid-autopilot` becomes orchestrator code; `pipeline.py` and `scaffold_pursuit.py` replaced by the `runs` and `stages` tables |
| 17 Oct 2026 | Writer and page gate run as separate calls; Red runs on a separate reviewer model |
| 17 Oct 2026 | Per-volume and per-section workers are read-only; one serial merge writes shared state |
| 17 Oct 2026 | The tool makes graphics: SVG on the render server, image provider for illustrative art only |
| 17 Oct 2026 | Locked blocks checked by code before and after each call; changes only by approved proposal |
| 17 Oct 2026 | Amendment gate is event-driven (upload and eBuy watcher), not a daily question |
| 17 Oct 2026 | Assembly blocks any uncited past performance, staffing, or figure claim |
| 17 Oct 2026 | Review pass: stage order restored to outline then format lock, with the swap kept as a proposal; gate actors set to tenant users; request send marked Proposed |
| 17 Oct 2026 | Owner decision: format lock runs before the outline. Stages 4 and 5 swapped; sections 5.6 and 5.7 swapped |
| 17 Oct 2026 | Owner decision: every stage runs behind one stage interface in its owning service; today's skills are placeholders until the Owner rebuilds each one |
| 17 Oct 2026 | Owner decision: an AI-ban hit flags and lets the run continue |
| 17 Oct 2026 | Owner decision: no-bid releases the credit; the Red draft at Gate 1 consumes it |
| 17 Oct 2026 | Owner decision: a run that fails or is cancelled before the Red draft releases the credit |
| 17 Oct 2026 | Owner decision: events and work queues on Redis Streams; NATS dropped |
| 17 Oct 2026 | Owner decision: code-computed numbering in the render service; field refresh closed |
| 17 Oct 2026 | Owner decision: the cost cap value comes from the 10-RFP test; the model gateway enforces it per call |
| 17 Oct 2026 | Final review: "render server" renamed render service in the stage detail |

# 04 — AI Pipeline

**Status:** Draft v2 · 13 Oct 2026

## 1. Rules every AI task follows

1. **Quote or drop.** Every extracted item carries the exact source text (`source_quote`), the document, and the page (03 s3.1). Code checks that the quote exists on that page, or across that page and the next, at a normalized match of 95% or higher. If the quote matches on another page of the solicitation set, code corrects the page. If it matches nowhere, the row is dropped, counted, and logged, and its pre-scan hit (if any) goes to the "check these" list. No row cites text missing from the solicitation set.
2. **Normalization for the match.** Lowercase; collapse whitespace; join words split by a hyphen at a line break; map ligatures (for example "ﬁ", "ﬂ") and smart quotes to plain letters and quotes.
3. **Flag, don't drop, on judgement.** When a model thinks a row is not a requirement, the row is flagged for the user, not removed. Only the quote check drops rows, because every wrong drop is a recall loss.
4. **Structured output.** The model returns JSON that matches a schema. Code validates it before anything reaches the database.
5. **No mixing tenants.** One call holds one organization's text only.
6. **Draft, not decision.** The UI labels AI output as a draft for the user to review.
7. **Logged cost.** Every call writes an `ai_runs` row.

## 2. Document processing (no AI)

The **solicitation set** is every file of kind `solicitation`, `amendment`, or `attachment` on the bid. PWS, SOW, Section J attachments and the like are part of the one RFP. There is no page cap; the limit is the bid's MB cap. Every file in the set goes through every step below. Resumes and drafts go through upload, scan, encryption check, convert, extract, OCR, and marking check, then only the tasks that use them.

| Step | Where | What happens |
|---|---|---|
| Upload | api | Upload session with declared size and sha256 (02 s3). All files on the bid stay within its MB cap: 50 MB on Free, 300 MB on Starter and Growth (06 s3) |
| Scan | clamav | ClamAV scan with `MaxFileSize`, `MaxScanSize`, and `StreamMaxLength` at 300 MB or more, so large files are scanned, not skipped (01 s2.2). Infected files are rejected |
| Encryption check | sandbox | qpdf and `pdfinfo`. A PDF that needs a password to open (user password) is rejected with a message asking for an unlocked copy. A PDF with only an owner password or permission flags, which is common in government files, is accepted. ClamAV's encrypted-document alert is not used for this |
| Convert | sandbox | DOCX to PDF with LibreOffice headless, then processed as a normal PDF, so page numbers are real and the viewer can highlight. The converted PDF is kept as the viewer copy. If conversion fails, Mammoth extracts the text instead and the pages are flagged "page estimated" |
| Extract | sandbox | Text per page: PDF via `pdftotext -layout`; XLSX via SheetJS (one "page" per sheet) |
| OCR | sandbox | Page count checked first: a file over 500 pages is refused before OCR. Pages with fewer than 50 characters of text go through OCRmyPDF (`--jobs 2`). The OCR'd PDF is kept as the viewer copy, with the same retention as the original |
| Marking check | worker | Search pages 1 to 3, and the header and footer lines of every page, for: CUI, CONTROLLED UNCLASSIFIED, FOUO, DISTRIBUTION STATEMENT B to F, ITAR, EXPORT CONTROLLED, EAR99. If one is found, AI processing of that file stops and the user is asked to confirm the file is public or approved for third-party processing. The decision goes to `audit_log` (07 s3) |
| Classify | worker | Tag pages by role, not by federal section letter: `instructions` (federal Section L, or SLED "submission requirements" and "proposal format"), `evaluation` (Section M, or "evaluation criteria" and "scoring"), `scope` (Section C, PWS, SOW, SOO, "scope of work"), `terms`, `attachments`. Rules on headings first, AI only when rules find nothing |
| Chunk | worker | Split on section and paragraph breaks, with page anchors kept. Chunk size is a setting: starting value 30,000 tokens, set from the Phase 1 benchmark. Smaller chunks (10,000 to 15,000 tokens) for passes 1 and 3 may cut per-call latency |
| Pre-scan | worker | Find every sentence with "shall", "must", "will", "required", "is to", "are to". Mark sentences whose subject is the Government, the agency, the State, or the County as `informational` so they don't flood the "check these" list. Store the rest as candidate requirements with page numbers. Also record date hits (dates, times, "due", "no later than") for the Dates task |

## 3. Compliance matrix (free tab)

| Pass | Model input | Output |
|---|---|---|
| 1. Extract | One chunk + compliance-matrix skill instructions | Requirements: requirement text (short form), exact quote, document, page and page end, section ref, type |
| 2. Merge | Code | Deduplicated list with IDs (`C.3.1-01` style) |
| 3. Verify | Chunk + extracted rows for that chunk + pre-scan hits not matched | Missed requirements, added as rows. Rows that may not be requirements, flagged `maybe_not_requirement` for the user, not dropped |
| 4. Quote check | Code | Rules 1 and 2. Records the quote-check failure rate before any drop, and the number of rows dropped |
| 5. Map | `instructions` and `evaluation` pages + rows | Instruction reference and evaluation factor per row, and suggested response section. For federal bids these are the Section L and Section M references |
| 6. Coverage | Code | List of pre-scan hits still unmatched, shown to the user as "check these" |

Passes 1 and 3 run per chunk in parallel, up to the provider's concurrency setting and the per-bid cap (section 6). An attachment added after the first run goes through passes 1 to 6 on its own text and merges into the matrix with `amendment_no` 0.

### 3.1 Amendment run (changes only)

An amendment does not re-run the whole solicitation set.

1. **Key check.** The amendment's solicitation number must match the bid's `solicitation_key` (06 s4). The upload is accepted first. The check runs in the worker after text extraction (and the marking check and classify) and before any AI step, in code with no model call: the amendment matches when a run of whole letter-and-digit tokens on any page equals the bid key, so `W912-24-R-0001`, `W91224R0001` and `W912 24R 0001` all match; OCR'd pages also fold O/0, I/L/1, S/5, B/8, Z/2. A short key (under 6 characters, or no digit) matches only inside a labelled number ("Solicitation No.", "RFP", "Bid No." and similar). On a match the amendment goes on to step 2. Otherwise it is held (`amendments.status` `held`, `documents.key_status` `mismatch` when another labelled number is found, `not_found` when none is, `bid_key_pending` while the bid key is still PENDING) and runs no AI step. The bid owner can override a held amendment, mismatch or not found, with a reason; the reason goes to `audit_log`, each bid allows a limited number of overrides, an override is never refunded, and processing then resumes (06 s4). A PENDING hold is rechecked when the bid's key is set.
2. **Process.** Upload, scan, encryption check, convert, extract, OCR, marking check, classify, chunk, and pre-scan on the amendment file only. Upload through classify run before step 1; the AI steps run only after it.
3. **Extract.** Passes 1 to 4 on the amendment text only. New rows get `amendment_no` = N.
4. **Amendment diff.** A small AI step. Input: the amendment's rows, plus existing rows that code picks as candidates (same section reference, or close text). Output: for each new or changed requirement, the existing row it supersedes, if any; for each existing requirement the amendment removes with no replacement, a "withdrawn" proposal. Each link carries a confidence.
5. **Apply.** Code applies links at or above the confidence setting: the old row becomes `superseded` (with `superseded_by_row_id`) or `withdrawn`. A new row with no link is "Added by Amd N". Links below the setting are stored as `proposed`, and the user confirms or rejects each one (05 s3.3). The app does not guess.
6. **Map and coverage.** Passes 5 and 6 on the new rows.
7. **Dates.** If the amendment has date hits, the Dates task runs on the amendment text, updates the locked schedule activities, and triggers the shift, scale, or keep prompt (05 s3.11).
8. **Other tabs.** Bid facts, and on paid plans the outline, production rules, and orals rules, re-run on the amendment text with the same supersede rules.

Superseded and withdrawn rows are never deleted (03 s3.3).

## 4. Other tasks

| Task | Tab | Input | Output |
|---|---|---|---|
| Bid facts | Overview | First pages, cover letter, `instructions` pages | Agency, solicitation number, bid type (federal or SLED), NAICS, set-aside, contract type, period of performance, place of performance, submission method, contracting officer, each with quote |
| Dates | Schedule | Per chunk, limited to `instructions` pages and chunks with pre-scan date hits. Code merges and de-duplicates the results, and flags conflicting values for one date | Due date, time, time zone, questions due, site visit, orals, other dates, each with quote. Feeds the schedule as locked activities |
| Outline | Outline | `instructions` pages, page limits, volume or section instructions | Volumes and sections with numbers, titles, page limits, source refs and quotes |
| Personnel requirements | Resume matrix | Key personnel and labor category text | Requirements per role with kind and quote |
| Resume facts | Resume matrix | One resume | Degrees, years, certifications, clearance, skills, each with quote from the resume |
| Match | Resume matrix | Role requirements + resume facts | Meets, partial, gap, or unknown per requirement, with evidence |
| Review scoring | Color team | Draft section + `evaluation` factors + compliance rows | Strengths, weaknesses, deficiencies, risks, each with a quote and page from the draft |
| Production rules | Production | `instructions` pages, format and submission text | Fonts, margins, page limits, file names, file types, submission portal, copies, each with quote |
| Orals | Orals | Orals instructions | Format, length, attendees, topics, allowed materials, each with quote |

Resume work runs only on paid plans and never sends a resume together with another organization's data. Resume evidence quotes are deleted with the resume at 90 days (07 s2).

## 5. Model test (before launch)

**Golden set:** 5 past solicitations where Shaavir already holds a human-built compliance matrix. Mix sizes (one under 50 pages, two around 150, two over 250), and include at least 3 federal and 2 SLED solicitations. Amaan assembles the set before Phase 1 starts. The human matrices are client work product: they stay on the test machine and never ship with the app.

**Provider terms first.** The golden set is past client solicitations, and the test sends them to each candidate provider. Before any golden document is sent, Amaan requests zero-retention and no-training terms from DeepInfra (and from Anthropic for its candidates). This is in Phase 0's "done when" (08). If a provider cannot give those terms, the golden documents sent to it are limited to ones the owner is allowed to send, and the test report records this.

**Split:** 3 documents for tuning skills and prompts; 2 held out and never used for tuning. Amaan picks the held-out pair before tuning starts. Pass marks are scored on the 2 held-out documents. The report also shows all 5. Public solicitations (SAM.gov, state portals) can be added later as extra held-out data.

**Benchmark (before Phase 1 work):** Amaan provides a DeepInfra key in the environment variable `DEEPINFRA_API_KEY`. Claude runs a small benchmark on public text (no golden documents) to measure output tokens per second, latency per chunk at several chunk sizes, JSON validity rate, and the provider's concurrent-call limit. Phase 1 measures the same on the full pipeline. The results set the per-provider concurrency (starting value 3), the per-bid cap, and the chunk size.

**Candidates, in order:**
1. DeepInfra Qwen3.5-397B (first test, with skills loaded)
2. Anthropic Haiku 5.5
3. DeepInfra DeepSeek V4 Pro
4. Anthropic Sonnet 5.5 (quality reference)

**Matching:** a human-matrix row counts as found if at least one AI row's quote overlaps at least 80% of the human row's cited text. Precision uses the same match in reverse: an AI row counts as correct if at least 80% of its quote is overlapped by a human row's cited text. Disagreements are checked by hand.

**Metrics:**

| Metric | Pass mark |
|---|---|
| Recall: human-matrix requirements found (held-out) | 98% or higher |
| Precision: AI rows that are real requirements (held-out) | 95% or higher |
| Due date and time correct | Correct on every held-out document that states them; also reported on all 5 (target 5 of 5) |
| No row cites text missing from the solicitation | Must hold |
| Quote check pass rate after the code check | 100%. A rule, not an informative number, since the code drops what fails |
| Quote-check failure rate before the code drops rows | Reported. This is the informative number |
| Rows dropped by the quote check | Reported count. Every drop is a recall loss |
| Time per 200-page text-layer PDF on an idle worker | Under 10 minutes |
| Time for scanned (OCR) documents | Measured in Phase 1; a separate expectation is written down then |
| Output tokens per second, latency per chunk, JSON validity rate, provider concurrent-call limit | Measured and reported |
| Cost per RFP | Recorded with the arithmetic in section 7; prices follow measured cost (06 s3) |

**Harness:** a command-line tool in `evals/` runs the full pipeline against each golden solicitation, compares output to the human matrix with the matching rule above, and writes a report per model.

**Rule:** the cheapest model that passes every mark on the held-out documents goes live. A mixed setup (for example, extraction on Qwen, verification on Sonnet) counts as a candidate.

## 6. Cost controls

- **MB cap per bid** (first safety net): 50 MB on Free, 300 MB on paid plans. MB does not track AI cost, so a second net follows.
- **Token budget per RFP** (second safety net): input tokens across all tasks on the bid's solicitation set, amendment runs included. Stop and flag when passed. The starting value is set after Phase 1 from measured usage, with room for at least one full re-run. (v1 used 15 times the solicitation's own token count. That is barely above expected usage and would trip on one re-run.)
- **Concurrency:** per-provider setting (starting value 3, set from the Phase 1 benchmark) and a per-bid cap.
- Per-organization daily cap on AI jobs.
- Global monthly spend cap in settings. At 80%, alert. At 100%, pause new free-plan jobs with a message to the user, keep paid jobs running, and alert Amaan.
- Provider prefix caching is used where offered, but costs and prices do not assume it. Passes 1 and 3 send different chunks, so little prefix is shared.
- Re-running a task on the same document version reuses stored results unless the user asks for a fresh run.
- In v1, Amaan changes these settings directly in the database (03 s4). Admin screens come after v1.

## 7. Cost per RFP (provisional)

🟨 **OPEN:** every AI cost figure here and in 01 s7 is provisional. Re-derive the figures from the providers' current price lists and Phase 1 measurements. Prices (06 s3) follow measured cost.

**Arithmetic, per model:**

| Term | Source |
|---|---|
| I = fresh input tokens per RFP, in millions | Phase 1 measurement |
| C = cached input tokens per RFP, in millions | Phase 1 measurement; 0 if the provider does not cache |
| O = output tokens per RFP, in millions | Phase 1 measurement |
| Pi, Pc, Po = USD per million input, cached input, and output tokens | Provider's current price list |

- With cache: cost (USD) = I × Pi + C × Pc + O × Po
- No cache: cost (USD) = (I + C) × Pi + O × Po
- Rupees: multiply by 97, or the rate of the day.

| Model | Pi | Pc | Po | With cache (₹) | No cache (₹) |
|---|---|---|---|---|---|
| Anthropic Haiku 5.5 | price list | price list | price list | v1 estimate about 11 | to derive |
| DeepInfra Qwen3.5-397B | price list | price list | price list | v1 estimate about 60 to 113 | to derive |
| DeepInfra DeepSeek V4 Pro | price list | price list | price list | v1 estimate about 95 | to derive |
| Anthropic Sonnet 5.5 | price list | price list | price list | v1 estimate about 212 | to derive |

The v1 estimates assumed about 400K fresh input, 1.35M cached, and 125K output tokens for a 200-page solicitation. A reviewer judged the Haiku and Sonnet figures too low once 125K output tokens are counted; they must be re-derived before use. A solicitation set with attachments has more tokens than 200 pages of solicitation, and amendment runs add more. Paid tabs add cost per use (resume matching, review scoring); the test measures both.

## 8. Known risks

- DeepInfra serves models in FP4 by default, which can lower accuracy. The test measures this directly.
- Some DeepInfra models serve a shorter context than the model supports. Chunk size stays within the served context.
- Skills were written for Claude. Open models may follow them less closely. The test covers skill plus model together.
- Some GovCon buyers distrust China-origin models. Decided: the Privacy Policy and the app name the model in use, and the Terms and Privacy Policy say a China-origin model may process documents (07 s3).
- Provider prefix caching may not apply to this pipeline. Costs assume none.
- Scanned documents take longer than text-layer PDFs. Phase 1 measures OCR time and sets the expectation.

## Decision log

| Date | Decision |
|---|---|
| 13 Oct 2026 | First test model: DeepInfra Qwen3.5-397B with skills; 98% recall gate |
| 13 Oct 2026 | Pages tagged by role (instructions, evaluation, scope) so federal and SLED bids share one pipeline |
| 13 Oct 2026 | Solicitation set defined (solicitation, amendment, attachment); every file in it goes through processing and passes 1 to 6; MB cap per bid, no page cap |
| 13 Oct 2026 | Amendment run processes changes only, with an amendment-diff step; superseded rows kept; unsure links go to the user |
| 13 Oct 2026 | Model test: 80% quote-overlap match rule, 3 tuning and 2 held-out documents, pass marks on held-out, pre-drop quote failure rate and drop count reported |
| 13 Oct 2026 | Time gate: under 10 minutes per 200-page text-layer PDF on an idle worker; scanned documents measured separately |
| 13 Oct 2026 | Phase 1 benchmark measures tokens per second, latency per chunk, JSON validity, and provider concurrency; concurrency and chunk size set from it |
| 13 Oct 2026 | Provider zero-retention and no-training terms requested before the golden set is sent |
| 13 Oct 2026 | Quote normalization defined; quotes may span two pages; Pass 3 flags instead of drops |
| 13 Oct 2026 | DOCX converted to PDF; OCR'd PDF kept as the viewer copy |
| 13 Oct 2026 | CUI and export-control marking check blocks AI work until the user confirms |
| 13 Oct 2026 | Dates task runs per chunk and is merged by code |
| 13 Oct 2026 | Token budget set after Phase 1; cost table shows arithmetic with a no-cache column; all AI cost figures provisional |
| 13 Oct 2026 | The app names the AI model in use (closes the v1 open item) |
| 15 Oct 2026 | Amendment key check (s3.1 step 1) built: deterministic token-run match against the bid key after extraction and before any AI step; the amendment is accepted, then held on a mismatch, no number, or a PENDING bid key; owner override on mismatch or not found resumes processing and is never refunded; a PENDING hold is rechecked when the key is set |

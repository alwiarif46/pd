# 03 — Data Model

**Status:** Draft v2 · 13 Oct 2026

All tables have `id` (UUID), `created_at`, `updated_at`. Tables marked **T** carry `org_id`, use `FORCE ROW LEVEL SECURITY`, and are reached by the app role `pd_app` only through row-level security (02 s4).

## 1. Accounts and billing

| Table | T | Key columns |
|---|---|---|
| `users` | | email (unique), email_verified_at, phone_e164 (unique), phone_verified_at, password_hash (Argon2id), name, last_login_at |
| `organizations` | | name, email_domain, plan (`free` \| `starter` \| `growth`), stripe_customer_id, stripe_subscription_id, plan_status (copied from the Stripe subscription status, or `free`), cycle_start, cycle_end (a cache of the current `rfp_credits` period), free_first_month_ends |
| `memberships` | T | user_id, role (`owner` \| `member`) |
| `invites` | T | email, role, token_hash, expires_at, accepted_at. The invite code is `<org id>.<token>`, so the token lookup runs under `app.org_id`. No `pd_system` function is needed |
| `sessions` | | user_id, token_hash, expires_at, revoked_at, last_seen_at, ip, user_agent |
| `auth_tokens` | | user_id, purpose (`verify_email` \| `reset_password`), token_hash, expires_at, used_at |
| `rfp_credits` | T | period_start, period_end, allowed, used, reserved. One row per period. The single source of truth for credits (06 s3) |
| `phone_codes` | | phone_e164, code_hash, expires_at, attempts |
| `stripe_events` | | event_id (unique), type, received_at, processed_at |
| `audit_log` | T | user_id, action, target_type, target_id, detail (JSON, no document text). Records marking confirmations, amendment key overrides, retention extensions, restores, support access, and deletions |

## 2. Bids and documents

| Table | T | Key columns |
|---|---|---|
| `bids` | T | name, agency, bid_type (`federal` \| `sled`), solicitation_number, solicitation_key (normalized number; one per bid), status, start_date, due_date, due_time, time_zone, count_mode, orals_enabled, credit_id, credit_status (`reserved` \| `consumed` \| `released`), key_overrides_used, retention_extended_until |
| `documents` | T | bid_id, file_name, mime, size_bytes, sha256, kind (`solicitation` \| `amendment` \| `attachment` \| `resume` \| `draft`), amendment_no (amendments only; 1 to 999), amendment_no_source (`user` \| `document` \| `sequence`; amendments only), amendment_no_found (the number read from the file), storage_path (original; null once archived or deleted), viewer_path (the PDF the viewer shows when it is not the original: the OCR'd PDF or the PDF converted from DOCX), extract_method (`pdf_text` \| `ocr` \| `docx_pdf` \| `docx_text_fallback` \| `xlsx`), pages_estimated, page_count, encryption (`none` \| `owner_password` \| `user_password`), scan_status, extract_status, marking_found (list of markings), marking_status (`none` \| `blocked` \| `confirmed`), live_until, live_status (`live` \| `archived` \| `restoring` \| `restored` \| `deleted`), key_status (amendments only: `match` \| `mismatch` \| `not_found` \| `bid_key_pending` \| `overridden`; null until the key check runs), key_found (the number the key check found) |
| `upload_sessions` | T | bid_id, user_id, file_name, kind, declared_size, sha256, chunk_count, chunks_received, bytes_received, status, expires_at (24 hours after start), amendment_no (amendments only: the number typed at upload) |
| `amendments` | T | bid_id, document_id (one row per document), amendment_no (mirrors `documents.amendment_no`; null until settled), solicitation_key_found, key_override, override_reason, status (`held` \| `needs_number` \| `processing` \| `failed` \| `needs_confirmation` \| `applied`; `held` while the key check did not match and there is no override; `needs_number` while the key passed but the number is not settled; `failed` when the amendment step failed, until a retry), matched_key (the bid key the check compared against), dates_changed |
| `amendment_links` | T | amendment_id, row_table, old_row_id (null for an added row), new_row_id (null for a withdrawn row), action (`supersede` \| `withdraw` \| `add`), confidence, status (`auto` \| `proposed` \| `confirmed` \| `rejected`), decided_by, source_page and source_quote (the amendment text behind a supersede or withdraw, quote-checked) |
| `pages` | T | document_id, page_no, text, ocr_used, section_tag (`instructions` \| `evaluation` \| `scope` \| `terms` \| `attachments` \| `other`) |
| `archive_objects` | T | document_id, object_type (`original` \| `viewer`), archive_key, archived_at, expires_at (see 07 s2), restore_status (`none` \| `requested` \| `restoring` \| `restored`), restore_requested_at, restored_until, purged_at |
| `jobs` | T | bid_id, document_id, type, status, progress, queue_position, error, started_at, finished_at |
| `exports` | T | bid_id, tab, format, storage_path, created_by, expires_at (24 hours) |

- `solicitation_key` uppercases the solicitation number and strips every character that is not a letter or a digit (`normalizeSolicitationKey`); a bid with no number yet holds `PENDING`. The amendment rule and the one-solicitation-per-bid rule compare keys (06 s4).
- The **solicitation set** is every document of kind `solicitation`, `amendment`, or `attachment` on the bid (04 s2).
- **MB used per bid** is the sum of `size_bytes` of every document on the bid, live or archived, plus the declared size of open upload sessions. The cap is 50 MB on Free and 300 MB on Starter and Growth (06 s3). Deleting a file frees its space.
- `live_until`: Free, upload date plus 90 days. Starter and Growth, the later of upload plus 90 days and `bids.due_date` plus 90 days, or `bids.retention_extended_until` if the owner set a later date. Resumes, always upload plus 90 days.
- `amendment_no` on tab rows is 0 for the original solicitation set and N for Amendment N.
- **Amendment numbers** (04 s3.1). A number N is taken on a bid when another amendment of the bid holds it and either its document is not deleted or it wrote rows (`needs_confirmation` or `applied`). Deleting an amendment frees its number only if it never wrote rows. Upload start also counts open upload sessions that typed N. Gaps are allowed. The partial unique index `documents_bid_amendment_no_uq` (bid_id, amendment_no over amendments that are not deleted) is a backstop; the rule is checked in code under the bid lock.
- **Lock order** for row locks, api and worker alike (apps/api/src/credits.ts): organizations, documents, check_these, upload_sessions, bids, amendments, amendment_links, compliance_rows (by id), rfp_credits.

## 3. Tab data

### 3.1 Source columns

Every source-bearing row carries the same source columns, so the row detail slider (05 s3.12) shows any row the same way.

| Column | Meaning |
|---|---|
| document_id | The document the quote comes from |
| source_page | Page where the quote starts |
| source_page_end | Page where it ends, when it crosses a page break (null otherwise) |
| source_quote | The exact text from the document |
| quote_verified | The code quote check passed (04 s1) |
| amendment_no | 0 = original solicitation set; N = created by Amendment N |
| supersede_status | `active` \| `superseded` \| `withdrawn` |
| superseded_by_row_id | The row that replaces this one (null when active or withdrawn) |
| changed_by_amendment | The amendment number that superseded or withdrew this row |
| origin | `ai` \| `user` |
| confidence | Model confidence, 0 to 1 (null for user rows) |
| flags | List, for example `maybe_not_requirement`, `page_estimated`, `ocr_text`, `date_conflict` |

Tables with these columns: `bid_facts`, `schedule_activities` (AI-extracted dates; user activities leave them empty), `compliance_rows`, `outline_items`, `personnel_requirements`, `production_items`, `orals_items`. `review_findings` carry document_id, source_page, source_page_end, and source_quote that point at the draft, without the amendment columns. User-made rows have origin `user` and may have no quote.

### 3.2 Tables

| Table | T | Tab | Key columns |
|---|---|---|---|
| `bid_facts` | T | Overview | field, value, source columns, confirmed |
| `kickoff_items` | T | Overview | label, done, owner, note |
| `schedule_activities` | T | Schedule | label, phase, start_date, end_date, time, owner, artifact, note, status, locked, source columns |
| `compliance_rows` | T | Compliance matrix | req_id, section_ref, requirement_text, source columns, req_type (`shall` \| `must` \| `will` \| `should` \| `other`), instr_ref (Section L reference on federal bids), eval_ref (Section M factor on federal bids), response_section, owner, status |
| `outline_items` | T | Outline | parent_id, number, title, page_limit, source_ref (the instruction's section reference), source columns, writer, status, due_date |
| `personnel_requirements` | T | Resume matrix | role, requirement, kind (`degree` \| `years` \| `certification` \| `clearance` \| `skill` \| `other`), source columns |
| `candidates` | T | Resume matrix | name, role, document_id (null after the resume is deleted at 90 days; the name stays) |
| `resume_matches` | T | Resume matrix | candidate_id, requirement_id, result (`meets` \| `partial` \| `gap` \| `unknown`), evidence_quote, evidence_page (both cleared when the resume is deleted at 90 days), reviewer_override |
| `reviews` | T | Color team | type (`pink` \| `red` \| `green` \| `gold` \| `other`), draft_document_id, scheduled_at, status |
| `review_assignments` | T | Color team | review_id, reviewer_name, sections |
| `review_findings` | T | Color team | review_id, eval_factor, kind (`strength` \| `weakness` \| `deficiency` \| `risk` \| `comment`), text, document_id (the draft), source_page, source_page_end, source_quote (from the draft), origin, disposition |
| `production_items` | T | Production | category, rule, source columns, done |
| `orals_items` | T | Orals | category, item, source columns, done |
| `lessons` | T | Lessons learned | question, answer, author |
| `row_history` | T | All | row_table, row_id, user_id (null for AI), field, old_value, new_value, changed_at. Feeds the edit history in the row detail slider |

`requirement_text` is the requirement in short, normalized form. `source_quote` is the exact text from the document. They are separate columns. The quote check and the source viewer use `source_quote` only.

### 3.3 Amendment rules in the data

- A row created by Amendment N has `amendment_no` = N ("Added by Amd N" when it replaces nothing).
- A superseded row is never deleted. It gets `supersede_status` = `superseded`, `superseded_by_row_id` = the new row, and `changed_by_amendment` = N.
- A withdrawn row has `supersede_status` = `withdrawn`, no replacement row, and `changed_by_amendment` = N.
- Links the model is unsure of stay in `amendment_links` with status `proposed`. The old row stays `active` until the user confirms.
- Every row an amendment adds is inserted, with `document_id` = the amendment and an `add` link (null `old_row_id`) when it replaces nothing; `add` links are always `auto`. Supersede and withdraw links carry `source_page` and `source_quote` from the amendment.
- Link decisions are final: only a `proposed` link is confirmed or rejected. When the user deletes or merges away a row, proposed links whose `new_row_id` is that row become `rejected`, and a row whose `superseded_by_row_id` pointed at it stays `superseded` with a null pointer. Deleting an applied amendment keeps the rows and closures it wrote.

## 4. AI records and settings

| Table | T | Key columns |
|---|---|---|
| `ai_runs` | T | bid_id, task, provider, model, skill_name, skill_version, prompt_version, status, input_tokens, cached_tokens, output_tokens, cost_usd, duration_ms |
| `ai_settings` | | task, provider, model, max_output_tokens, temperature, chunk_tokens, active |
| `provider_settings` | | provider, max_concurrent, per_bid_cap |
| `app_settings` | | key, value (token budget per RFP, daily and monthly AI caps, amendment link confidence, retention and quota values) |
| `ai_usage_daily` | | day, provider, model, tokens, cost_usd |

- `ai_runs` never stores prompt or response text in production. The eval harness stores full text on the test machine only.
- In v1 Amaan changes settings, caps, and credits directly in these tables. Admin screens come after v1.

## 5. File storage

```
/data/files/{org_id}/{bid_id}/
├── uploads/{document_id}.{ext}        original file, until live_until
├── viewer/{document_id}.pdf           viewer copy (OCR'd PDF or DOCX converted to PDF), same retention as the original
├── chunks/{upload_session_id}/        upload chunks, deleted on completion or after 24 hours
└── exports/{export_id}.{xlsx|docx}    expires after 24 hours

Archive (off-server object storage, encrypted before upload)
{org_id}/{bid_id}/{document_id}/original
{org_id}/{bid_id}/{document_id}/viewer
```

- Files on the server are encrypted at rest with a key held outside the database. 🟨 **OPEN:** disk encryption (LUKS on the data volume) or per-file encryption.
- Archive objects are encrypted on the server before upload, with a key held outside the archive (01 s4).
- Extracted page text lives only in the `pages` table, not on disk.
- The retention job runs nightly. Rules are in 07 s2:
  - A document that is not a resume, past its `live_until`: encrypt the original and the viewer copy, copy them to the archive, verify the copy, write `archive_objects` rows, delete the server copies, set `storage_path` and `viewer_path` to null, and set `live_status` to `archived`. Its `pages` rows stay.
  - A resume at upload plus 90 days: delete the file, its `pages` rows, and `resume_matches.evidence_quote` and `evidence_page`; set `candidates.document_id` to null. Nothing goes to the archive. Candidate names stay.
  - A restored file is deleted from the server again when `restored_until` passes. The archive copy stays.
  - Archive objects past `expires_at` are purged.
- Deleting a bid or an organization, or a user's deletion request, deletes the rows, `pages`, server files, and archive objects (07 s2).
- Source quotes stay on tab rows in `source_quote`, and page text stays in `pages`, so tabs and the source viewer keep working after a file leaves the server.

## Decision log

| Date | Decision |
|---|---|
| 13 Oct 2026 | Row-level security on all tenant tables; quote and page stored with every AI-extracted row |
| 13 Oct 2026 | Section tags and reference columns named by role so SLED bids fit |
| 13 Oct 2026 | Common source columns on every source-bearing table: document_id, source_page, source_page_end, source_quote (separate from requirement_text); orals_items and outline_items gain quotes |
| 13 Oct 2026 | Amendment fields: amendment_no, supersede_status, superseded_by_row_id, changed_by_amendment; `amendments` and `amendment_links` tables; superseded rows never deleted |
| 13 Oct 2026 | `bids.bid_type` (`federal` \| `sled`) added for column labels |
| 13 Oct 2026 | Credit reservation: `rfp_credits.reserved`, `bids.credit_status`; `rfp_credits` is the source of truth, `organizations.cycle_*` a cache |
| 13 Oct 2026 | Tables added: `exports`, `stripe_events`, `upload_sessions`, `auth_tokens`, `sessions`, `archive_objects`, `row_history`, `provider_settings`, `app_settings` |
| 13 Oct 2026 | Archive instead of deletion at the live date; page text kept until the bid is deleted, except resumes, which are deleted at 90 days |
| 13 Oct 2026 | Viewer copy kept for OCR'd PDFs and DOCX converted to PDF, with the original's retention |
| 13 Oct 2026 | MB cap per bid counts every file on the bid; no page cap |
| 15 Oct 2026 | Amendment key check (migration 0008): `documents.key_status` and `key_found`, `amendments.matched_key`, amendment status `held`, one `amendments` row per document; `solicitation_key` described as uppercased (it never lowercased) |
| 15 Oct 2026 | Amendment run: added rows inserted with the amendment as their document and an always-auto `add` link; link quotes stored; decisions final; row delete and merge reject proposals to the removed row and clear `superseded_by_row_id` |
| 15 Oct 2026 | Amendment numbers (migration 0009): `documents.amendment_no_source` and `amendment_no_found`, `upload_sessions.amendment_no`, number 1 to 999 and unique per bid among amendments not deleted; `amendments.amendment_no` mirrors the document and may be null; amendment status `needs_number` and `failed`; `amendment_links.source_page` and `source_quote`; app setting `amendment_link_confidence` = 0.80; existing amendments numbered by upload date; lock order extended with amendment_links and compliance_rows |

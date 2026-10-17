# 03: Data Model

**Status:** Draft v2 · 17 Oct 2026

E2E Proposal keeps PD's schema and adds tables for runs, drafted content, reviews, the tenant repository, and the mid-run tracks. Table names match the stages in 04-pipeline.

Each table lives in the schema of the service that owns it (s12; 09 s4). One Postgres cluster holds every schema. No service reads another service's schema.

All tables have `id` (UUID), `created_at`, and `updated_at`. Tables marked **T** carry `tenant_id`, use `FORCE ROW LEVEL SECURITY`, and each service role reaches them only through row-level security, as in PD (PD 02 s4). No query, cache key, or file path mixes two tenants.

## 1. PD tables reused

These PD tables carry over with their columns and rules (PD 03). The table lists each change.

| PD table | Change in the tool |
|---|---|
| `organizations` | Serves as `tenants` in the identity schema (section 2). `org_id` keeps the same UUID as `tenant_id` |
| `users`, `memberships`, `invites` | Move to the identity schema. `users` becomes a mirror keyed by the Zitadel user id. Roles follow 06-accounts-billing, roles |
| `sessions`, `auth_tokens`, `phone_codes` | Dropped. Zitadel holds sessions and credentials; SMS verification is not required (06 s1; 09 s4.2) |
| `audit_log` | Adds actions: lock and unlock, gate decision, email send, portal login approval, font license confirmation, signature notice |
| `bids` | Adds the columns in section 3 |
| `documents` | Adds kinds: `past_performance`, `third_party`, `form`, `qa_release`, `questionnaire` |
| `upload_sessions`, `pages`, `archive_objects`, `jobs`, `exports` | None |
| `amendments`, `amendment_links` | Adds `source` (`upload` \| `ebuy_inbound` \| `ebuy_check` \| `portal`) and `impact_report` (JSON) |
| `bid_facts`, `schedule_activities`, `compliance_rows`, `outline_items`, `production_items` | None. Source columns as in PD 03 s3.1 |
| `personnel_requirements`, `candidates`, `resume_matches` | None |
| `reviews`, `review_findings` | Extended (section 6) |
| `row_history` | Stays with intel's rows. Block edits go to `block_versions` (section 5) |
| `ai_runs` | Adds `run_id`, `stage_id`, `role` (`drafter` \| `gate` \| `reviewer` \| `vision` \| `image` \| `other`) |
| `ai_settings`, `provider_settings`, `app_settings` | Extended (section 10) |
| `stripe_events` | None |
| `rfp_credits` | Serves as `proposal_credits` (section 9) |

`pages` stays the solicitation page table, as in PD. Drafted proposal pages live in `draft_pages`.

Tenant key: decided. The identity service owns `tenant_id` (09 s4.2). PD's tables keep `org_id`, which holds the same UUID. `withTenant` sets both `app.tenant_id` and `app.org_id` until PD's tables move to `tenant_id`. This file writes `tenant_id`.

## 2. Tenants and connections

| Table | T | Key columns |
|---|---|---|
| `tenants` | | PD `organizations` columns, plus `slug` (for the inbound address), `plan`, `zitadel_org_id`, `drive_folder_id`, `inbound_address` (unique), `disclosures_accepted_at`, `disclosures_version`. Only the identity service writes it |
| `users` | T | zitadel_user_id (unique), email, name, status, last_seen_at. A mirror of the Zitadel user, kept current from Zitadel events |
| `sso_connections` | T | kind (`google` \| `microsoft` \| `saml`), domain, zitadel_idp_id, enforced (true makes SSO the only sign-in), status. SAML only on Enterprise. The provider metadata lives in Zitadel |
| `org_map` | | org_id, tenant_id. Both hold the same UUID; the row records that a PD organization became a tenant |
| `oauth_tokens` | T | mail_connection_id, encrypted refresh token, scopes, expires_at, revoked_at. Comms only |
| `mail_connections` | T | provider (`gmail` \| `m365`), mailbox_address, connection_ref (the MCP connection handle), status (`active` \| `expired` \| `revoked`), connected_by, last_ok_at |
| `drive_folders` | T | folder_id, share_status, shared_user_ids, last_sync_at |
| `drive_documents` | T | bid_id, drive_file_id, kind (`pink` \| `working`), version, local_copy_path, last_read_at |
| `format_specs` | T | bid_id (null for the tenant's house style), spec (JSON: styles, colors, numbering, headers, words per page, fonts), source (`captured` \| `solicitation` \| `reconciled`), captured_from_document_id, version |
| `client_shells` | T | name, document_id (the cover and contents shell), verified_at |
| `tenant_fonts` | T | family, style, file_path, origin (`preinstalled` \| `requested`), license_confirmed_by, license_confirmed_at, metric_substitute |
| `font_requests` | T | family, status (`requested` \| `uploaded` \| `installed` \| `rejected`), document_id (the uploaded font), commercial, license_confirmed, fee_charge_id |
| `portal_sessions` | T | bid_id, portal (`sam` \| `piee` \| `ebuy` \| `state` \| `other`), approved_by, started_at, ended_at, files_fetched, outcome. No credential column exists |

Preinstalled fonts live once in the render service image and are not tenant rows. `tenant_fonts` holds requested fonts only, plus the substitute map the render step uses.

`mail_connections` stores a handle, never a password. 07-security-privacy-legal, credentials, sets where the OAuth tokens behind the handle live.

Passwords, sessions, MFA factors, passkeys, and identity provider settings live in Zitadel's own database, not in any E2E schema. Decided 17 Oct 2026: the split above between that database and the identity schema (🟨 **OPEN**, 00 s7 item 67).

## 3. Bids and intake

New `bids` columns:

| Column | Meaning |
|---|---|
| `ai_ban_flag` | `none` \| `restricted` \| `banned`, with `ai_ban_quote`, `ai_ban_page`, `ai_ban_document_id` |
| `bid_decision` | `pending` \| `bid` \| `no_bid`, with `bid_decided_by` and `bid_decided_at` |
| `ebuy_rfq_number` | Set when the bid came from the eBuy watcher |
| `submission_format` | `pdf` \| `word` \| `mixed` |
| `drive_path` | The bid's folder inside the tenant's Drive folder |

| Table | T | Key columns |
|---|---|---|
| `intake_items` | T | bid_id, label, kind (`rfp` \| `past_performance` \| `resume` \| `pricing_rates` \| `commitment_letter` \| `form` \| `certificate` \| `other`), mandatory, status (`have` \| `need` \| `requested` \| `received`), source (`repo` \| `upload` \| `request`), repo_item_id, document_id, need_id, due_before_stage (default `red`) |
| `bid_scores` | T | bid_id, run_id, dimension (`fit` \| `eligibility` \| `past_performance` \| `risk`), score, basis (JSON with quotes and evidence ids) |

## 4. Runs and stages

| Table | T | Key columns |
|---|---|---|
| `runs` | T | bid_id, round (1, 2, ...), status (`estimating` \| `queued` \| `running` \| `waiting_gate` \| `paused_cost` \| `failed` \| `done` \| `cancelled`), current_stage, estimate_usd, estimate_minutes, cost_cap_usd, cost_used_usd, drafted_pages, proposal_credit_id, drafter_model, reviewer_model, started_at, finished_at |
| `stages` | T | run_id, stage_key (04 s3), scope_type (`run` \| `volume` \| `section` \| `page`), scope_id, status (`pending` \| `running` \| `done` \| `failed` \| `skipped` \| `reopened`), attempt, input_hash, idempotency_key (unique), output_ref, gate_string, error, started_at, finished_at |
| `gates` | T | run_id, gate (`0` \| `0b` \| `1` \| `2`), status (`open` \| `approved` \| `rejected`), decided_by, decided_at, note |
| `tool_calls` | T | stage_id, script, subcommand, args_hash, exit_code, duration_ms, output_ref |
| `cost_ledger` | T | run_id, stage_id, ai_run_ref, role, cost_usd, recorded_at. Filled from `modelgw.usage.metered` events |
| `run_artifacts` | T | run_id, stage_id, kind (`matrix_json` \| `outline_json` \| `blank_register` \| `hot_buttons` \| `glossary` \| `search_terms` \| `style_sheet` \| `evidence_index` \| `strength_ledger` \| `adversarial` \| `pillars` \| `gold_record` \| `impact_report` \| `other`), storage_path, sha256 |

- `idempotency_key` is run, stage key, scope, and input hash. A duplicate job with the same key does nothing (04 s12).
- A reopened stage (amendment re-entry) gets a new row with a new input hash. The old row stays for history.
- Scripts read and write JSON artifacts as files. `run_artifacts` records each one. Tables below hold the rows the UI shows.

## 5. Proposal content

| Table | T | Key columns |
|---|---|---|
| `volumes` | T | bid_id, number, title, page_limit, format_spec_id, shell_id |
| `proposal_sections` | T | volume_id, outline_item_id, parent_id, order, heading_text, key_term, differentiator, story_mode (`story` \| `none` \| `review`), page_budget, word_budget, status |
| `blanks` | T | bid_id, blank_id (for example `M2.1-S01`), factor_ref, type, evaluator_prompt, weight, section_id, status (`open` \| `filled` \| `masked`) |
| `glossary_terms` | T | bid_id, term, kind, wrong_forms, source columns |
| `search_terms` | T | bid_id, term, req_id |
| `draft_pages` | T | section_id, run_id, round, page_no, gate_score, element_scores (JSON), gate_status (`pending` \| `pass` \| `fail` \| `escalated`), gate_attempts, pdf_page_no |
| `blocks` | T | section_id, draft_page_id, order, kind (`heading` \| `paragraph` \| `table` \| `graphic` \| `caption` \| `list`), text, data (JSON for tables), current_version, locked, locked_by, locked_at, lock_reason (`gate1_edit` \| `need_fill` \| `editor` \| `proposal_accepted`) |
| `block_versions` | T | block_id, version, round, stage_id, text, data, author (`model` \| user id), created_at |
| `change_proposals` | T | block_id, from_version, proposed_text, reason, source (`recovery` \| `sweep` \| `white_glove` \| `amendment`), amendment_id, status (`open` \| `approved` \| `rejected`), decided_by |
| `page_checks` | T | draft_page_id, check (`kill_words` \| `plain_language` \| `term_mirror` \| `customer_focus` \| `strength` \| `story` \| `content_gate` \| `format` \| `visual_mix` \| `detector_risk`), exit_code, result (JSON), round |
| `strengths` | T | block_id, factor_ref, blank_id, feature, delta, benefit, proof, verdict (`keep` \| `rewrite` \| `cut`) |
| `claims` | T | block_id, claim_type (`past_performance` \| `staffing` \| `figure` \| `other`), text |
| `citations` | T | claim_id, evidence_item_id, document_id, page, quote |
| `visuals` | T | block_id, kind (`table` \| `svg` \| `image`), blank_id, caption, source_spec (JSON), storage_path, provider, cost_usd |
| `evidence_links` | T | section_id, evidence_item_id, use (`proof` \| `vignette` \| `background`) |
| `vignettes` | T | bid_id, contract_id, challenge, solution, result, relevance, status (`ready` \| `needs`), citations (JSON) |

**Lock rules in the data.** `blocks.locked` is true once a human edits the block. Code compares a locked block's `current_version` before and after each model call. A database trigger refuses a model write to a locked block. It allows only a user write or an approved `change_proposals` row. Unlocking writes `audit_log`.

**Round diff.** Gate 2 shows the change between rounds from `block_versions`, grouped by `draft_pages.pdf_page_no` (05 s4).

**Citation rule.** Assembly refuses a volume while any `claims` row of type `past_performance`, `staffing`, or `figure` has no `citations` row (04 s5).

## 6. Reviews, findings, and NEEDs

| Table | T | Key columns |
|---|---|---|
| `reviews` | T | PD columns, plus run_id, type adds `white`, reviewer_model, weight_coverage |
| `review_findings` | T | PD columns, plus run_id, block_id, draft_page_id, factor_ref, req_ids, severity (`critical` \| `major` \| `minor`), remediation, rewrite, predicted_impact, triage |
| `dispositions` | T | finding_id, action (`accept` \| `edit` \| `reject`), edited_text, note, decided_by, decided_at, applied_stage_id |
| `factor_ratings` | T | review_id, factor_ref, predicted_rating, basis |
| `needs` | T | bid_id, need_no (for example `NEED-007`), kind (`fact` \| `figure` \| `document` \| `graphic` \| `font` \| `pricing` \| `other`), question, best_guess, block_id, blank_id, status (`open` \| `reused` \| `filled` \| `masked`), score_impact, filled_value, filled_by, fill_source (`user` \| `register` \| `request` \| `upload`), request_id |

- `score_impact` ranks NEEDs at Gate 1. Red writes it from the factor weight and the blank's weight.
- `masked` means the fact is not available and generic text took its place, as in the plugin. Gold lists every masked NEED.
- Filling a NEED writes the value into its block and locks the block.

## 7. Evidence and repository, with learning

Every table here is tenant-scoped. The vendor's own evidence library is not part of the tool.

| Table | T | Key columns |
|---|---|---|
| `evidence_documents` | T | document_id, doc_type (`cpars` \| `ppq` \| `award` \| `modification` \| `task_order` \| `resume` \| `certificate` \| `capability_statement` \| `proposal_final` \| `debrief` \| `other`), contract_id, captured_at |
| `contracts` | T | name, agency, number, role (`prime` \| `sub`), start, end, value, naics, scope_summary |
| `evidence_items` | T | contract_id, fact, figure, period, method, document_id, page, quote, confirmed_by |
| `needs_register` | T | question_key, answer, source_bid_id, source_need_id, confirmed, last_used_at |
| `repo_items` | T | kind (`section` \| `graphic` \| `design` \| `table` \| `form` \| `resume` \| `cover_letter` \| `other`), agency, factor_ref, section_type, contract_id, bid_id, submitted_on, outcome, storage_path, text, tags |
| `outcomes` | T | bid_id, result (`won` \| `lost` \| `cancelled` \| `pending`), award_value, debrief_document_id, notes |
| `learning_events` | T | bid_id, source (`need_fill` \| `disposition` \| `outcome` \| `debrief`), ref_id, signal (JSON) |
| `gate_calibration` | T | factor_ref, section_type, samples, offset, updated_from_outcome_id |
| `repo_embeddings` | T | repo_item_id, chunk_no, embedding (pgvector), model. Searched only inside the tenant |

Intake fetches from `repo_items`, `evidence_items`, and `needs_register` first (04 s5). Repository fetch filters by agency, factor, section type, contract, and date. Learning reads `learning_events` per tenant only.

🟨 **OPEN:** how `gate_calibration` changes the 90% gate score, if at all.

## 8. Mid-run tracks

| Table | T | Key columns |
|---|---|---|
| `qa_sets` | T | bid_id, due_at, time_zone, format_rules (JSON with quotes), questionnaire_document_id, filled_document_id, to_address, status (`draft` \| `reviewed` \| `sent` \| `answered`) |
| `qa_questions` | T | qa_set_id, order, text, req_ids, reason, source columns, status |
| `third_party_requests` | T | bid_id, kind (`commitment_letter` \| `pp_form` \| `resume_consent` \| `other`), requestee_name, requestee_email, template_document_id, due_at, status (`draft` \| `sent` \| `received` \| `accepted` \| `rejected`), need_id |
| `request_replies` | T | request_id, channel (`email` \| `upload`), document_id, message_ref, received_at |
| `outbound_emails` | T | mail_connection_id, purpose (`qa` \| `request` \| `reminder`), ref_id, to, cc, subject, body, attachments, status (`draft` \| `approved` \| `sent` \| `failed`), approved_by, sent_at, provider_message_id, thread_ref, error |
| `inbound_messages` | T | inbound_address, received_at, from, subject, parsed_rfq_number, bid_id, status (`parsed` \| `bid_opened` \| `amendment` \| `ignored` \| `failed`), raw_ref |
| `ebuy_checks` | T | checked_at, method (`connector` \| `browser_agent`), found, missed_by_inbound |
| `notifications` | T | user_id, kind, ref_id, read_at, channel (`in_app` \| `email`) |
| `alerts` | T | bid_id, kind (`qa_deadline` \| `proposal_due` \| `request_due` \| `cost_cap` \| `connection`), due_at, sent_at |

An email sends only from `approved` status, and only a user moves it there. For Q&A that is decided. For requests it is proposed (🟨 **OPEN**, 07 s3). A reply on `thread_ref` links to its request. "Overdue" on the tracker is a display state from `due_at`, not a stored status.

## 9. Packages and billing usage

| Table | T | Key columns |
|---|---|---|
| `renders` | T | volume_id, run_id, round, pdf_path, page_count, page_limit, fonts_used, substitutions, status |
| `render_issues` | T | render_id, pdf_page_no, issue (`overflow` \| `broken_table` \| `cut_graphic` \| `orphan_heading` \| `margin` \| `other`), block_id, status |
| `packages` | T | run_id, status (`building` \| `ready` \| `downloaded`), zip_path, word_note (true when the submission includes a Word file), checklist (JSON) |
| `package_files` | T | package_id, kind (`volume_docx` \| `volume_pdf` \| `form` \| `attachment` \| `matrix` \| `checklist` \| `note`), file_name (per the solicitation's naming rule), document_id, page_count, verified |
| `signature_items` | T | package_file_id, action (`sign` \| `review`), signer_role, note, status (`open` \| `done`) |
| `proposal_credits` | T | PD `rfp_credits` columns: period_start, period_end, allowed, used, reserved |
| `run_usage` | T | run_id, model_input_tokens, model_output_tokens, model_cost_usd, image_count, image_cost_usd, drafted_pages, pages_over_allowance |
| `charges` | T | kind (`recharge` \| `font_fee`), ref_id, amount, currency, stripe_ref, status |

Credit, recharge, and fee rules live in 06-accounts-billing. A credit moves from `reserved` at run start to `used` when the Red draft reaches the tenant. It moves back to free on no-bid, or when the run fails or is cancelled before the Red draft (06 s4). Unused credits reset each month, not by deleting rows.

## 10. Settings

| Table | Change |
|---|---|
| `ai_settings` | Adds `role` (`drafter` \| `gate` \| `reviewer` \| `vision` \| `image`) and `stage_key`. A check refuses a reviewer row whose model equals the drafter row for the same stage |
| `provider_settings` | Adds the Anthropic and image provider rows with concurrency and rate-limit values |
| `run_budgets` | New, in the model gateway: run_id, cap_usd, used_usd, status. Set from `orchestrator.run.budget_set` |
| `app_settings` | Adds `page_gate_threshold` (0.90), `page_gate_max_cycles` (3), `recovery_max_loops` (3), `visual_reserve` (0.40), `red_weight_coverage_min` (0.85), `run_cost_cap_usd` (set from the 10-RFP test, 08 Phase 9), `page_allowance` (100) |

## 11. File storage

```
/data/files/{tenant_id}/
├── fonts/{font_id}.{ttf|otf}             requested fonts, this tenant only
├── shells/{shell_id}.docx                cover and contents shells
├── evidence/{document_id}.{ext}          evidence library originals
├── repo/{repo_item_id}/...               repository items
└── {bid_id}/
    ├── uploads/  viewer/  chunks/  exports/     as in PD 03 s5
    └── runs/{run_id}/
        ├── artifacts/{kind}.json          run_artifacts
        ├── visuals/{visual_id}.{svg|png}
        ├── volumes/{volume_id}/r{round}.docx
        ├── renders/{render_id}.pdf
        ├── raster/{render_id}/{page}.png  deleted after the vision check
        └── package/{package_id}.zip

Shaavir Drive
/{tenant folder}/{bid name}/
├── Pink review document
└── Working documents
```

- Preinstalled fonts live in the render service image, outside tenant paths.
- Keys under `{tenant_id}/` are written only by the owning service, for example `runs/` by render and drafting.
- Files stay encrypted at rest as in PD. 07-security-privacy-legal, data retention, holds the retention and deletion rules.
- Archive layout follows PD (PD 03 s5), with `tenant_id` in place of `org_id`.

## 12. Schemas by service

| Schema (service) | Tables |
|---|---|
| `identity` (2) | `tenants`, `users` (mirror), `memberships`, `invites`, `sso_connections`, `org_map`. Zitadel's own database sits beside these schemas in the cluster and belongs to Zitadel alone |
| `billing` (3) | `subscriptions`, `proposal_credits`, `charges`, `stripe_events`, `run_usage` |
| `ingest` (4) | `documents`, `upload_sessions`, `pages`, `archive_objects`, `jobs`, `exports` |
| `intel` (5) | `bids`, `bid_facts`, `schedule_activities`, `compliance_rows`, `outline_items`, `production_items`, `personnel_requirements`, `row_history`, `amendments`, `amendment_links`, `glossary_terms`, `search_terms`, `bid_scores`, `intake_items` |
| `orchestrator` (6) | `runs`, `stages`, `gates`, `tool_calls`, `run_artifacts`, `cost_ledger` |
| `modelgw` (7) | `ai_runs`, `ai_settings`, `provider_settings`, `run_budgets` |
| `drafting` (8) | `volumes`, `proposal_sections`, `blanks`, `draft_pages`, `blocks`, `block_versions`, `change_proposals`, `page_checks`, `strengths`, `claims`, `citations`, `visuals`, `evidence_links`, `vignettes`, `needs` |
| `review` (9) | `reviews`, `review_findings`, `dispositions`, `factor_ratings` |
| `render` (10) | `format_specs`, `client_shells`, `tenant_fonts`, `font_requests`, `renders`, `render_issues`, `packages`, `package_files`, `signature_items` |
| `evidence` (11) | `evidence_documents`, `contracts`, `evidence_items`, `needs_register`, `repo_items`, `repo_embeddings` (pgvector), `candidates`, `resume_matches`, `outcomes`, `learning_events`, `gate_calibration` |
| `comms` (12) | `mail_connections`, `oauth_tokens`, `qa_sets`, `qa_questions`, `third_party_requests`, `request_replies`, `outbound_emails`, `inbound_messages`, `ebuy_checks` |
| `portal` (13) | `portal_sessions` |
| `drive` (14) | `drive_folders`, `drive_documents` |
| `notify` (15) | `notifications`, `alerts`, `audit_log` |
| `app` (shared settings) | `app_settings`, read by every service through its own read-only view |

- Every schema also holds an `outbox` table for its events (09 s2).
- A column that names another service's row, such as `runs.bid_id`, holds the id only. No foreign key crosses a schema. The owning service's API resolves it.
- A service that needs another service's data keeps a read copy built from events, or calls the API.

## Decision log

| Date | Decision |
|---|---|
| 17 Oct 2026 | PD schema reused; `pages` stays solicitation pages; drafted pages in `draft_pages` |
| 17 Oct 2026 | Runs and stages in `runs` and `stages` with a unique idempotency key; reopened stages get a new row |
| 17 Oct 2026 | Blocks carry locks; a database trigger refuses model writes to locked blocks; changes go through `change_proposals` |
| 17 Oct 2026 | `block_versions` per round feeds the Gate 2 round diff |
| 17 Oct 2026 | `claims` and `citations` tables; assembly refuses uncited past performance, staffing, and figure claims |
| 17 Oct 2026 | NEEDs carry `score_impact` for Gate 1 ranking; filling a NEED locks its block |
| 17 Oct 2026 | Evidence, repository, needs register, and learning tables are tenant-scoped; the vendor's library is not part of the tool |
| 17 Oct 2026 | Mid-run tracks stored in `qa_sets`, `third_party_requests`, `outbound_emails`, `inbound_messages`; emails send only from `approved` |
| 17 Oct 2026 | No credential column for portals; mailbox stored as a connection handle |
| 17 Oct 2026 | Review pass: title form fixed; request send marked Proposed; `org_id` question moved under s1 |
| 17 Oct 2026 | Owner decision: one schema per service in one cluster (s12); no cross-schema foreign keys or reads |
| 17 Oct 2026 | Owner decision: the identity service owns `tenant_id`; PD's `org_id` keeps the same value. The rename question is closed |
| 17 Oct 2026 | Owner decision: `phone_codes` dropped with SMS verification; `sso_connections` added |
| 17 Oct 2026 | Owner decision: Zitadel holds credentials, sessions, MFA factors, and identity providers in its own database. `sessions` and `auth_tokens` dropped; `users` becomes a mirror (item 61 closed; split Proposed, item 67) |
| 17 Oct 2026 | Owner decision: a proposal credit is reserved at run start, released on no-bid, and consumed when the Red draft reaches the tenant (06 s4) |
| 17 Oct 2026 | Owner decision: a run that ends `failed` or `cancelled` before the Red draft releases its credit (06 s4) |
| 17 Oct 2026 | Final review: `row_history` stays in the intel schema; the credit rule in s9 names the failure and cancel release |

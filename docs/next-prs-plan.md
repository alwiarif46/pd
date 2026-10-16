# Next PRs: implementation plan (architect, 15 Oct 2026)

Order: PR1 Cleanup, PR2 API follow-ups, PR3 Credit gaps, PR4 Schedule port (migration 0010), PR5 Amendment steps 7-8 (migration 0011).

PR4 comes before PR5 for two reasons. Both add columns to `schedule_activities`, so their migrations must run in sequence. And PR5's amendment date prompt needs the new Schedule UI to show it.

## PR1: Cleanup (Sonnet; low risk)

**Worktrees**
- Every registered worktree is on a branch that is fully merged (0 commits ahead of master):
  - `C:/pd9` on `feature/amendment-added-rows`
  - `agent-a0277e88…` on `feature/amendment-key-check`
  - `agent-a5f9b20e…` on `ui/pipeline-and-bids`
  - `agent-aeb0286f…` on `ui/shell-and-common`
  - `agent-af15c8ae…` on `ui/shell-v0-update`
- `git status` in each shows only ignored build output (`.turbo/`, `dist/`).
- Steps:
  1. `git -c core.longpaths=true worktree remove <path>` for each (Windows path length breaks a plain remove).
  2. `git worktree prune`.
  3. `git branch -d` the merged branches, plus the `worktree-agent-*` branches.
- Flag: `.claude/worktrees/agent-aac1658a9c1dc4190` is not a registered worktree. It is a plain copy of the repo (`.git`-less files and `node_modules`). Confirm with the user before deleting it.

**dev-db.local.ts**
- Recommendation: keep it and make it a tracked dev script. The local stack needs it, and it mirrors production well: it migrates as a non-superuser owner and gives `pd_app` a password.
- Move it to a tracked script, e.g. `scripts/dev-db.ts`, run with `pnpm dev:db`.
- Changes:
  - Read the port and dev passwords from env, falling back to the current dev values.
  - Default the data root to a gitignored `.dev/pg`.
  - Write `dev-db.json` into the same folder.
  - Add `.dev/` to `.gitignore`.
- Then delete `apps/api/dev-db.local.ts`.
- Optional: share the embedded-postgres setup with `apps/api/test/global-setup.ts`.

## PR2: API follow-ups (Sonnet builder; Opus reviews tenant checks). No migration.

**a. Make `GET /api/about/processing` public**
- Location: `apps/api/src/org.ts:128`. Remove `{ preHandler: requireAuth }`.
- The handler reads only env vars and a static list (`provider`, `model`, `subprocessors`, `privacyPath`). It never touches the DB or `request.auth`, so it cannot leak org data.
- Bug to fix in the same change: the page can name the wrong model.
  - The page uses `AI_MODEL || 'the configured model'`.
  - The worker's `providerForJob()` (`apps/worker/src/ai-jobs.ts`) uses `AI_MODEL || DEEPINFRA_MODEL || 'Qwen/Qwen2.5-72B-Instruct'`.
  - 07 requires the page to name the model in use. Move the resolution into one shared helper in `@pd/ai` (e.g. `activeModel()`) and use it in both places.
- Tests (new `apps/api/test/about.test.ts`):
  - No auth header returns 200.
  - A bogus Bearer token still returns 200.
  - The body has exactly the four keys.
  - The body contains no org fields.

**b. Link a candidate to a resume**
- In `insertRow`, `case 'resumes'` → `kind === 'candidate'` (`apps/api/src/tabs.ts` ~L1112), accept an optional `documentId`.
- Add a helper `documentOnBid(db, orgId, bidId, id, kind)`. It uses `findDocument` (`scope.ts`) and requires `bidId` to match, `kind === 'resume'`, and `liveStatus` not `'deleted'`. Otherwise answer 400 "Choose a resume uploaded to this bid".
- Another org's document is invisible through `orgId` and RLS, so it gets the same 400 and nothing leaks.
- Also allow `documentId` (including `null`) in `patchRow` `case 'candidates'`, recording row history with `note`.
- Web: add `documentId` to the resumes input in `apps/web/src/api/types.ts` (`TabRowInputMap`, `RowPatchMap`).

**c. Draft on reviews**
- Same pattern with `kind === 'draft'`:
  - Create: `case 'reviews'` (~L1183).
  - Patch: `patchRow` `case 'reviews'` (~L1374); `null` clears it.
- `presentReviews` already returns `draftFileName`.
- Tests for b and c (`tab-rows.test.ts`, `cross-tenant.test.ts`):
  - The correct document kind succeeds.
  - Wrong kind, a document from another bid, a deleted document, another org's document id, and a non-UUID each return 400.
  - Patch writes history.

**d. Worker jobs for resume matching and review findings**
- Neither exists. `apps/worker/src/index.ts` registers only these queues: scan, file, marking, classify, ai:compliance, ai:dates, ai:overview, ai:amendment.
- `processClassify` returns early for `resume` and `draft`, with a comment saying those AI steps are not built.
- Also missing from 04 s4: personnel-requirements extraction, resume facts, match, and review scoring.
- `skills/` holds only `compliance-matrix` and `bid-summary`.
- Scope these out until the skills exist (`personnel-requirements`, `resume-match`, `review-scoring`).
- Design notes for later:
  - Queue `ai:resume-match` when a candidate is linked to a resume. Queue `ai:review-findings` when a draft is linked to a review.
  - Both run on paid plans only.
  - Resume matching never sends a resume together with another organization's data.
  - Every result must pass the quote check.

## PR3: Credit gaps (Opus for all three; money, concurrency, auth). No migration.

The reserve and settle code lives in these places:
- `apps/api/src/credits.ts`: `reserveForBid`, `releaseBidCredit`, `releaseSessionCredit`, plus the lock order documented at the top of the file.
- `apps/worker/src/ai-jobs.ts`: `settleCreditIn` (consume or release through a conditional update on `credit_status='reserved'`) and `processCompliance`.
- `apps/api/src/jobs.ts`: the retry route.
- `apps/api/src/uploads.ts`: upload start and complete.

**a. Attachments uploaded while the bid's credit is released are never processed**
- Upload start (`uploads.ts:156`) accepts an attachment when the bid has a live solicitation, even if its credit is released.
- `processClassify` then returns silently when `bidHoldsCredit` is false.
- A second silent drop: `processCompliance` returns `false` without writing rows when an attachment's bid credit is neither reserved nor consumed.
- In both cases the attachment never runs and nothing shows the user.
- Fix:
  1. In `processClassify`, for an attachment, take locks in this order: `shareOrg`, then the document `FOR UPDATE`, then the bid `FOR UPDATE`. Re-read `creditStatus`.
     - If it holds a credit, continue.
     - If not, insert a failed `classify` job row with a constant error, e.g. `ATTACHMENT_WAITS`: "Waiting for the solicitation to be processed."
     - Use the same marker in the attachment branch of `processCompliance`.
  2. Add `kickHeldAttachments(orgId, bidId)` in `apps/worker/src/kick.ts`. Call it after COMMIT wherever `processCompliance` consumes, next to `kickAmendments`.
     - It finds live attachment documents whose latest job is a failed classify row with that error.
     - For each, it inserts a pending classify job and enqueues it.
- Taking the bid lock while writing the marker serializes it against the consume transaction. Either the kick sees the marker, or classify sees `consumed` and proceeds.
- The manual retry route still works: an attachment retry does not reserve a credit, and classify re-checks.

**b. A retry that fails before the compliance step leaves its credit reserved**
- The same leak applies to the first upload: 06 s4 says "If processing fails, the reservation is released", but only `processCompliance` releases.
- Failures in scan, file, marking reject, or classify also write no failed job row, except scan through `markJobFailed`. So the user cannot even retry.
- Fix:
  1. Wrap `start()` in `apps/worker/src/index.ts` for the scan, file, marking, and classify queues. On a throw:
     - Record a failed job row: type `scan` for scan, file, and marking failures (the retry restarts from the file); `classify` for a classify failure.
     - If `payload.kind === 'solicitation'`, release through `settleCredit(…, 'release')`. Export it from `ai-jobs.ts`.
  2. Guard against sibling releases. A second solicitation file on the same bid could fail and release the first file's reservation, after which the first file's matrix would be written for free.
     - In `processCompliance`, under the bid lock: if `settlesCredit` and `creditStatus` is not `reserved` or `consumed`, write no rows and record a failed classify job ("RFP credit released; retry").
     - Today the solicitation path writes rows whatever the credit status.
- Open decision: should a marking `block` (waiting for the user to confirm) hold the credit indefinitely? Recommendation: yes, since the user acts soon. Alternative: release on block and reserve again in `confirm-marking` (`documents.ts:183`).

**c. Seats are not enforced after a downgrade to Free** (09 s5.19 confirms this)
- Add `seatHolders(db, orgId)` in `packages/core`. It reads the org's plan and its memberships: owners always, then members ordered by `created_at`, `id`, up to `PLAN_LIMITS[plan].maxUsers`.
- In `requireAuth` (`apps/api/src/context.ts`), for `role === 'member'`, call it inside `withOrg(orgId)`. A member outside the set gets 403 `{ code: 'seat_locked' }`.
- `GET /api/org/members` returns `seatLocked` for each member.
- Invite creation (`org.ts` ~L194) should count pending, unexpired invites toward the limit.
- Gap closed (16 Oct 2026): `POST /api/invites/accept` exists and checks seats under the organization lock (`apps/api/src/invites.ts`).
- Tests:
  - New `seats.test.ts`: three members on Starter, then the move to free → the third member is refused on `/api/bids` while the owner and the earliest member get in. Removing a member or upgrading restores access. An owner who joined later is never locked out.
  - `worker-credits.test.ts`:
    - A scan, file, or classify failure on a solicitation releases its credit and leaves a retryable failed job.
    - A failed retry releases.
    - A sibling release blocks the matrix.
    - An attachment held while the credit is released runs after a retry consumes.
    - A race test (as in `races.ts`) between the held marker and consume.

## PR4: Schedule port (Sonnet builder; Opus for the migration)

**What exists today**
- Legacy screen: the `Schedule` function in `apps/web/src/screens/Workspace.tsx:386–468`, with helpers `monthDays`/`holidayName` (~L974) and `downloadXlsx`/`downloadCsv`/`downloadIcs` in `apps/web/src/export.ts`.
- Its date-change prompt is at Workspace.tsx ~L886–920.
- API pieces: `GET /tabs/schedule`, `POST /tabs/schedule/seed` (standard and color-reviews templates), `POST /schedule/adjust` (shift, scale, keep), and patching `schedule_activities` (silently ignores date moves on locked rows).
- DB columns: label, phase, start_date, end_date, time, owner, artifact, note, status, locked, plus the source columns.
- Prototype (`origin/v0/schedule-prototype:design/v0/schedule/`, visual reference only): `ActivityKind`, `ReviewColor`, workday- and holiday-aware rules in `scheduleRules.ts`, and a `DateChange` model.
- Date-change prompt contract (09 s5.11): `DateChangePromptProps { open, previousDue, nextDue, onChoose(mode), onCancel }`.

**Migration 0010**
- Add `schedule_activities.kind` and `review_color`, with CHECKs from the prototype lists.
- Backfill `kind` from `phase` and template labels.
- Lift and restore FORCE RLS, and set `lock_timeout`, as 0009 does.
- Extend `migration-journal.test.ts` and add a `migration-schedule-kind.test.ts`.

**Steps**
1. Types in `apps/web/src/types/schedule.ts`.
2. Extend `insertRow` and `patchRow` in `tabs.ts` for `kind`, `reviewColor`, `owner`, and the end date. Return 409 for a date move on a locked row instead of a silent 200.
3. Port the pure functions (shift, scale, workdays, holidays, templates) into `apps/web/src/schedule/rules.ts`, with unit tests.
4. Write shadcn components under `apps/web/src/schedule/`: calendar, milestone list, activity panel, `DateChangePrompt`. Render outside `.app-shell`.
5. A container with all tab states (no solicitation, processing, failed, empty, locked, out of credits) and source links.
6. Exports: XLSX, ICS, CSV, print.
7. Route the shell's Schedule tab to the port and delete the legacy Schedule code.

**Open decisions**
- Should shift and scale skip holidays and weekends? If so, move the math to the server's adjust route or send explicit dates.
- Should template activities get their own origin (`'template'`) or a flag?

## PR5: Amendment steps 7 and 8 (Opus for supersede, locks, and the migration)

**What steps 1–6 built**
- 0008: `documents.key_status`/`key_found`, `amendments.matched_key`, the `held` status, unique `amendments_document_uq`.
- 0009: numbering (`documents.amendment_no` with source and found number, `documents_bid_amendment_no_uq`), statuses `needs_number`/`failed`, quotes on `amendment_links`, the 0.80 confidence threshold, `changed_by_amendment` backfill.
- Worker: `key-check.ts`, `amendment-job.ts` (gate, diff, `planAmendmentApply`, one apply transaction), and `kick.ts` for number order.
- `bid_facts` and `schedule_activities` already carry the supersede columns (`amendment_no`, `supersede_status`, `superseded_by_row_id`, `changed_by_amendment`). `amendments.dates_changed` (jsonb) exists but is unused.

**Migration 0011**
- `bid_facts.fact_key` (agency, solicitation_number, naics, set_aside, contract_type, pop, place, submission_method, contracting_officer, other).
- `schedule_activities.date_key` (proposal_due, questions_due, site_visit, orals, other).
- `amendments.tabs_status` (`pending` | `applied` | `failed`).
- Indexes on (`bid_id`, `fact_key`) and (`bid_id`, `date_key`).
- Backfill `fact_key` from the normalized `field`.

**Supersede design**
- A new queue `ai:amendment-tabs`, enqueued after compliance apply (status `applied` or `needs_confirmation`).
- It is exactly-once through `tabs_status`, under the lock order shareOrg → document → bid → amendment → rows by id, and it requires the bid's credit to be consumed.
- For each extracted row with key K that is not `other`:
  - Active rows on K with a lower `amendment_no` become `superseded` (pointing to the new row), with `changed_by_amendment` = N and an `amendment_links` row whose `row_table` is the tab's table.
  - If an active row on K has a higher number (out of order), the new row is inserted already superseded by it. This makes the result independent of the order the jobs finish in.
  - Rows keyed `other` are only ever added.
- Dates: quote-checked hits on the amendment's pages are classified to a `date_key` in code and inserted as locked activities.
  - When `proposal_due` changes, write `dates_changed = { previousDue, nextDue, sourcePage, sourceQuote, resolvedAt: null }`.
  - The schedule tab returns `pendingDateChange`.
  - `/schedule/adjust` accepts an `amendmentId`: it moves the schedule from the bid's due date in force to the amendment's nextDue, sets `bids.due_date` to nextDue (the prompt applies the date; the worker never does), and sets `resolvedAt` on that change and on every lower amendment's open change. The prompt sends the amendmentId instead of setting the due date first: once the due date already is nextDue the answer is refused (409 `date_change_resolved`).
  - Bid settings setting the due date to an open change's nextDue resolves it and the lower ones; a later amendment that puts a due date in force (active or proposed) resolves the lower open changes as superseded. A deleted amendment's change is neither offered nor answered.
  - PATCH of an amendment's number renumbers the fact and date rows it wrote and the rows they replaced, and keeps the supersede choices step 8 made (a number moved past another amendment's does not re-decide which row is in force).
- Facts: rerun bid-summary on the amendment pages with the quote check. Today `processOverview` stores `quoteVerified: false` and duplicates rows on a rerun.
- Generalize `amendments.ts` link confirm, reject, and list (they handle `compliance_rows` only, ~L35/55/124).

**Open product decisions**
1. When the earlier row was confirmed or edited by a user, should the replacement be proposed (recommended) or applied automatically?
2. Should the worker update `bids.due_date` itself, or only after the user answers the prompt?
3. Do open tab proposals keep the amendment in `needs_confirmation`?
4. The paid tabs (outline, production, orals) have no base AI tasks or skills yet, so step 8 covers bid facts only for now.

**Tests**
- `amendment-tabs.test.ts`: supersede, out-of-order numbers, idempotent rerun, cross-tenant, prompt resolution.
- A migration test for 0011.

## Critical files
- apps/worker/src/ai-jobs.ts
- apps/worker/src/index.ts
- apps/api/src/tabs.ts
- apps/api/src/context.ts
- apps/worker/src/amendment-job.ts

## Decisions (owner, 16 Oct 2026)

- PR3: a file paused at the marking check keeps its credit reserved until the user confirms or removes it.
- PR4: shift and scale count workdays (weekends and US federal holidays skipped) by default, with a per-bid "Workdays only" switch on the Schedule tab for short timelines. The date math lives in one shared function used by the server's adjust route and the web preview.
- PR4: template activities get their own origin, `'template'`.
- PR5: when the earlier row was confirmed or edited by a user, the amendment's replacement is proposed, with a button to insert it. Untouched AI rows are superseded automatically.
- PR5: the worker never changes the bid's due date. It records the change, and the date-change prompt applies it when the user answers.
- PR5: open tab proposals keep the amendment in `needs_confirmation`.
- PR5 step 8 covers bid facts and dates only, until the paid tabs have AI skills.

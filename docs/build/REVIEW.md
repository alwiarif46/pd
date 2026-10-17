# Build plan review

**Date:** 17 Oct 2026. **Reviewer:** Fable. **Verdict:** fixed in place; ready for chat 1 once the owner steps in BUILD-PLAN s8 (before chat 1) are done.

## What was checked

1. Phase coverage 0 to 10 against 08. Every phase maps to exactly one chat. Done-when lists now match 08 word for word; additions are marked Proposed.
2. Section references. Every `NN sX.Y` and `NN Phase N` in the build files resolves to a heading in `plan/docs`. Vague references ("05 (sign-in and tabs)") were replaced with section numbers.
3. Loop execution: resume, progress file shape, worktrees, merge rules, missing owner steps, CI-only checks.
4. Cloud-session realism: persisted plugins, hooks, MCP, Docker absence, network allowlist, secrets.
5. Model routing and the Fable list.
6. Gaps that would make a chat fail.
7. Writing: no em dashes, sentences 30 words or fewer, active voice. A script (`scratchpad/build_check.py`) checks dashes, references, and sentence length; it reports clean.
8. Owner change: the UI design zip as the binding UI source.

## Findings fixed

- Chat 9 had no done-when section. Added Phase 9 and Phase 10 checks; Phase 10 checks are marked as waiting on owner steps.
- Chat 8 dropped two 08 checks: "each count changes correctly at every step" (Phase 7) and the Phase 8 pass line. Restored.
- Chat 3 dropped "the run reaches Gate 0b and holds". Restored. The amendment gate, shred, and matrix as orchestrated stages were missing from the PR list. Added to PR 3.
- Invented checks (chat 1 plugin load, chat 2 Playwright states, chat 3 cross-tenant repository test, chat 4 render cleanup) are now marked Proposed.
- `/plugin` and rtk commands were stated as fact. Now hedged with a verify-in-session rule, fallbacks, and a rule to record what worked in CLAUDE.md. The rtk install URL branch and repo name must be verified in session.
- rtk's `init` writes user settings that do not persist in the cloud. The repo SessionStart hook now re-runs it.
- Playwright browsers may not download in the cloud. Added the hook install step and a "CI-verified" fallback.
- Docker fallback had no answer for a binary that cannot run. Added test doubles (mock OIDC, in-memory S3, no-op scanner) with a Stubs list.
- No rule for checks that can run nowhere. Added "unverified: <reason>", never "passed".
- Merge could fail on permissions. Added the stacked-branch rule and an owner step in the handoff.
- `fable` as a frontmatter model alias is not confirmed. Added a fallback to the full model id and a record in CLAUDE.md.
- Fable list: added SAML, seats, service tokens, event consumers, data backfills, cost cap values, usage metering, file upload paths, restore drills. Chat PRs now tag more items for Fable. These are the sandbox (chat 2 PR 6), schema roles (chat 1 PR 9), font fee (chat 4), usage roll-ups (chat 8), and the cost cap (chat 9).
- Gaps added: contract versioning rule, seed tenants, a public sample RFP in `evals/fixtures/`, flaky test policy, PR loop stop rule. Also a context budget, a chat may span sessions, the progress file shape, and the stub rule.
- Chats 5 to 8 now open with a contracts PR, matching the contracts-first rule.
- Handoff template gains Status, Stubs, Design gaps, and a resume line in the next-chat prompt.
- `questions.md` pre-seeded with one heading per chat.

## Owner change applied: UI design zip

BUILD-PLAN s10 added. Chat 1 PR 2 unpacks the zip into `design/e2e/`, writes README and INVENTORY, and excludes the folder from build, lint, type-check and tests. Chats 2 to 8 reference the design for every screen, log gaps, and attach fidelity screenshots. Owner step added to s8. START-CHAT-1 checks for the zip.

## Changes per file

| File | Change |
|---|---|
| BUILD-PLAN.md | v2. s1 chat-is-a-plan rule. s2 progress file shape, PR loop stop, flaky tests, context budget. s3 hedged commands, persistence rules, Docker doubles, CI-only checks. s4 model alias fallback, fuller Fable list. s5 contract versions, test data, design rule. s6 worktree and merge fallbacks. s8 stub rule and design zip step. s10 UI design source. Decision log |
| chat-1.md | Design source PR, testing package PR, schema-roles Fable tag, done-when matched to 08 with Proposed marks, design questions |
| chat-2.md | Precise read list, design rule on PR 8, sandbox Fable tag, "unverified" fallback for SSO and Zitadel |
| chat-3.md | Restored Gate 0b check, orchestrated stages in PR 3, design rule on screens, stub note |
| chat-4.md | Precise read list, LibreOffice CI-only note, vision through the gateway stub, fee record Fable tag, Proposed mark |
| chat-5.md | Contracts PR, "two test RFPs" defined, stub note |
| chat-6.md | Contracts PR, reviewer-differs check, lock trigger reference, page-limit note moved here, default reviewer model until answered |
| chat-7.md | Contracts PR, screens referenced to 05, portal check cannot complete in session, test doubles for mailbox and eBuy |
| chat-8.md | Contracts PR, billing screens PR, restored Phase 7 and Phase 8 checks, Stripe mock note |
| chat-9.md | Done-when for Phases 9 and 10, launch checklist PR, test set outside git, Fable tag on cost cap |
| HANDOFF-TEMPLATE.md | Status, Stubs, Design gaps, resume line |
| START-CHAT-1.md | Resume line, design zip check, verify commands |
| questions.md | Headings per chat; design gaps go here |

## Owner decisions needed

1. Confirm the public sample RFP may be committed to `evals/fixtures/` (a federal solicitation from SAM.gov is public; name one, or let chat 1 pick).
2. Put the UI design zip in the repo root before chat 1, or chat 1 raises it at the end and chat 2 cannot start UI work.
3. Confirm the session's GitHub token may merge to `master`; otherwise, every merge becomes an owner step.

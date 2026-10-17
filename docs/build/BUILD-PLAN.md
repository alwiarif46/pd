# E2E Proposal: Build Plan

**Status:** v2 · 17 Oct 2026 (reviewed; design source added)
**Repo:** `alwiarif46/pd` (renamed to E2E Proposal during chat 1; GitHub redirects the old URL)
**Where Claude Code runs:** a cloud session with the repo attached.
**Product plans:** `docs/plans/00` to `09`. This file says how to build them. The plans say what to build.
**UI design:** Atrium in `design/e2e/` (s10). It sets the look; Claude Code may enhance it.

## 1. Shape of the build

Nine chats. One chat builds one plan from start to finish. A chat is a plan, not a session. If a session dies, the next session continues the same chat from its progress file (s2, resume rule).

| Chat | Plan file | Builds | Plan phase (08) |
|---|---|---|---|
| 1 | `docs/build/chat-1.md` | Tooling setup, design source, repo restructure, contracts, local stack, PD PRs #35 to #38 | 0 |
| 2 | `docs/build/chat-2.md` | Identity on Zitadel, gateway, ingest and solicitation intel from PD, PD tabs as features | 1 |
| 3 | `docs/build/chat-3.md` | Orchestrator, stage interface, model gateway, evidence and repository, credit ledger, intake | 2 |
| 4 | `docs/build/chat-4.md` | Render service, fonts, format lock, Word and PDF, numbering, visual check | 3 |
| 5 | `docs/build/chat-5.md` | Drafting stages, prose checks, citations, graphics, exec summary, pricing narrative | 4 |
| 6 | `docs/build/chat-6.md` | Red, Gold, White Glove reviews, Gates 1 and 2, locks, package | 5 |
| 7 | `docs/build/chat-7.md` | Amendment re-entry, comms, Q&A, request and collect, Drive, eBuy, portal agent, notifications | 6 |
| 8 | `docs/build/chat-8.md` | Plans and Stripe, free proposal, SAML, then hardening, security, legal | 7 and 8 |
| 9 | `docs/build/chat-9.md` | 10-RFP test harness, test runs, fixes, launch readiness | 9 and 10 |

Every "done when" check in a chat file comes from 08. A check the chat file adds on its own is marked Proposed.

## 2. The chat loop

Every chat follows the same loop. No exceptions.

1. **Start.** Read this file, the chat's own plan file, the last handoff (`docs/build/handoffs/`), and `docs/build/progress/chat-N.md` if it exists. Run the setup check (s3). Then read `design/e2e/INVENTORY.md` if the chat has UI work.
2. **Plan.** Write the chat's PR list into `docs/build/progress/chat-N.md` before any code. Use the superpowers planning skill. The chat file's PR list is a proposal; refine it, but keep every "done when" check.
3. **Build.** Work the PR list in order. Each PR follows s5 and s6.
4. **No questions mid-chat.** When a decision comes up, pick the safest choice that can be undone. Write it to `docs/build/questions.md` under the chat's heading, with the options and why you chose one. Keep going.
5. **Finish the plan.** Every "done when" check in the chat file passes, with evidence (test names, logs, screenshots). A check that cannot run in the session or in CI is marked "unverified" with the reason, never "passed".
6. **Final review.** A Fable reviewer that has not seen the work checks the whole chat against its plan file (s6.3). Fix every finding. Re-run the checks.
7. **Ask.** Only now, ask the owner every logged question in one batch with AskUserQuestion. Up to four questions per call; repeat until the list is empty.
8. **Apply.** Build what the answers change. Re-run tests. Merge.
9. **Handoff.** Write `docs/build/handoffs/chat-N.md` from the template. End with the ready-to-paste prompt for chat N+1. Merge it to `master`.

**Resume rule.** If a session dies or compacts, read `docs/build/progress/chat-N.md` first. It always shows the current PR, its branch, the last command that ran, and the next step. Update it after every PR, and before any long command. Never start a chat number twice; an unfinished chat continues under its own number.

**Progress file shape.** One heading per PR with: branch, worktree path, status (planned, building, in review, merged, blocked), the review verdict, and the next step. A "Decisions" list that mirrors `questions.md`. A "Stubs" list (s8). A "Session log" with one line per session start.

**Stopping a PR loop.** A PR gets at most three review rounds and three CI fix rounds. After that, stop the PR, write what is blocked in `questions.md` and the progress file, and move to the next PR that does not depend on it. If every remaining PR depends on it, end the chat early: run the final review on what merged, ask the owner, and write a handoff marked partial. The next session continues the same chat.

**Flaky tests.** A test that fails and then passes on rerun with no code change is flaky. Tag it `@flaky` with a one-line reason, keep it running, and log it in the progress file. Fix it inside the chat if the cause is in this chat's code; otherwise, list it in the handoff. Never rerun CI more than twice to turn a check green.

**Context budget.** Compact after each merged PR. Keep a PR under one service and under about 15 files when you can. Read plan files by section. Send long reads and searches to subagents and keep their conclusions only. When a session has compacted three times inside one PR, update the progress file and split the PR.

## 3. Setup (chat 1 installs; later chats only check)

Commit the setup to the repo so every cloud session gets it. Install and confirm each item. The commands below are the best known forms; the cloud session may not run them as written. Verify each one in the session. If one is missing, its name changed, or the command form differs, search for the current form, use it, record what worked in CLAUDE.md, and log it in `questions.md`.

| Item | What for | How (verify in session) |
|---|---|---|
| superpowers | Written plans, test-first work, systematic debugging, verification before done | Try `/plugin install superpowers@claude-plugins-official`. If that marketplace or name does not resolve, run `/plugin marketplace add obra/superpowers-marketplace` and install `superpowers` from it. Confirm with `/plugin list` |
| frontend-design | Layout and component work only where the design has a gap (s10) | `/plugin marketplace add anthropics/claude-code`, then `/plugin install frontend-design@claude-code-plugins` |
| code-review, pr-review-toolkit | PR review passes | same marketplace: `code-review@claude-code-plugins`, `pr-review-toolkit@claude-code-plugins` |
| security-guidance | Security checks while editing | `security-guidance@claude-code-plugins` |
| rtk (Rust Token Killer) | Cuts command output tokens | Check `rtk --version` first. If absent, try `curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/main/install.sh \| sh`, then `cargo install --git https://github.com/rtk-ai/rtk` if cargo exists. Verify the repo name before trusting the URL. A different crate named `rtk` exists; if `rtk gain` fails after install, remove it and reinstall from rtk-ai. Then `rtk init` and check with `rtk gain`. If the network blocks the install, skip rtk and log it |
| Library docs (Context7 MCP) | Current API docs for Fastify, Drizzle, BullMQ, Zitadel, python-docx, Playwright | Add it to `.mcp.json` as a project server. The session may ask to approve project MCP servers; approve. If the cloud network blocks it, log and continue |
| Playwright | Real-browser checks of every screen and the design fidelity screenshots (s10) | `@playwright/test` in the repo. Run `pnpm exec playwright install --with-deps chromium` once per session from the SessionStart hook. If the browser download is blocked, run Playwright in CI only and mark screen checks "CI-verified" |
| Language servers | Type-aware edits | TypeScript and Pyright LSP plugins if the marketplace lists them; otherwise skip |

Slash commands such as `/plugin` are interactive. If the session cannot run them, try `claude plugin install <name>` from the shell, and if that fails too, write the marketplace and plugin into `.claude/settings.json` by hand and restart the session.

Make it stick in the cloud. A cloud session starts fresh each time, so nothing outside the repo survives:
- `.claude/settings.json` lists the marketplaces (`extraKnownMarketplaces`) and enabled plugins (`enabledPlugins`), so a new session loads them. Verify these key names against the current Claude Code settings docs; if they differ, use the documented names.
- `.claude/settings.json` also carries the hooks. A `SessionStart` hook runs `.claude/hooks/session-start.sh`. The script installs rtk and the Playwright browser if missing and prints a one-line tool check. It must finish in under a minute and never fail the session.
- rtk's own `rtk init` writes to the user settings, which do not persist. The repo hook re-runs it each session.
- `.mcp.json` at the repo root holds the MCP servers. Secrets are not in it; it reads them from the environment.
- `.claude/agents/` holds the role agents in s4.
- A network allowlist may block some hosts. Record every blocked host in `questions.md` and continue without that tool.
- Secrets come only from the session environment. Never write a key into a file, a hook, or a test fixture.

**Docker.** Run `docker info` first. If Docker works, the local stack runs in Compose (09 s9.1). If not, run the stack from native binaries (embedded Postgres as PD's `dev-db.ts` does, `redis-server`, the Zitadel binary, the MinIO binary). If a binary cannot run in the session, replace it with a test double for local runs. Use a mock OIDC issuer for Zitadel, an in-memory S3 for MinIO, and a no-op scanner for ClamAV. Record the double in the progress file's Stubs list. CI on GitHub Actions always runs the Compose stack, so the real check happens there.

**What CI runs that the session cannot.** The Compose stack job, ClamAV, LibreOffice, the sandbox image, and Playwright may run only in CI. For such checks, push the branch, wait for CI, and read the failing lines with `gh run view --log-failed`. Never claim a check passed that ran nowhere.

## 4. Roles and models

Write these as subagents in `.claude/agents/`, each with its model in the frontmatter. Model aliases `opus` and `sonnet` are documented. The `fable` alias is not confirmed; try it, and if the agent fails to load, use the full model id `claude-fable-5-1`. Record which form worked in CLAUDE.md.

| Role | Model | Does |
|---|---|---|
| architect | opus | Plans each PR: files, contracts, tests, risks |
| builder | sonnet | Writes code and tests to the architect's plan |
| debugger | opus | Any failure; plus auth, money, migrations, tenant isolation, concurrency |
| reviewer | opus | Reviews every PR not listed for Fable; checks design fidelity on UI PRs (s10) |
| fable-reviewer | fable | Reviews the sensitive PRs below, and the final review of every chat |

**Fable reviews these, always:**
- infra, deploy, backups, Docker, Compose, CI, hooks, hosting adapters, restore drills;
- identity, Zitadel, sessions, SSO, SAML, MFA, roles, invites, seats, service tokens;
- tenant isolation: RLS, schema roles, `withTenant`, cross-tenant tests, event consumers that carry `tenant_id`;
- migrations and data backfills;
- money: credits, ledger, plans, Stripe, recharge, font fee, free proposal, cost cap values, usage metering;
- security: secrets, the sandbox, render job cleanup, the portal agent, mailbox tokens, inbound mail, file upload paths;
- the final review of each chat.

A Fable finding marked major blocks the merge until fixed and re-reviewed. Every PR names its reviewer in its description.

## 5. Engineering rules

- **Contracts first.** Change `packages/contracts` (OpenAPI and event schemas) in its own commit before any service uses the change.
- **Contract versions.** Each OpenAPI file carries `info.version`; each event schema carries `schema_version`. A breaking change bumps the major number. A consumer accepts the current and the previous major for the rest of the chat, then the old one is removed in a follow-up PR. `pnpm contracts:check` fails on drift (09 s9.4).
- **One service per PR,** plus contracts. A PR that must touch two services says why.
- **Test first.** Write the failing test, then the code. Every new endpoint gets a contract test and a cross-tenant test (user A gets 404 on user B's ids).
- **Test data.** `packages/testing` ships two tenant fixtures (A and B) and `pnpm seed`, which creates both tenants with one admin user each and one sample bid. The sample solicitation is a public, non-sensitive RFP in `evals/fixtures/`, never a client document. Chats 1 to 8 use it. The 10-RFP set arrives in chat 9 and stays outside git.
- **Tenant safety.** Every query runs inside `withTenant`. No service reads another service's schema. Events carry `tenant_id`.
- **Frontend.** Every screen uses Atrium's shell, tokens, and components (s10). New screens and enhancements use `frontend-design` in Atrium's style and get logged in `design/e2e/ENHANCEMENTS.md`. Every screen gets a Playwright test for its states (05 s8) and light and dark screenshots. Check each screen in a real browser before the PR; if the session has no browser, CI does it.
- **Sources.** Every AI-extracted row carries `sourcePage` and `sourceQuote`. Every claim in a draft carries a citation or a NEED.
- **Before every push:** `pnpm -r typecheck`, `pnpm -r lint`, all tests for touched packages, and `uv run pytest` for touched Python. All must pass.
- **Hard limits.** No live calls to providers, DNS, Stripe live mode, Zitadel cloud, or mail sends outside test inboxes. No secrets in git. No destructive disk or volume commands. Test keys live in the session's environment, never in files.
- **Writing in code comments and docs:** plain words, no em dashes.

## 6. Git and merge

1. One branch per PR: `e2e/c<chat>-<nn>-<slug>`. Use a git worktree per branch (`git worktree add ../<branch>` or the session's worktree tool). If worktrees are unavailable, use one checkout and never leave uncommitted work when switching branches.
2. Open the PR with `gh pr create`: a summary, the plan section it builds, the tests it adds, and the reviewer role.
3. Review: reviewer or fable-reviewer by s4. Fix findings. Re-review majors.
4. **Merge when CI is green and the review passed.** `gh pr merge --squash --delete-branch`, then update `progress/chat-N.md`.
5. Never merge with a red check. Never force-push `master`.
6. If the session's token cannot merge (branch protection or permissions), keep building on a stacked branch, log it, and list the merges as an owner step in the handoff.
7. Keep `master` deployable. A PR that breaks a later chat's stub is reverted, not patched forward.

### 6.3 Final chat review (Fable)

The fable-reviewer gets: the chat plan file, the relevant plan sections, the merged diff of the chat, the test results, and the design fidelity screenshots for UI PRs. It checks each "done when" item, tenant isolation, contract drift, missing tests, design fidelity, and plan fidelity. It writes `docs/build/reviews/chat-N.md`. Every finding gets fixed or logged as a question.

## 7. Tokens

- `rtk` on every shell command when it is installed.
- Read plan files by section, never all ten at once.
- Code searches and long reads go to subagents; keep only conclusions.
- Compact after each merged PR. The progress file makes this safe.
- Do not paste full logs; quote the failing lines.

## 8. Owner steps (cannot be done by Claude)

Tracked in `HUMAN-TODO.md`. The chat that needs one lists it in its handoff, then works around it with a stub until it exists.

**Stub rule.** A stub is a recorded-response or test double behind the same interface as the real thing, switched by one environment variable. It lives in `packages/testing` or the service's `test/` folder, never in production code paths. Each stub is listed in the progress file under Stubs with the owner step it waits on. The "done when" check that depends on it is marked "unverified: waits on <owner step>". When the owner step lands, the chat that is running at that time removes the stub and runs the real check.

| When | Step |
|---|---|
| Before chat 1 | Attach `alwiarif46/pd` to the cloud session. Plans and this build plan must be in the repo (s9) |
| Before chat 1 | Atrium design at `design/e2e/atrium-design/` and the sample RFP at `evals/fixtures/sample-rfp-77344426Q0100/` (both pushed 17 Oct 2026) |
| During chat 1 | Rename the GitHub repo to E2E Proposal when chat 1 asks (it works on the old name until then) |
| Before chat 2 | Google and Microsoft OAuth app registrations for SSO (test tenants) |
| Before chat 3 | Anthropic API key in the cloud session environment |
| Before chat 5 | Image provider key in the environment |
| Before chat 7 | Test Gmail and Microsoft 365 mailboxes; one test eBuy tenant |
| Before chat 8 | Stripe test-mode keys |
| Before chat 9 | The 10-RFP test set with permission to send it under standard terms |
| Chat 9 | Writer reviews of the 10 packages; provider zero-retention terms; hosting choice |

## 9. Getting the plans into the repo

The cloud session sees only the repo. `docs/plans/` (00 to 09) and `docs/build/` must be on `master` before chat 1 starts. Copy them from `C:\Tools\E2E\docs\` into the repo, keeping PD's current `docs/plans/` under `docs/plans/archive-pd/`, and push. Chat 1 checks that both folders exist and stops with one question if they do not.

## 10. UI design source

The design is **Atrium** (`atrium-design.zip`, 17 Oct 2026), a v0 export in Next.js 16, React 19, Tailwind v4, shadcn, IBM Plex Sans and Mono, and lucide icons. It holds the app shell (`atrium-shell`), the icon rail and sidebar with the bid list (`atrium-sidebar`), the top rail (`atrium-top-rail`), one dashboard screen (`atrium-dashboard`), light and dark theme tokens (`app/globals.css`), and sample data. 05 describes behavior and states; Atrium sets the look.

1. **Location.** The owner commits the zip unpacked at `design/e2e/atrium-design/` before chat 1. The folder is read-only reference. Build, lint, type-check, and tests exclude it, the same way PD's `design/v0` rule works. `design/e2e/README.md` records the zip name, date, and commit.
2. **Follow it.** The shell, rail, sidebar, top rail, dashboard, tokens, type, spacing, and dark mode come from Atrium. Integrate them the way PD's v0 rule does: strip Next.js and `"use client"`, strip fetch code, map types to E2E contracts, keep the markup and class names. Atrium's theme tokens replace PD's `tokens.css`, and the app supports Atrium's dark mode.
3. **Freedom to enhance.** Atrium has one screen, so most screens are new. Build them in Atrium's visual language with `frontend-design`. Claude Code may also improve Atrium itself: better states, accessibility, responsive layout, density, motion, empty states. Every enhancement stays consistent with Atrium's tokens and components, and gets one line in `design/e2e/ENHANCEMENTS.md` (screen, change, why).
4. **Proof.** Each UI PR includes Playwright screenshots of each screen and state, light and dark. For the shell and dashboard, place them next to the Atrium render. The reviewer checks visual consistency and names any drift.
5. **Inventory.** Chat 1 writes `design/e2e/INVENTORY.md`: Atrium's components and tokens, and every 05 screen mapped to an Atrium part or marked "new in Atrium style", with the chat that builds it. Gaps are not questions; they are build work.
6. **Missing folder.** If `design/e2e/atrium-design/` is absent when chat 1 starts, unpack `atrium-design.zip` from the repo root if present; otherwise log it and continue.

## Decision log

| Date | Decision |
|---|---|
| 17 Oct 2026 | Nine chats, one plan each; questions only at the end of a chat |
| 17 Oct 2026 | Claude merges a PR once CI is green and the review passed |
| 17 Oct 2026 | Cloud session with the repo attached |
| 17 Oct 2026 | Fable reviews infra, identity, tenancy, migrations, money, security, and each chat's final review |
| 17 Oct 2026 | Owner: the UI design zip in `design/e2e/` is the binding UI source; frontend-design fills gaps only |
| 17 Oct 2026 | Review: stub rule, PR loop limit, flaky test policy, contract versions, seed tenants, and CI-only checks added |
| 17 Oct 2026 | Owner: Atrium (`atrium-design.zip`) is the UI design; follow its shell, tokens, and dashboard; Claude Code may enhance and logs each enhancement |
| 17 Oct 2026 | Owner: sample RFP for fixtures is DFC ISSO RFQ 77344426Q0100 with amendments P0001 and P00002, in `evals/fixtures/sample-rfp-77344426Q0100/` |
| 17 Oct 2026 | Owner: skills stay out of git for now (`.gitignore` covers new folders under `skills/`). The stage interface loads skills from `PD_SKILLS_DIR`; tests and CI use small stub skills under `packages/testing/skills/`. The owner supplies real skills to the runtime |

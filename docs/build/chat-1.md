# Chat 1: Setup, design source, restructure, contracts, local stack

**Builds:** plan phase 0 (08 s1, Phase 0). **Read:** BUILD-PLAN.md (all, s3 and s10 first), 09 s1 to s9, 01 s3 and s4, 08 Phase 0, 05 s3 and s4 (for the design inventory).

## Goal
PD's code runs in the E2E layout, the tooling is installed for every later chat, the UI design is in the repo and inventoried, and PD's open PRs are merged.

## Before code
- Check that `docs/plans/00` to `09` and `docs/build/` exist on `master`. If not, ask the one question and stop.
- Check that Atrium is in `design/e2e/atrium-design/` (BUILD-PLAN s10). If not, follow s10 item 6.
- Run the setup in BUILD-PLAN s3. Write the role agents (s4). Commit `.claude/settings.json`, the hooks and the agents in PR 1.
- Run `docker info`. Record Docker or native fallback in the progress file.

## PR list (proposed; refine in progress/chat-1.md)
1. Tooling: plugins, rtk hook, agents, `.mcp.json`, Playwright, CLAUDE.md tool section. Record every command that differed from BUILD-PLAN s3. (fable-reviewer: CI and hooks)
2. Design source: Atrium is already in `design/e2e/atrium-design/` with `design/e2e/README.md`. Exclude the folder from build, lint, type-check and tests. Write `design/e2e/INVENTORY.md` and start `design/e2e/ENHANCEMENTS.md` (BUILD-PLAN s10). Swap PD's `tokens.css` for Atrium's theme tokens and fonts.
3. Finish PD PR #37 (amendment steps 7 and 8, migration 0011). (fable-reviewer: migration)
4. Finish PD PR #35 (schedule port).
5. Finish PD PR #36 (invite accept, seat lock). (fable-reviewer: identity and seats)
6. Finish PD PR #38 (amendment backfill). (fable-reviewer: migration and data)
7. Restructure into `services/`, `packages/`, `python/` by 09 s6. Move PD plans to `docs/plans/archive-pd/`. Rewrite CLAUDE.md from 09 s8, adding the BUILD-PLAN s3 tool section and the s10 design rule. Remove any parity check. (fable-reviewer: CI and infra)
8. `packages/contracts` (OpenAPI layout, event schema layout, `info.version` and `schema_version` rules, generators, `pnpm contracts:check`) and `packages/stage-interface`.
9. Service skeletons for all 15 services (09 s3) with health checks (09 s9.1) and empty schemas, one Postgres role per service. (fable-reviewer: schema roles)
10. `packages/testing`: tenant fixtures A and B, the cross-tenant helper (09 s9.4), `pnpm seed`, and the sample RFP already in `evals/fixtures/sample-rfp-77344426Q0100/` (DFC ISSO RFQ, PWS and addenda, amendments P0001 and P00002 with the Q&A sheet) wired into the seed as tenant A's bid (BUILD-PLAN s5, test data).
11. Local stack: Compose (or native fallback) with Postgres plus pgvector, Zitadel, Redis (`appendonly yes`, `maxmemory-policy noeviction`), MinIO, ClamAV, the sandbox; `pnpm migrate` in the 09 s9.3 order; env var table from 09 s9.2. (fable-reviewer: infra)
12. CI: build, typecheck, lint, tests, secret scan, the Compose stack job, the schema-isolation test, Playwright browser install. (fable-reviewer: CI)
13. Repo rename: post one notice that the rename can happen now (an owner step, not a question), and keep working. Before the final review, confirm the old URL redirects. If the rename has not happened, log it and continue.

## Done when (08 Phase 0)
- Every service skeleton builds, boots, and answers its health check.
- PD's tests pass in the new layout; CI and the secret scan are green.
- PRs #35 to #38 are merged with tests green.
- The old PD URL redirects to the renamed repo.
- A service role that queries another service's schema gets a permission error.
- `docker compose up` (in CI; native fallback in the session) boots the whole local stack, and `pnpm migrate` applies every schema in the 09 s9.3 order.
- Proposed: a new cloud session loads the plugins and rtk without manual steps.
- Proposed: `design/e2e/` is committed with README and INVENTORY, and the build ignores it.
- Proposed: `pnpm seed` creates tenants A and B and the sample bid, and the cross-tenant helper runs against every skeleton.

## Expected end-of-chat questions
- Any tool that would not install, and what replaced it.
- Docker or native fallback in the cloud session.
- Test set source and written permission (00 s7). The test set itself is an owner step for chat 9.
- 05 screens missing from the design, and design screens missing from 05.
- Atrium, if it was missing.

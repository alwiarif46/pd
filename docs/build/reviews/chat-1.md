# Chat 1 final review

Reviewer: fable-reviewer (independent, had not seen the work). Repo at master 2848bbe, PRs #49 to #62. Date: 17 Oct 2026.
Verdict: **no major findings. Ready for the owner questions** after the documentation fixes listed below, which this PR makes.

## Done-when

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | Every service skeleton builds, boots, answers its health check | passed | Booted identity, notify and orchestrator (4101, 4114, 4105) and curled `/healthz`; orchestrator with a database that lacked its schema answered `"unavailable"` as designed. `uv sync --all-packages --frozen` then `uv run render` and `uv run portal-agent` answered. CI run 39056933350 on 2848bbe: `build-docker` green for all 14 skeleton images, `test-services` and `test-python` green. The build session also booted all 14 services before the review (the 12 TypeScript services answered at once; the two Python ones after `uv sync --all-packages`). |
| 2 | PD's tests pass in the new layout; CI and the secret scan are green | passed | All checks on 2848bbe green (typecheck, lint, build, test-web, test-api, test-infra, restore-drill, contracts, test-services, test-python, compose-stack, e2e-web, 19 build-docker). `deploy` and `push-images` skipped by design. Secret scan exit 0. The build session's own run on a fresh Postgres cluster with `CI=true`: API 452, web 603, core 148. |
| 3 | PRs #35 to #38 merged with tests green | passed, with a caveat | All four were merged on 16 Oct 2026, before chat 1 started. Caveat: #35's merge commit went red on master (a schedule fixture `dateKey`, typecheck and build) and was repaired the same day by #41. Chat 1 did no work on these four PRs. |
| 4 | Old PD URL redirects to the renamed repo | **unverified: the owner has not renamed the repo** | `gh api repos/alwiarif46/pd` still returns `name: pd`. HUMAN-TODO H-13 posted in #62. |
| 5 | A service role that queries another service's schema gets a permission error | passed | service-kit `isolation.test.ts` and `owner-rls.test.ts`: 11 tests on a fresh cluster with `CI=true`, including all 14 x 13 role pairs getting Postgres error 42501 on `outbox` and `schema_migrations`, no direct access to `app.app_settings`, no DDL, FORCE RLS held for the table owner, PUBLIC cannot connect. Also CI `test-services` step 1 and `compose-stack` step 14. |
| 6 | `docker compose up` boots the whole local stack; `pnpm migrate` applies every schema in order | passed (CI-verified) | `compose-stack` job: boot with `--wait`, bucket, pgvector, `pnpm migrate` twice (second run applies 0), schema list, isolation, ClamAV EICAR, S3 signed round trip, Zitadel ready and machine key, sandbox hardening and no network. Run on PR #61 and on master. The session had no Docker daemon; the native fallback was used locally. `MIGRATION_ORDER` matches 09 s9.3. |
| 7 | Proposed: a new cloud session loads the plugins and rtk without manual steps | **unverified** | `.claude/settings.json` lists the marketplaces and five plugins. The SessionStart hook script exists but is not registered (the classifier refused that entry; HUMAN-TODO H-12). rtk could not be installed (host blocked). |
| 8 | Proposed: `design/e2e/` committed with README and INVENTORY; the build ignores it | passed | All files present. Excluded from ESLint, both Vitest configs, root `tsconfig.json`; not a workspace member. Reviewer diffed every token value against Atrium's `globals.css`: zero differences in light and dark. |
| 9 | Proposed: `pnpm seed` creates tenants A and B and the sample bid; the cross-tenant helper runs against every skeleton | passed | `pnpm seed --migrate` on a scratch database: 18 created (2 orgs, 2 users, 2 memberships, 2 bids, 10 sample RFP documents), second run 0 created and 18 unchanged. The guard refused `prod_x` and the `postgres` maintenance database. `skeletons.test.ts` (40 tests) runs `runCrossTenant` on all 12 TypeScript skeletons and has a tripwire for the two Python ones. |

## Review areas

- **Tenant isolation.** `withTenant` sets `app.tenant_id` and `app.org_id` transaction-locally and checks the uuid. Every `outbox` has ENABLE and FORCE RLS with a tenant policy, and a drift guard fails any later table without it. Service roles are NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, with a pinned `search_path`, `public` revoked and CONNECT revoked from PUBLIC. Passwords reach the server as SCRAM verifiers. Sound for a skeleton.
- **Contract drift.** `pnpm contracts:check` is clean. The 53 event names match 09 s4 one for one. The gateway is `skeleton: false`, so its PD routes are not yet checked against `openapi/gateway.yaml`.
- **Migrations.** Fixed order, one advisory lock, one transaction per file with `set local search_path`, ledger read-only for the service role.
- **Secrets.** None in git. Tracked `.env*` files are examples; compose secrets use `${VAR:?}`; ports bind to 127.0.0.1.
- **CI and hooks.** `permissions: contents: read`, concurrency cancels only pull request runs, timeouts everywhere, deploy gated on every job plus manual dispatch. Actions are pinned to tags, not SHAs (logged follow-up).
- **Plan fidelity (09).** Layout, 15-service catalog, languages, notify stream prefix and CLAUDE.md rules match. Deviations (SeaweedFS for MinIO, ports 4101 to 4114) are logged.
- **Design fidelity.** Chat 1 built tokens only. ENHANCEMENTS.md lists every departure with a reason. "Nobody can reach dark mode yet" is true.

## Findings (no majors)

Minor, fixed in the final docs PR (#63): stale progress file (PR 1 and 13 rows, the CI map intro, the session log); owner-batch gaps in `questions.md`; `infra/compose/README.md` saying the stack had not run; wrong token path in two design docs; Atrium commit sha missing in `design/e2e/README.md`; a mid-chat "asked the owner" phrase.

Minor, logged for chat 2 (not fixed here):
- Gap 5: no job runs a built skeleton image and calls `/healthz` (`build-docker` builds only).
- The outbox relay role design (option A) is a tenant-isolation decision made without the owner: asked in the end batch.
- Production's ClamAV config has no `LocalSocket`; asked in the end batch.

Nits left: actions pinned by tag (follow-up logged), `pnpm/action-setup@v2` (follow-up logged).

## Questions for the owner

Asked in the end-of-chat batch (see `docs/build/handoffs/chat-1.md` for the answers).

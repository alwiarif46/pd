# Chat 1 progress

## Session log
- 2026-10-17 session 1: started. Prerequisites checked (below). Blocked on PR 1 (see PR 1 status).

## Prerequisite checks
- `docs/plans/00` to `09` and `docs/build/` exist on master (commit c627f6b). OK.
- Atrium is at `design/e2e/atrium-design/` with `design/e2e/README.md`. OK.
- Sample RFP is at `evals/fixtures/sample-rfp-77344426Q0100/`. OK.
- Docker: client and compose v5.6.0 are installed, but the daemon is not running (`/var/run/docker.sock` missing). Decision: native fallback in the session (embedded Postgres, `redis-server` at /usr/bin, test doubles for Zitadel, MinIO, ClamAV). CI runs Compose.
- Tools present: node 22.22, pnpm 9.0, uv, python3, redis-server, gh 2.89 (no repo access from the shell; GitHub MCP tools are used), cargo, Chromium at /opt/pw-browsers.

## Setup results (BUILD-PLAN s3)
| Item | Result |
|---|---|
| Marketplaces | `claude plugin marketplace add anthropics/claude-code` and `obra/superpowers-marketplace` worked (names `claude-code-plugins`, `superpowers-marketplace`) |
| Plugins | `claude plugin install <name>@claude-code-plugins --scope project` worked for frontend-design, code-review, pr-review-toolkit, security-guidance. `superpowers@claude-plugins-official` does not exist; `superpowers@superpowers-marketplace` installed |
| rtk | Not installed. `raw.githubusercontent.com/rtk-ai/rtk/main/install.sh` returns 404 and the session's GitHub scope blocks the rtk-ai repo (403). Skipped and logged |
| Context7 | `.mcp.json` entry planned; npm registry reachable |
| Playwright | Chromium preinstalled at /opt/pw-browsers |

## PR list
Plan PRs 3 to 6 (PD #37, #35, #36, #38) are already merged on master (merge commits 6448f39, 5d09a44, 0cbcaed, 817ce5d are ancestors of master). No work needed; logged in questions.md.

| # | Branch | Status | Next step |
|---|---|---|---|
| 1 Tooling | e2e/c1-01-tooling | building | Agents, hook script, .mcp.json, Playwright dep, CLAUDE.md done. Hook entry in settings.json denied by classifier (owner step). PR #49 open; Fable review done (no majors); minors fixed |
| 2 Design source | e2e/c1-02-design | merged (#50) | Opus review: 1 major (legacy var collision) fixed and browser-verified |
| 3 to 6 | - | already merged | none |
| 7 Restructure | e2e/c1-07-restructure | merged (#51, by owner) | Fable: no majors. Minor fixes follow in 7b |
| 7b Review fixes | e2e/c1-07b-restructure-fixes | merged (#55) | |
| 8 Contracts | e2e/c1-08-contracts | merged (#56) | opus: 2 majors fixed and re-reviewed, minors fixed |
| 9 Skeletons | e2e/c1-09-skeletons | merged (#57) | Fable: no majors; 11 minors fixed incl. a racy test guard found on a fresh cluster |
| 10 Testing | e2e/c1-10-testing | merged (#58) | Fable: 4 majors fixed over 3 rounds (positive control, CI-vacuous RLS tests, seed guard x2); follow-ups logged |
| 11 Local stack | e2e/c1-11-stack | merged (#59) | Fable: no majors; 4 minors fixed (JWKS host, clamd double O(n), native chown scope, TCP healthcheck) |
| 12 CI | e2e/c1-12-ci | built, stacked on #11, not pushed | Orchestrator pushes and iterates on CI. Never run on GitHub yet: the new jobs (contracts, test-services, test-python, compose-stack, e2e-web) and the 14 new build-docker entries are unverified until the first run. fable-reviewer: CI |
| 13 Rename notice | - | planned | |

## PR 12 CI: which Done-when check which job verifies
All of these are first verified by the first GitHub run of `.github/workflows/ci.yml`. Locally only the pieces marked "local" ran.

| Done-when / check | CI job and step | Local evidence |
|---|---|---|
| Every service skeleton builds, boots, answers its health check | `build-docker` (14 new matrix entries: images build); `test-services` ("The twelve TypeScript service skeletons") and `test-python` (healthz tests) | local: the healthz tests |
| PD's tests pass in the new layout; CI and the secret scan are green | `typecheck`, `lint` (also runs the secret scan), `build`, `test-web`, `test-api`, `test-infra` (secret scan again) | local: typecheck, lint, web tests |
| A service role that queries another service's schema gets a permission error | `test-services` step "Schema isolation: a service role cannot read another service schema" (fresh Postgres service) and `compose-stack` step "Schema isolation against the Compose cluster" | local: both test files on a native Postgres |
| `docker compose up` boots the whole local stack; `pnpm migrate` applies every schema in order | `compose-stack`: `up --wait`, `pnpm migrate` twice, schema list, pgvector, ClamAV EICAR, S3 roundtrip, Zitadel ready and machine key, sandbox hardening and no network | local: `stack-smoke.py` clamav and s3 against the test doubles; SigV4 signer checked against botocore |
| Contract drift, and a changed contract carries a version bump (deferred from PR 8) | `contracts` ("Contract drift", "Version bump against the base branch", tests) | local: `contracts:check`, 15 bump tests on temp git repos |
| Python services: tests and types | `test-python` (pytest with `TEST_DATABASE_URL`, mypy on both src folders) | local: pytest 18 passed, mypy clean |
| Playwright browser install and a real-browser smoke | `e2e-web` (`playwright install --with-deps chromium`, build, run) | local: the spec passes on the preinstalled Chromium |
| Skills stay out of git | `lint` step "Skills stay out of git" | local: same command |

Workflow-level notes: `permissions: contents: read`, a concurrency group that cancels only pull request runs, `timeout-minutes` on every job. `build-docker` and `deploy` now also wait for `contracts`, `test-services` and `test-python`; `deploy` also waits for `compose-stack` and `e2e-web`.

## Decisions
See `docs/build/questions.md`, Chat 1.

## Stubs
- Stub skills in `packages/testing/skills/` (`stub-shred`, `stub-compliance-matrix`, `stub-bid-summary`). Waits on: the owner supplying real skills through `PD_SKILLS_DIR` (BUILD-PLAN decision log 17 Oct). Blocks: any "real skill" check, in chats 3 to 6.
- Native stack doubles (`E2E_STACK=native`, `pnpm dev:stack start`; `packages/testing/src/doubles/`): `oidc.ts` stands in for Zitadel, `s3.ts` (in-memory S3) for the SeaweedFS store, `clamd.ts` (zINSTREAM, PING, VERSION, EICAR) for ClamAV. Waits on: a Docker daemon in the session. Blocks: nothing in the code; it means these Done-when checks are unverified in the session and run in CI (PR 12): the Compose boot (`docker compose up` of `infra/compose/local.yml`), Zitadel start-from-init and the machine key output, ClamAV signatures and a real EICAR scan, SeaweedFS with env credentials and the bucket init, the sandbox container build and its read-only no-network run, and pgvector. `docker compose config -q` on the file passes offline. The sandbox has no native stand-in.
- S3 store is SeaweedFS, not MinIO (questions.md, Chat 1).
- Local Postgres: real PG 16 run as user `pgrun` on port 54329 (no pgvector). pgvector checks wait for the CI Compose stack (PR 11/12).

## Local environment notes
- No Docker daemon. Native Postgres: `runuser -u pgrun -- /usr/lib/postgresql/16/bin/pg_ctl -D /home/pgrun/pg/data -o "-p 54329 -c listen_addresses=127.0.0.1 -k /tmp" start`. A second fresh cluster on 54330 (`/home/pgrun/pg2`) is reset to check fresh-cluster behavior.

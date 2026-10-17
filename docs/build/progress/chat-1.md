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
| 11 Local stack | e2e/c1-11-stack | built, stacked on #58 | Compose file, native stack with doubles, `pnpm migrate` test. Compose parts unverified (no Docker). fable-reviewer: infra |
| 12 CI | e2e/c1-12-ci | planned | |
| 13 Rename notice | - | planned | |

## Decisions
See `docs/build/questions.md`, Chat 1.

## Stubs
- Stub skills in `packages/testing/skills/` (`stub-shred`, `stub-compliance-matrix`, `stub-bid-summary`). Waits on: the owner supplying real skills through `PD_SKILLS_DIR` (BUILD-PLAN decision log 17 Oct). Blocks: any "real skill" check, in chats 3 to 6.
- Native stack doubles (`E2E_STACK=native`, `pnpm dev:stack start`; `packages/testing/src/doubles/`): `oidc.ts` stands in for Zitadel, `s3.ts` (in-memory S3) for the SeaweedFS store, `clamd.ts` (zINSTREAM, PING, VERSION, EICAR) for ClamAV. Waits on: a Docker daemon in the session. Blocks: nothing in the code; it means these Done-when checks are unverified in the session and run in CI (PR 12): the Compose boot (`docker compose up` of `infra/compose/local.yml`), Zitadel start-from-init and the machine key output, ClamAV signatures and a real EICAR scan, SeaweedFS with env credentials and the bucket init, the sandbox container build and its read-only no-network run, and pgvector. `docker compose config -q` on the file passes offline. The sandbox has no native stand-in.
- S3 store is SeaweedFS, not MinIO (questions.md, Chat 1).
- Local Postgres: real PG 16 run as user `pgrun` on port 54329 (no pgvector). pgvector checks wait for the CI Compose stack (PR 11/12).

## Local environment notes
- No Docker daemon. Native Postgres: `runuser -u pgrun -- /usr/lib/postgresql/16/bin/pg_ctl -D /home/pgrun/pg/data -o "-p 54329 -c listen_addresses=127.0.0.1 -k /tmp" start`. A second fresh cluster on 54330 (`/home/pgrun/pg2`) is reset to check fresh-cluster behavior.

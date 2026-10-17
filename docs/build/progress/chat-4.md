# Chat 4 progress

Plan: `docs/build/chat-4.md` (render service, fonts, format lock). Chat 3 (model gateway, orchestrator) has not run. Chat 2 runs in parallel and owns identity, gateway, ingest, intel and PD tabs.

## Session log
- 2026-10-17 session 1: started from master cc07956. Read BUILD-PLAN, chat-4, chat-1 progress and review, INVENTORY, plan sections. Wrote this PR list before any code.

## Findings at start
- The 29 bid-autopilot scripts and 7 prose scripts are not in the repo ("PD source: None", 09 s4.10). Chat 4 writes the scripts it needs for Phase 3 itself and registers them with the toolrunner. The rest wait for their source. Logged in questions.md.
- LibreOffice (`soffice`), `pdftoppm` and the Liberation/Carlito/Caladea/Gelasio fonts exist in this container. A local LibreOffice run still counts as "CI-verified" only after CI ran the same check.
- No Docker daemon. No model gateway. Vision check uses a stub.

## PR list
Branch pattern `e2e/c4-<nn>-<slug>`, one worktree each under `../wt/`. One service per PR. A contract change is its own PR and merges first.

| # | Branch | What | Reviewer | Status | Next step |
|---|---|---|---|---|---|
| 0 | e2e/c4-00-contracts | `render.yaml` routes and schemas; tighten `render.done`, `render.issue.found`, `render.package.ready`; version bumps | reviewer | planned | build |
| 1 | e2e/c4-01-toolrunner | Toolrunner, tool registry, `--selftest` for every tool in CI, per-job temp dirs wiped at job end, no-leftover test | fable-reviewer (sandbox, cleanup) | planned | after 0 |
| 2 | e2e/c4-02-fonts | Metric-compatible alias map, per-job fontconfig, per-tenant font mounts, `tenant_fonts` migration with RLS, licensing note | fable-reviewer (licensing, tenant isolation) | planned | after 1 |
| 3 | e2e/c4-03-format-lock | Format spec, silent rules, empty shell per volume, `format_specs` and `client_shells` | reviewer | planned | after 2 |
| 4 | e2e/c4-04-assembly | python-docx assembly from spec and shell | reviewer | planned | after 3 |
| 5 | e2e/c4-05-numbering | Code-computed contents table, caption numbers, cross-reference text | reviewer | planned | after 4 |
| 6 | e2e/c4-06-convert | LibreOffice headless DOCX to PDF (profile dir per slot), librsvg SVG to PNG | reviewer | planned | after 5 |
| 7 | e2e/c4-07-visual-check | Rasterize, page geometry, vision check, model-gateway stub and recorded-response double | reviewer | planned | after 6 |
| 8 | e2e/c4-08-page-count | `pdfinfo` count on the exact PDF, limits, Word-only note, `renders` and `render_issues` | reviewer | planned | after 7 |
| 9a | e2e/c4-09a-font-requests | Font request API, license confirmation, billing charge id (`font_requests.fee_charge_id`) | fable-reviewer (license, charge id) | planned | after 2 |
| 9b | e2e/c4-09b-fonts-ui | Fonts and Request a font screens in Atrium style (`features/fonts`), states test, light and dark screenshots | reviewer (design fidelity) | planned | after 9a |
| 10 | e2e/c4-10-final-docs | Final review file, handoff, ENHANCEMENTS section, doc fixes | fable-reviewer (final) | planned | end |

Order is mostly serial: PRs 1 to 8 all edit `python/render` and share `uv.lock`. PR 9b (web only) can run in parallel with PRs 3 to 8 once 9a's contract is in PR 0.

## Done-when map (08 Phase 3)
| Check | Proven by | Status |
|---|---|---|
| Test volume renders to Word and PDF; contents table and captions match a hand check | PR 5 and 6 tests | planned |
| Page count matches a hand count of the same PDF | PR 8 test | planned |
| Vision check catches each planted fault | PR 7 test (stub double: unverified: waits on chat 3) | planned |
| Proposed: no render job leaves files behind | PR 1 test | planned |

## Decisions
Mirrors `questions.md`, Chat 4 heading.

## Stubs
| Stub | Where | Owner step it waits on | Check it blocks |
|---|---|---|---|
| Model gateway client double (recorded vision responses), switched by `RENDER_MODELGW_MODE` | `python/render/tests/` (PR 7) | waits on chat 3 model gateway | Vision check against a real model: unverified: waits on chat 3 |

## Tenant tests
PR 1 onward adds a second-tenant test for every render route (CLAUDE.md rule 4). PR 0 adds routes to the contract only, so it has no handler to test.

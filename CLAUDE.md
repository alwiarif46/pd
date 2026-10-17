# E2E Proposal

One monorepo (renamed from PD). TypeScript services under `services/` (pnpm and Turbo), Python services under `python/` (uv workspace), shared code under `packages/`. The plans are in `docs/plans/` (00 to 09); the build plan and chat files are in `docs/build/`. Read `docs/build/BUILD-PLAN.md` first.

## Rules for every session (09 s8)
1. **Who edits what.** `.github/CODEOWNERS` names each service folder's owner. A session works inside one service folder plus `packages/contracts`. Shared packages (`packages/*`) change only in their own PR.
2. **One service per PR.** A contract change goes in its own commit (or PR) merged before the services that use it.
3. **Contracts first.** Change the OpenAPI file or event schema in `packages/contracts`, regenerate types, then change the service.
4. **`tenant_id` on every query.** Every query runs inside `withTenant`. A query without it fails review. Tests cover a second tenant on every endpoint.
5. **No cross-service database access.** A service reads only its own schema. It gets other data through an API call or an event.
6. **Tests and typecheck before commit.** Run the service's tests, `pnpm typecheck`, `pnpm lint`, and the contract tests. Python runs `uv run pytest` and the type checker.
7. **Skills load through the stage interface.** No service reads a SKILL.md file directly. The stage interface loads it and records its version. Skills are not in git (the two tracked PD skills stay until chat 2); tests use the stubs in `packages/testing/skills/`. `packages/contracts` and `packages/testing` arrive in chat 1 PRs 8 and 10.
8. **No PD side copy.** PD's code lives in this repo only. Nothing keeps a copy in sync, and no parity check runs.
9. **Writing rules.** No em dashes. Sentences of 30 words or fewer, varied in length. Active voice.
10. **Secrets.** None in git. Keys live only in the model gateway's environment.
11. **UI.** Every screen uses Atrium's shell, tokens and components (`design/e2e/`, BUILD-PLAN s10). Log each enhancement in `design/e2e/ENHANCEMENTS.md`.

## Layout today
PD's code moved in place (chat 1 PR 7); the package names stayed `@pd/*`. Chat 2 splits it by service.

| Path | What | Becomes (09 s6) |
|---|---|---|
| `services/gateway` (`@pd/api`) | PD's API: auth, org, bids, billing, uploads, amendments | gateway; identity, billing, ingest and intel split out in chat 2 |
| `services/gateway/web` (`@pd/web`) | PD's web app | the E2E web app |
| `services/worker` (`@pd/worker`) | PD's queue jobs: file, AI, amendment, credit gate | ingest, intel and billing |
| `services/ingest/sandbox` (`@pd/sandbox`) | PD's sandbox image | ingest |
| `packages/core`, `packages/ai` | tenancy, credits, seats, schema; providers and pipeline | stay |
| `infra/` | hosting adapters, compose, backups, tests | stays |

The web app below (`services/gateway/web`) keeps PD's v0 rules until its screens are re-done in Atrium's style.

## Web app: who edits what
- `design/v0/**` is v0's drop folder. Read it, never edit it. It is outside every package and excluded from the build, type-check, lint, and tests. ESLint ignores it in `eslint.config.mjs` and Vitest in `services/gateway/web/vitest.config.ts` and `services/gateway/vitest.config.ts`; ignore `design/**` in any new test config too.
- `services/gateway/web/src/ui/**` holds screens you integrate from `design/v0/`. During integration: strip Next.js imports and `"use client"`,
  remove any fetch or router code, map types to `@/types`, and keep markup, class names, and styles exactly as v0 made them,
  so a later re-integration is a clean diff. Do not restyle.
- `services/gateway/web/src/features/**`, `schedule/**`, `api/**`, and everything under `services/gateway` and `services/worker` is yours.
- UI components take data as props and report user actions through callbacks. They never fetch, route, or store.
- `services/gateway/web/src/features/*/ui/` holds hand-built presentational components (shadcn/ui + Tailwind, props and callbacks, rendered outside `.app-shell`). v0 never writes there, and they are not integrated from `design/v0/`. Today: `features/membership/ui` (accept invite, seat locked).
- `services/gateway/web/src/components/ui/**` is shadcn/ui, added with the shadcn CLI (`services/gateway/web/components.json`). Do not hand-edit it, except that `sonner.tsx` has `next-themes` removed and its colors mapped to the `--color-*` tokens. The CLI wrote `from "cn"` imports; they were changed to `@/lib/utils`, so check this after each CLI run.

## Integration task, when asked
1. Read `design/v0/<screen>/`.
2. Write or update `services/gateway/web/src/ui/<screen>/` as above.
3. Write or keep the container in `services/gateway/web/src/features/<screen>/`. On a re-integration, the container does not change
   unless the props contract changed.
4. Run type-check and tests. Commit as `ui: <screen> from v0` and `feature: <screen> container` separately.

## Front-end setup
- React 19, Vite 5, Tailwind v4 through `@tailwindcss/vite`. There is no `tailwind.config.ts`.
- Tokens file: `services/gateway/web/src/styles/tokens.css`. Entry: `services/gateway/web/src/styles/globals.css`.
- Every screen ends up as shadcn/ui + Tailwind from v0. The legacy screens in `src/screens` and `src/components/*.tsx` (styled by `src/index.css`) are a bridge until v0 replaces them; do not add Tailwind classes to them.
- While they exist: Tailwind scans only `src/ui`, `src/features`, `src/schedule`, `src/components/ui`, and `src/lib`; `src/index.css` is imported into a `legacy` CSS layer below the utilities; and preflight comes from `src/styles/ui-preflight.css`, generated by `services/gateway/web/scripts/scope-preflight.mjs`, which applies it to everything outside `.app-shell` (the legacy root). New screens must render outside `.app-shell`. When the last legacy screen is retired, delete `ui-preflight.css`, the script, and the legacy layer, and import `tailwindcss/preflight.css` into `base`.
- Design tokens are Atrium's (`styles/tokens.css`). Dark variants apply under a `.dark` class on `<html>`, set by `src/lib/theme.ts` from a stored choice (default light). The design rule is BUILD-PLAN s10; reference at `design/e2e/`.
- `@/` maps to `services/gateway/web/src`.
- Commands: `pnpm --filter @pd/web dev | typecheck | build`.
- Local stack: `pnpm dev:db` (embedded Postgres in `.dev/pg`, or `PD_DEV_DB_ROOT`), then `pnpm dev:api` (port 3001; sign-up, reset and invite codes print to its console; an invite code is `<orgId>.<token>`: open `http://localhost:3000/#/invite?token=<code>` or paste the code on `#/invite`).

## Conventions
- TypeScript strict. Shared types live in `services/gateway/web/src/types` and `packages/core`.
- Every AI-extracted row carries `sourcePage` and `sourceQuote`. Never render a row without a source control.
- Every tab handles: no solicitation, processing, failed, empty, locked (free plan), out of credits.
- Dates are ISO strings in data; display formatting happens in ui components.
- Tenant safety: the API sets `app.org_id` per request. Never query without it.
- The default branch is `master`. v0 syncs to `v0-ui`.

## Plans
- Product plans are in `docs/plans/` (00 to 09), the only copy (`plans/` holds just a pointer). PD's old plans, including `09-ui-workflow.md`, are in `docs/plans/archive-pd/`. Read `00-overview.md` and `05-ui.md` before UI work.

## Tools (BUILD-PLAN s3)
Verified in the cloud session on 17 Oct 2026. Commands that differ from BUILD-PLAN s3 are marked.
- **Plugins:** `claude plugin marketplace add anthropics/claude-code` (name `claude-code-plugins`) and `obra/superpowers-marketplace` work. Install with `claude plugin install <name>@<marketplace> --scope project`. Differs: `superpowers` is not in `claude-plugins-official`; use `superpowers@superpowers-marketplace`. `.claude/settings.json` lists `extraKnownMarketplaces` and `enabledPlugins`.
- **Agents:** `.claude/agents/` holds architect (opus), builder (sonnet), debugger (opus), reviewer (opus), fable-reviewer. The alias `model: fable` loads; no full id needed.
- **Session hook:** `.claude/hooks/session-start.sh` prints a tool check line. Registering it in `settings.json` is an owner step (HUMAN-TODO H-12).
- **rtk:** not installed. The install script URL 404s and the rtk-ai repo is outside the session's GitHub scope. Skip it.
- **Context7:** `.mcp.json` runs `@upstash/context7-mcp@4.4.2` through npx (pinned; bump on purpose). Approve the project server when asked.
- **Playwright:** `@playwright/test` is a root dev dependency. `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` is preset with a matching Chromium, so a plain `chromium.launch()` works. Do not run `playwright install` in the session; CI installs it.
- **Docker:** the CLI exists but the daemon does not run in the session. Use the native fallback (embedded Postgres, `redis-server`, test doubles). CI runs Compose.
- **GitHub:** `gh` GraphQL commands (`gh pr view/create/merge`) fail. `gh api` (REST) and `gh run view` work. Use the GitHub MCP tools to create, review and merge PRs.

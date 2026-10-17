# Questions log

One heading per chat. Each entry: question, options, choice made, why. Design gaps (BUILD-PLAN s10) go here too, with the screen name and what was invented.

## Chat 1

- **PRs 3 to 6 already merged.** PD #35, #36, #37, #38 are ancestors of master. Options: redo, or skip. Chose skip; nothing left to finish. Open PD PRs #45, #46, #47 are outside chat 1's list and were left alone.
- **Docker daemon not running.** Options: native fallback or wait. Chose native fallback in the session; CI runs Compose.
- **rtk not installable.** Install script URL 404s and the rtk-ai repo is outside the session's GitHub scope. Chose to skip rtk and continue.
- **Superpowers marketplace.** `claude-plugins-official` has no superpowers. Chose `superpowers@superpowers-marketplace`.
- **Branch names.** The session note names `claude/fervent-ramanujan-4voegj`; BUILD-PLAN s6 names `e2e/c<chat>-<nn>-<slug>`. Chose the plan's names (one branch per PR is required by the loop). Asked the owner; unanswered.
- **Hook registration blocked.** Even with `.claude/` writes allowed, the classifier refused `settings.json` with a `SessionStart` hook entry. `settings.json` was written without it; `.claude/hooks/session-start.sh` exists. Owner step: add the `hooks.SessionStart` entry (`bash "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"`). Until then the Proposed check "a new session loads plugins and rtk with no manual steps" is partly unverified.
- **`.claude/` write block.** Lifted by the owner. Only the hook registration (above) remains an owner step, tracked as HUMAN-TODO H-12.
- **Dark mode default.** Options: follow the OS, or stored choice only. Chose stored choice only (default light) because legacy screens have no dark styles. Revisit when they are retired.
- **Shell integration owner.** Chat 1's list has tokens only; chat 2 has no shell item. Chose chat 2 (with the screens that need routes). Told in INVENTORY.
- **Product name in Atrium.** Atrium's page title says "Bidwright" (INVENTORY G13). Chose "E2E Proposal" in app text; no Atrium file is edited.
- **Repository browser and Data and AI settings had no owning chat.** INVENTORY assigns them to chat 3 and chat 8.
- **No version bump enforcement in contracts:check.** contracts:check does not enforce a version bump; PR 12 adds a CI step comparing against the merge base. Chose: defer to PR 12 because it needs git history in CI.
- **Major bump needs the previous-major file.** Options: enforce it in contracts:check now, or in PR 12. Chose PR 12: its version-bump check must also require the previous-major file `<event>.v<old>.schema.json` on a major bump.

- **Outbox relay needs to read across tenants (PR 9).** Each `outbox` has FORCE ROW LEVEL SECURITY keyed on `app.tenant_id`, so a service role sees one tenant at a time. A relay that publishes with `XADD` must see every tenant's unpublished rows. Option A: a separate relay role with BYPASSRLS, granted only SELECT and UPDATE (published_at) on the outbox tables. Option B: the relay loops per tenant and sets `app.tenant_id` for each, which needs a tenant list from the identity service and scales badly. Chose A for chats 2 and 3 to build: one query per schema, no tenant list, and the blast radius is the outbox tables only. Not built in PR 9; each service README carries a TODO.
- **Gateway `skeleton` flag stays false (PR 9).** The gateway exposes PD's real routes, which are not in `openapi/gateway.yaml` yet, so `contracts:check` would fail on drift. PR 9 added `GET /healthz` (standard shape) next to PD's `/health` and left the flag false.
- **Ports for the Python services (PR 9).** The brief said 4101 to 4112 for the new services, but there are 14 of them (12 TypeScript, 2 Python). Chose 4101 to 4114 in `services.json` order, gateway excluded (render 4109, portal 4112). Table in `packages/service-kit/src/config.ts`.
- **Service role may only read its own `schema_migrations` (PR 9).** The brief grants DML on "its tables". Chose SELECT only on the ledger so a service cannot rewrite migration history; DML on every other table, including future ones through default privileges.
- **`REVOKE ALL ON SCHEMA public FROM PUBLIC` (PR 9).** Done as the brief says. PD's own migration `0001_tenant_rls.sql` already does this and grants `pd_app` explicitly, so PD keeps working.
- **Roles are cluster-wide (PR 9).** The DB tests create a throwaway database but the `<schema>_svc` roles live in the cluster, so the tests hold an advisory lock on the cluster and reset the role passwords each run. Two runs on one cluster wait for each other.
- **`withTenant` and `withOrg` differ (PR 9 review).** `withTenant` in `@pd/service-kit` sets `app.tenant_id` and `app.org_id`. `withOrg` in `packages/core` still sets only `app.org_id`. Not edited in chat 1. Chat 2 reconciles: either `withOrg` sets both, or PD's RLS moves to `app.tenant_id`.
- **Dockerfile follow-ups (PR 9 review).** The service Dockerfiles need the real port and a `HEALTHCHECK` against `/healthz`, and the tool image tags are floating. Chat 2, when real services exist. Dockerfiles not changed in chat 1.
- **LISTEN/NOTIFY channel names (PR 9 review).** When the outbox relay arrives, give channels a per-service prefix so one service cannot listen to another's. Chat 2 or 3, with the relay.
- **Health queries cancel on the server (PR 9 review).** The brief said to create pools with `options: '-c statement_timeout=2000'`. That would cap every query of a real service at 2 s. Chose `set local statement_timeout = 2000` sent with the health query itself, so only `/healthz` is capped. Pools keep `connectionTimeoutMillis: 2000`. Python connections use the `options` form because they only serve `/healthz`.
- **Service-kit tests refuse a cluster in use (PR 9 review).** They reset the `*_svc` passwords. They skip (fail under CI) when any of those roles has a login password, unless `SERVICE_KIT_TEST_RESETS_ROLES=1`.

## Chat 2

## Chat 3

## Chat 4

## Chat 5

## Chat 6

## Chat 7

## Chat 8

## Chat 9

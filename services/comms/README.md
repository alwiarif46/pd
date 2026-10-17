# @pd/comms: Comms

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.12.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `comms` |
| Postgres role | `comms_svc` (own schema only) |
| Env var for the database | `COMMS_DATABASE_URL` |
| Default port | 4111 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/comms.yaml` |

## What it owns

Gmail and Microsoft 365 connections and their tokens, Q&A drafting and send, request and collect, reply polling, outbound and inbound email, eBuy inbound and the daily check.

## Tables it will get

- `mail_connections`
- `oauth_tokens`
- `outbound_emails`
- `inbound_messages`
- `qa_sets`
- `qa_questions`
- `third_party_requests`
- `request_replies`
- `ebuy_checks`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/comms dev        # tsx watch, port 4111
pnpm --filter @pd/comms test
curl localhost:4111/healthz     # {"service":"comms","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `comms.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `comms.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.

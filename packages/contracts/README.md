# @pd/contracts

The contracts between services: one OpenAPI file per service and one JSON schema per event. A contract changes first, in its own commit, before any service code that uses it (BUILD-PLAN s5, 09 s2).

## Layout

| Path | What it holds |
|---|---|
| `openapi/<service>.yaml` | OpenAPI 3.1, one per service id. Carries `info.version` and `x-service`. Every file has `GET /healthz`. |
| `events/_envelope.schema.json` | The fields every event carries: `event_id`, `tenant_id`, `schema_version`, `occurred_at`, `type`, `payload`. |
| `events/<name>.schema.json` | One schema per event, for example `identity.tenant.created.schema.json`. It extends the envelope with `allOf`, and sets `type`, `schema_version` and `payload`. Carries `x-owner` (service id) and `x-stream` (`e2e.<name>`). |
| `services.json` | The 15 services: id, name, language, folder, Postgres schema, stream prefix, and `skeleton` (true once the service has a `src/routes.ts`). |
| `src/event-names.ts` | The list of event names. |
| `src/index.ts` | `SERVICES`, `eventNames`, `loadEventSchema`, `validateEvent`, `parseVersion`, `acceptsSchemaVersion`, `supportedMajorsFor`, `makeEvent`. |
| `generated/` | Types made by `scripts/generate.ts`: `openapi/<service>.d.ts` and `events.d.ts`. Committed. Do not edit by hand. |
| `scripts/check.ts` | `pnpm contracts:check`. |

## Version rules (BUILD-PLAN s5)

- Each OpenAPI file carries `info.version` (semver). Each event schema carries `schema_version` (`major.minor`, set as a `const`).
- A breaking change bumps the major number. A compatible change bumps the minor number.
- A consumer accepts the current and the previous major for the rest of the chat. A follow-up PR then removes the old one. Use `supportedMajorsFor(current)` and `acceptsSchemaVersion(docVersion, majors)`.
- `pnpm contracts:check` fails on drift.

## What `pnpm contracts:check` checks

1. Every OpenAPI file is valid, has a semver `info.version`, an `x-service` equal to its file name, and a `/healthz` path.
2. Every event schema compiles under strict Ajv 2020, has a `$id` that matches its file name, an `x-owner` that is a known service, an `x-stream` equal to `e2e.<name>`, and a `schema_version` const like `1.0`.
3. The event files match the list in `src/event-names.ts`: none missing, none extra.
4. The files in `generated/` match what the generators produce now.
5. For each service with `skeleton: true` in `services.json`, `<folder>/src/routes.ts` exports `routes: ReadonlyArray<{ method: string; path: string }>`, and those routes equal the OpenAPI paths and methods (`:id` is read as `{id}`).

## Add a route

1. Edit `openapi/<service>.yaml`. Bump `info.version` (minor for an addition, major for a break).
2. Run `pnpm --filter @pd/contracts generate`.
3. Run `pnpm contracts:check`.
4. Commit the contract change alone.
5. Then change the service. If the service is a skeleton, add the route to its `src/routes.ts` too.

## Add an event

1. Add the name to `src/event-names.ts`.
2. Copy a small file from `events/` and change `$id`, `title`, `x-owner`, `x-stream`, `type` and the description. Tighten `payload` when the owning service is built.
3. Run `pnpm --filter @pd/contracts generate`, then `pnpm contracts:check`.
4. Commit the contract change alone, then change the services.

Event names use the stream form without the prefix: `<service>.<entity>.<verb>`. The stream is the name with `e2e.` in front. The `x-owner` is the service that writes the event.

# @pd/contracts

The contracts between services: one OpenAPI file per service and one JSON schema per event. A contract changes first, in its own commit, before any service code that uses it (BUILD-PLAN s5, 09 s2).

## Layout

| Path | What it holds |
|---|---|
| `openapi/<service>.yaml` | OpenAPI 3.1, one per service id. Carries `info.version` and `x-service`. Every file has `GET /healthz`. |
| `events/_envelope.schema.json` | The fields every event carries: `event_id`, `tenant_id`, `schema_version`, `occurred_at`, `type`, `payload`. |
| `events/<name>.schema.json` | One schema per event, for example `identity.tenant.created.schema.json`. `allOf` is exactly the envelope `$ref`, and `unevaluatedProperties` is `false`, so a stray top-level field such as `tenantId` is rejected. It sets `type`, `schema_version` (a pattern for the current major) and `payload` (open). Carries `x-owner` (service id), `x-stream` (`e2e.<name>`) and `x-schema-version` (the exact current version, such as `1.0`). Top-level `required`, `additionalProperties` and `patternProperties` are not allowed, and `properties` may only name envelope fields (`type`, `schema_version`, `payload` in practice). |
| `events/<name>.v<N>.schema.json` | The previous major N of an event, kept for one chat after a breaking change. Only allowed when the current major is 2 or more: majors 0 and 1 have no previous-major window, so a `.v0` or `.v1` file next to a current 1.x fails the check. N has no leading zero. Same `x-owner` and `x-stream` as the base file, `x-schema-version` and `schema_version` pattern for major N. None exist yet. |
| `services.json` | The 15 services: id, name, language, folder, Postgres schema, stream prefix, and `skeleton` (true once the service has a route list: `src/routes.ts` for `ts`, `routes.json` for `py`). |
| `src/event-names.ts` | The list of event names. |
| `src/index.ts` | `SERVICES`, `eventNames`, `loadEventSchema`, `validateEvent`, `previousMajorsOf`, `currentVersionOf`, `parseVersion`, `acceptsSchemaVersion`, `supportedMajorsFor`, `makeEvent`. |
| `generated/` | Types made by `scripts/generate.ts`: `openapi/<service>.d.ts` and `events.d.ts`. Committed. Do not edit by hand. |
| `scripts/check.ts` | `pnpm contracts:check`. |

## Version rules (BUILD-PLAN s5)

- Each OpenAPI file carries `info.version` (semver). Each event schema carries `x-schema-version` (`major.minor` with no leading zeros, pattern `^(0|[1-9]\d*)\.(0|[1-9]\d*)$`, the exact current version) and a `schema_version` pattern `^<major>\.\d+$` for the current major. `makeEvent` stamps `x-schema-version`.
- A breaking change bumps the major number. A compatible change bumps the minor number. A minor bump changes `x-schema-version` only, and old minors still validate.
- On a major bump, first copy the old file to `events/<name>.v<N>.schema.json` (N is the old major, `$id` gets a `.v<N>` suffix), then edit the base file. Generated types then include `<Name>EventV<N>`. The follow-up PR deletes the `.v<N>` file.
- `validateEvent(name, doc)` picks the schema by the document's major. It accepts the current major and the previous one (only if the `.v<N>` file exists). Any other major, and any malformed `schema_version`, is invalid.
- `supportedMajorsFor(current)` gives `[major, major - 1]` from major 2 on. Majors 0 and 1 have no previous-major window and give only `[major]`. `acceptsSchemaVersion(docVersion, majors)` is the check `validateEvent` uses.
- `pnpm contracts:check` fails on drift. It does not look at git history by itself. The version-bump check does: `pnpm contracts:check:bump -- --base origin/master` (or `pnpm contracts:check -- --base origin/master`, which runs both) compares HEAD with `git merge-base HEAD <base>`. A changed OpenAPI file must raise `info.version` and a changed event file must raise `x-schema-version` in the same diff. A major bump of an event must go up by one and needs `<event>.v<old>.schema.json` at HEAD (already there or added in the diff). New files need no bump. A deleted contract file fails, except a `.v<N>` file (the follow-up PR deletes it). A change to `_envelope.schema.json` only prints a warning. If the base ref is not available locally the command prints a message and exits 0; under `CI=true` that is a failure. CI runs it on pull requests (job `contracts`, `scripts/bump.ts`, tests in `test/bump.test.ts`).

## What `pnpm contracts:check` checks

1. Every OpenAPI file is valid, has a semver `info.version`, an `x-service` equal to its file name, and a `/healthz` path.
2. The envelope requires exactly `event_id`, `tenant_id`, `schema_version`, `occurred_at`, `type`, `payload`.
3. The envelope pins each field's shape (uuid ids, date-time, object payload, version pattern). Every event schema compiles under strict Ajv 2020, has a `$id` that matches its file name, an `x-owner` that is a known service, an `x-stream` equal to `e2e.<name>`, `allOf` equal to exactly the envelope `$ref`, `unevaluatedProperties: false`, an `x-schema-version` like `1.0`, and a `schema_version` pattern for that major. Event names match `^[a-z]+(\.[a-z_]+){1,2}$`.
4. Each `.v<N>` file has a base event, the base's `x-owner`, the same `x-stream`, major N, and N is the base's current major minus one. The current major must be 2 or more (majors 0 and 1 have no previous-major window).
5. The event files match the list in `src/event-names.ts`: none missing, none extra.
6. The whole `generated/` tree matches what the generators produce now. A stray file fails.
7. For each service with `skeleton: true` in `services.json`, the routes equal the OpenAPI paths and methods. A `ts` service exports `routes: ReadonlyArray<{ method: string; path: string }>` from `<folder>/src/routes.ts`, with Fastify paths (`:id` is read as `{id}`; `{` is rejected). A `py` service lists `[{ "method": "GET", "path": "/users/{id}" }]` in `<folder>/routes.json`, with paths in OpenAPI form.

## Add a route

1. Edit `openapi/<service>.yaml`. Bump `info.version` (minor for an addition, major for a break).
2. Run `pnpm --filter @pd/contracts generate`.
3. Run `pnpm contracts:check`.
4. Commit the contract change alone.
5. Then change the service. If the service is a skeleton, add the route to its `src/routes.ts` (or `routes.json` for Python) too.

## Add an event

1. Add the name to `src/event-names.ts`.
2. Copy a small file from `events/` and change `$id`, `title`, `x-owner`, `x-stream`, `type` and the description. Keep `allOf`, `unevaluatedProperties: false` and `x-schema-version`. Tighten `payload` when the owning service is built.
3. Run `pnpm --filter @pd/contracts generate`, then `pnpm contracts:check`.
4. Commit the contract change alone, then change the services.

Event names use the stream form without the prefix: `<service>.<entity>.<verb>`. The stream is the name with `e2e.` in front. The `x-owner` is the service that writes the event.

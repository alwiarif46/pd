# infra/compose

The local development stack (09 s9.1). `local.yml` is for development and CI. PD's production compose is `infra/docker-compose.yml`; do not mix them.

## Boot

```
cp infra/compose/local.env.example infra/compose/local.env      # then change the values; local.env is not in git
docker compose -f infra/compose/local.yml --env-file infra/compose/local.env up -d --build --wait
```

`--wait` returns when every service with a healthcheck is healthy. First start takes a few minutes: ClamAV downloads its signatures, and the sandbox image builds. Stop with `down`; add `-v` to delete the data volumes (this also makes the Postgres init script run again).

No Docker (a cloud session, for example)? Use the native stack: `pnpm dev:stack start` (see "Native stack" below).

## What runs

| Service | Image | Host port | What it is |
|---|---|---|---|
| `postgres` | `pgvector/pgvector:0.8.7-pg16` | 5432 | One cluster: the `e2e` database (15 service schemas, `vector` enabled) and the `zitadel` database. |
| `redis` | `redis:7.4.9-alpine` | 6379 | `appendonly yes`, `maxmemory-policy noeviction` (01 s3). |
| `zitadel` | `ghcr.io/zitadel/zitadel:v4.19.5` | 8080 | OIDC issuer. `start-from-init`, external domain `localhost`, plain HTTP. |
| `s3` | `chrislusf/seaweedfs:4.48` | 8333 | S3 API (path-style). |
| `s3-init` | same | none | One-shot: creates `S3_BUCKET`, then exits. |
| `clamav` | `clamav/clamav:1.5.4` | 3310 | clamd with production's `infra/clamav/clamd.conf` mounted (TCP 3310, unix socket `/tmp/clamd.sock`, log file `/var/log/clamav/clamd.log`). |
| `sandbox` | built from `services/ingest/sandbox/Dockerfile` | none | PD's file sandbox image. Idles so the image, its tools and its hardening are checked. |

All ports bind to 127.0.0.1. Every service has a healthcheck, and `depends_on` waits on `service_healthy`. Data lives in named volumes (`postgres_data`, `redis_data`, `s3_data`, `clamav_data`, `zitadel_bootstrap`), not on the host.

The sandbox keeps PD's production hardening: `network_mode: none`, plus a read-only root, all capabilities dropped, `no-new-privileges`, a pid limit, the non-root `sandbox` user, and 2 CPUs / 1.5 GB. `/input`, `/output`, `/tmp` and the home directory are tmpfs. Run a file job by hand with `docker compose -f infra/compose/local.yml --env-file infra/compose/local.env run --rm --entrypoint node sandbox dist/index.js <args>`.

## Why these versions

Every tag was checked to exist; none is `latest`. Bump one deliberately and say why in the PR.

- `pgvector/pgvector:0.8.7-pg16`: Postgres 16 is the plan's version (01 s3) and the evidence service needs pgvector. PD's production Postgres (`postgres:16-alpine`) has no pgvector yet.
- `redis:7.4.9-alpine`: Redis 7, the last line before the Redis 8 licence change.
- `ghcr.io/zitadel/zitadel:v4.19.5`: pinned so identity work in chat 2 does not move under us. Zitadel is AGPL-3.0. We run the unmodified image as its own container and call it over HTTP only. The image has no shell or curl, so its healthcheck is `/app/zitadel ready`.
- `clamav/clamav:1.5.4`: the plan's scanner, now pinned (production still says `latest`).
- `chrislusf/seaweedfs:4.48`: see below.

### SeaweedFS instead of MinIO

The plans say MinIO. MinIO's prebuilt images are no longer pullable from Docker Hub, and quay.io, where they moved, could not be verified from the build session. We use SeaweedFS as the S3-compatible store: one container, S3 API on 8333, path-style, one bucket made by `s3-init`. All variable names stay `S3_*` (09 s9.2), so code does not know the difference. The choice is logged in `docs/build/questions.md`, Chat 1. RustFS was the other candidate; SeaweedFS has the longer track record. Credentials reach it through `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, which the S3 gateway reads when no `s3.config` is given.

## Database setup

`postgres-init/01-databases.sh` runs once on an empty data volume. It enables `vector` in the e2e database, creates the `zitadel` login role (password from `ZITADEL_DB_PASSWORD`) and the `zitadel` database it owns, and runs `REVOKE CONNECT ON DATABASE zitadel FROM PUBLIC`, then `GRANT CONNECT` to the `zitadel` role. That is the same treatment `pnpm migrate` gives the e2e database (`infra/db/README.md`, "Other databases on the same cluster"), so no service role can open the Zitadel database and the Zitadel role cannot open the e2e database. Zitadel's own init step uses the `postgres` login only to create what is missing, then runs as `zitadel`. `packages/testing/test/stack-migrate.test.ts` checks the script text and that a role outside the 14 cannot read any service schema.

The machine key for the identity service (chat 2) is written to the `zitadel_bootstrap` volume at `/zitadel-bootstrap/identity-sa.json` on the first start. Read it with `docker run --rm -v pd-local_zitadel_bootstrap:/k:ro alpine cat /k/identity-sa.json`.

## Migrate

```
export PD_ADMIN_DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/e2e
pnpm migrate
```

Use the `postgres` login and `E2E_DB_NAME` from your `local.env`. `<SERVICE>_DB_PASSWORD` variables, when set, give the service roles a password (`infra/db/README.md`). The 15 schemas apply in the 09 s9.3 order: `app`, `identity`, `billing`, `ingest`, `intel`, `orchestrator`, `modelgw`, `drafting`, `review`, `render`, `evidence`, `comms`, `portal`, `drive`, `notify`. `packages/testing/test/stack-migrate.test.ts` runs the real command against a scratch database and asserts that order. The done-when check "a service role that queries another service's schema gets a permission error" is `packages/service-kit/test/isolation.test.ts` (14 roles against 13 other schemas, error 42501).

## Environment variables

- `local.env.example`: the Compose stack's own settings (passwords, ports). Every value is a dev-only placeholder carrying the `secret-scan: allow` marker.
- `stack.env.example`: every variable of 09 s9.2 by name, grouped by service, with local defaults. A test checks it against the table in the plan.

Secrets have no defaults in `local.yml` (`${VAR:?}`); only ports, names and other non-secret values do.

## Native stack (no Docker)

`E2E_STACK=native` selects it. `pnpm dev:stack start` (the script is `infra/local/native-stack.sh`) starts real Postgres 16 and Redis from the host and three test doubles from `packages/testing/src/doubles`: a mock OIDC issuer for Zitadel, an in-memory S3 for SeaweedFS, and a clamd stand-in for ClamAV. It prints the variables to export and the stop command. `status`, `env` and `stop` are the other commands; start is idempotent. Data lives in `.dev/native` (ignored by git). Ports and paths are set by `PD_NATIVE_*` and `PD_DOUBLE_*` variables, listed at the top of the script. The sandbox has no native form. The doubles are for tests and local runs only; a test and an ESLint rule keep them out of production code.

## What only CI can check

No Docker daemon runs in the build session, so these have not run anywhere yet. CI (PR 12, job `compose-stack`, checks in `infra/compose/ci/stack-smoke.py`) runs them. You can run the same script by hand after `up --wait`: `python3 infra/compose/ci/stack-smoke.py --env-file infra/compose/local.env all` (after `pnpm migrate`).

- `docker compose up` itself: the boot, every healthcheck, the `depends_on` order, volume permissions.
- Zitadel: start-from-init against the `zitadel` database, the machine key file, and `/app/zitadel ready` (it calls `/debug/ready`). The variable names (`ZITADEL_EXTERNALDOMAIN`, `EXTERNALPORT`, `EXTERNALSECURE`, `TLS_ENABLED`, `DATABASE_POSTGRES_*`, `FIRSTINSTANCE_*`, `DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED`) were confirmed against the v4.19.5 source. Still unverified: the actual boot. Zitadel resolves the instance by Host, so clients use `localhost:8080`, not `127.0.0.1:8080`.
- ClamAV: the signature download, `clamdcheck.sh`, a real EICAR scan.
- SeaweedFS: the S3 gateway with env credentials, the `s3-init` bucket creation, the healthcheck.
- The sandbox image build and its read-only, no-network run.
- pgvector: `create extension vector`. The local Postgres in the session has no pgvector.

The file itself is checked offline: `bash infra/tests/test-local-stack.sh` runs `docker compose config -q` (when the docker client is present) and static checks.

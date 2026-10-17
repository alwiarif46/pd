# Proposal Development Tool

A web app for government contractors to plan and manage federal and SLED bids.

## Overview

This tool helps contractors:
- Upload solicitation documents (solicitation, amendments, attachments)
- Generate compliance matrices automatically
- Track proposal schedules
- Manage team collaboration
- Export deliverables

## Tech Stack

- **Frontend**: React + Vite
- **API**: Fastify (Node.js)
- **Database**: PostgreSQL 16 with row-level security
- **Queue**: BullMQ on Redis
- **File Processing**: Sandbox container (no network, no secrets)
- **AI**: Provider-agnostic (DeepInfra, Anthropic, Ollama)

## Project Structure

```
services/
├── gateway/          Fastify API (PD's API for now); web/ is the React app
├── worker/           BullMQ workers (split into ingest, intel and billing in chat 2)
└── ingest/sandbox/   File processing container
python/               uv workspace (render, portal-agent): skeletons in chat 1 PR 9
packages/
├── core/             Tenancy, credits, seats, schema
└── ai/               AI provider layer and pipeline
skills/               Skill instructions (mostly out of git)
evals/                Test harness and fixtures
infra/                Compose, hosting adapters, backups, tests
design/               v0 (PD) and e2e (Atrium) reference, not built
docs/plans/           Product plans (only copy); docs/build/ has the build plan
```

## Development

```bash
# Install dependencies
pnpm install

# Run all services in development
pnpm dev

# Build
pnpm build

# Type check
pnpm typecheck
```

## Phases

See [docs/plans/08-build-phases.md](docs/plans/08-build-phases.md) for the build roadmap.

## Status

Phase 0 (Setup) - Infrastructure and project structure initialization

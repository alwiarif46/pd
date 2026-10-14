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
pd/
├── apps/
│   ├── web/          React frontend
│   ├── api/          Fastify API server
│   ├── worker/       BullMQ background workers
│   └── sandbox/      File processing container
├── packages/
│   ├── core/         Shared types and utilities
│   └── ai/           AI provider layer
├── skills/           AI skill instructions
├── evals/            Model evaluation harness
├── infra/            Docker Compose, nginx configs
├── design/v0/        v0 drop folder (not built)
└── docs/plans/       Project plans (only copy)
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

# 02 — Architecture

**Status:** Draft v2 · 13 Oct 2026

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, front end and server | One language across the app |
| Front end | React with Vite | Sidebar tabs, tables, forms; large hiring pool |
| PDF viewer | pdf.js | Page view with the quote highlighted; reads files by range requests |
| API server | Node.js with Fastify | Fast, typed request validation |
| Database | PostgreSQL 16 | Row-level security for tenants, JSON columns for AI output |
| ORM and migrations | Drizzle | Typed queries, plain SQL migrations |
| Job queue | BullMQ on Redis, with `appendonly yes` | Retries, concurrency limits per job type; queue survives a Redis restart |
| Sessions | PostgreSQL `sessions` table | Sessions survive a Redis restart and can be revoked by row |
| File checks | qpdf and Poppler `pdfinfo`, in the sandbox | Encryption type and page count before any heavy work |
| DOCX conversion | LibreOffice headless, in the sandbox (DOCX to PDF). Mammoth only as a text fallback if conversion fails | Real page numbers and a PDF the viewer can highlight |
| Text extraction | Poppler `pdftotext` (PDF), SheetJS (XLSX), in the sandbox | Page-level text with page numbers |
| OCR | OCRmyPDF with Tesseract, in the sandbox, `--jobs 2` | Free, runs on the server |
| Exports | ExcelJS (XLSX), docx library (DOCX) | Matrices export to Excel, forms to Word |
| AI access | Own provider layer (section 5) | Swap DeepInfra, Anthropic, Ollama by setting |
| Archive storage | Off-server object storage, files encrypted before upload. 🟨 **OPEN:** provider (01 s4) | Keeps originals after their live date without filling the server |
| Payments | Stripe Billing, Checkout, Customer Portal | Subscriptions per organization |
| SMS | Telnyx | Phone verification codes; Shaavir already has an account |
| Email | Transactional email provider 🟨 **OPEN** | Verification, invites, receipts |

## 2. Components

```
Browser (React app)
   │  HTTPS (Cloudflare → nginx)
   ▼
api (Fastify)
   ├── Auth, sessions, organizations, members, invites
   ├── Bids, tabs, rows, row detail and edit history
   ├── Upload sessions (20 MB chunks, MB cap check, joined on disk, queue scan)
   ├── Plan limits and RFP credit reservation
   ├── Stripe webhooks (stored, then processed by a system job)
   └── Job status (polling endpoint with queue position)
   │
   ├── PostgreSQL (all app data, tenant-scoped)
   ├── Redis (queues, rate limits)
   └── /data/files (uploads, viewer copies, upload chunks, exports)
   ▲
worker (BullMQ; AI and database work only, never opens an uploaded file)
   ├── scan        ClamAV check through clamd
   ├── file        asks the sandbox runner to process a file; validates and stores the result
   ├── marking     CUI and export-control marking check on the extracted text
   ├── classify    tag pages: instructions, evaluation, scope, terms, attachments
   ├── ai:*        compliance, amendment-diff, dates, overview, outline, resume, review, production, orals
   ├── export      XLSX and DOCX files
   ├── retention   archive moves, restores, archive purges, resume deletion at 90 days
   └── cleanup     expired exports, abandoned upload sessions, orphan files
   │
   ▼
sandbox (one container per file job; no network, no secrets; see 01 s2.1)
   └── encryption check, page count, DOCX to PDF, pdftotext, OCR → JSON page text and page images

Off the server: archive storage (encrypted files), off-site database backups
```

The worker validates the sandbox's JSON against a schema before anything reaches the database.

## 3. Request flow: upload to compliance matrix

1. User opens a bid and starts one upload session per file. The session declares the total size, the sha256, and the chunk count (`upload_sessions`, 03 s2).
2. api checks that the declared size fits what is left of the bid's MB cap (06 s3), that the same sha256 is not already on the bid, and, for the bid's first `solicitation` file, that a credit can be reserved (06 s4).
3. The browser sends 20 MB chunks, each with its index and the chunk count. The api checks order and the running total against the declared size and the cap. Sessions not completed in 24 hours expire and their chunks are deleted.
4. On completion the api checks the sha256, stores the file, reserves the credit if needed, and queues `scan`.
5. worker scans the file. Infected files are deleted and the user sees an error.
6. The sandbox checks encryption (files that need a password to open are rejected) and page count, converts DOCX to PDF, extracts text per page, and runs OCR on pages with no text layer.
7. worker runs the marking check. If a CUI or export-control marking is found, AI work on that file stops until the user confirms (07 s3).
8. worker reads the solicitation number and checks it against the bid's `solicitation_key` (06 s4), then runs `classify`, chunk, and pre-scan.
9. worker runs the AI jobs for free tabs: overview facts, dates, compliance matrix.
10. Each job writes results with the document, page, page end, and exact quote (03 s3.1), then marks the job done. When the compliance matrix job succeeds, the reserved credit is consumed. If it fails, the credit is released.
11. The browser polls job status every 3 seconds and shows progress per step and the queue position.
12. User reviews, edits, and exports.

An amendment follows steps 1 to 8, then runs the amendment flow in 04 s3.1 instead of a full run. An attachment added later runs the full passes on its own text and merges into the matrix.

## 4. Multi-tenancy

- One shared database. Every tenant table has an `org_id` column.
- Row-level security on every tenant table, with `FORCE ROW LEVEL SECURITY` so policies apply even to the table owner.
- Every API request and every worker job runs inside a transaction that starts with `select set_config('app.org_id', $1, true)`. The `true` makes the setting transaction-local, so a pooled connection never carries one tenant's setting into the next request. Policies compare `org_id` with `current_setting('app.org_id')`. A transaction with no setting sees no rows.
- Database roles:

| Role | Used by | Rights |
|---|---|---|
| `pd_owner` | Migrations only | Owns the tables. Never used by the running app |
| `pd_app` | api and worker | Not the table owner. `NOBYPASSRLS`. Reaches tenant tables only through row-level security |
| `pd_system` | A few named `SECURITY DEFINER` functions | `NOLOGIN`. Serves the jobs with no org context: retention and cleanup, usage rollup, Stripe webhook processing, invite-token lookup. `pd_app` may call these functions but cannot act as `pd_system` any other way |

- Each `pd_system` function returns the minimum it must (IDs and their `org_id`). The job then does the work per organization as `pd_app`, with `app.org_id` set.
- Files are stored under `/data/files/{org_id}/...`. The api serves a file only after a membership check, through a per-document viewing token valid about 1 hour and bound to the user's session. pdf.js reads the file in range requests for as long as it is open, so a 5-minute link would break the viewer.
- Jobs carry `org_id`. The worker sets it the same way before it reads or writes.
- AI requests never mix two organizations' text in one call.
- Tests (08): user A gets 404 on every endpoint with user B's IDs; a pool of size 1 serving two requests from different organizations in a row never returns the other organization's rows.

## 5. AI provider layer

One interface, three adapters:

```ts
interface ModelProvider {
  name: 'deepinfra' | 'anthropic' | 'ollama';
  complete(req: {
    system: string;            // skill instructions + task prompt
    messages: Message[];
    jsonSchema?: object;       // structured output when supported
    maxOutputTokens: number;
    cacheKey?: string;         // provider prefix caching where offered; cost plans do not assume it
  }): Promise<{ text: string; json?: unknown; usage: TokenUsage }>;
}
```

- DeepInfra and Ollama use the OpenAI-compatible chat API. Anthropic uses the Messages API.
- A settings table maps each AI task to a provider and model, so one task can move to another model without a deploy. Example: extraction on Qwen, verification on Sonnet. In v1 Amaan changes settings directly in the database; admin screens come after v1.
- Concurrency: each provider has its own concurrent-call setting (starting value 3, set from the Phase 1 benchmark), and each bid has a cap below it (01 s2.2).
- Every call records tokens, cost, duration, model, and task in `ai_runs`, rolled up nightly into `ai_usage_daily` (03-data-model.md).
- Retries: 2 retries with backoff on timeouts and rate limits. Invalid JSON gets one repair attempt, then the job fails with a clear message. The JSON validity rate is measured in Phase 1.

## 6. Skills inside the app

- Shaavir skills (compliance-matrix, bid-summary to start) live in the repo under `/skills/{name}/SKILL.md`, versioned with the code.
- A loader reads the instructions for each task and places them in the system prompt. Users never see the instructions.
- Each AI result stores the skill name and version that produced it, so test results tie to a skill version.
- Skill scripts that need to run become server functions the model can call as tools, only where needed. The fixed pipeline in 04-ai-pipeline.md needs no model-chosen tools in v1.

## 7. API outline

| Area | Endpoints (prefix `/api`) |
|---|---|
| Auth | `POST /auth/signup`, `/auth/verify-email`, `/auth/verify-phone`, `/auth/login`, `/auth/logout`, `/auth/reset` |
| Organization | `GET/PATCH /org`, `GET/POST/DELETE /org/members`, `POST /org/invites` |
| Processing info | `GET /about/processing` (AI model, provider, and subprocessors in use) |
| Billing | `POST /billing/checkout`, `POST /billing/portal`, `POST /billing/webhook` (Stripe) |
| Bids | `GET/POST /bids`, `GET/PATCH/DELETE /bids/:id` |
| Uploads | `POST /bids/:id/uploads` (open a session), `PUT /uploads/:id/chunks/:index`, `POST /uploads/:id/complete` |
| Documents | `GET /bids/:id/documents`, `GET /documents/:id/view-token`, `POST /documents/:id/restore`, `POST /documents/:id/confirm-marking`, `POST /documents/:id/key-override` (owner only), `DELETE /documents/:id` |
| Amendments | `GET /bids/:id/amendment-links`, `POST /amendment-links/:id/confirm`, `POST /amendment-links/:id/reject` |
| Jobs | `GET /bids/:id/jobs` (status and queue position) |
| Tabs | `GET/PATCH /bids/:id/tabs/:tab` plus row endpoints per tab; `GET /bids/:id/rows/:table/:rowId` (row detail with edit history) |
| Exports | `POST /bids/:id/exports/:tab`, `GET /exports/:id` |
| Health | `GET /health` |

No admin endpoints in v1. Admin tooling is post-v1 (08).

## 8. Code layout

```
pd/
├── apps/web          React front end
├── apps/api          Fastify server
├── apps/worker       BullMQ workers
├── apps/sandbox      file processing image (qpdf, Poppler, LibreOffice, OCRmyPDF, SheetJS)
├── packages/core     shared types, plan rules, date logic, quote normalization
├── packages/ai       provider layer, prompts, schema, skill loader
├── skills/           SKILL.md files (compliance-matrix, bid-summary)
├── evals/            model test harness and golden set (not deployed)
├── infra/            docker-compose, nginx, sandbox runner, backup scripts
└── docs/plans/       copy of these plans
```

## Decision log

| Date | Decision |
|---|---|
| 13 Oct 2026 | TypeScript stack, Postgres with row-level security, provider layer with three adapters |
| 13 Oct 2026 | Row-level security hardened: transaction-local `app.org_id`, `FORCE ROW LEVEL SECURITY`, roles `pd_owner`, `pd_app` (`NOBYPASSRLS`), and `pd_system` reachable only through named functions |
| 13 Oct 2026 | Uploaded files are opened only in a `sandbox` container; the worker keeps AI and database work |
| 13 Oct 2026 | DOCX converted to PDF with LibreOffice headless; Mammoth kept only as a text fallback |
| 13 Oct 2026 | Upload sessions with declared size, sha256, chunk index and count, MB cap check, 24-hour expiry |
| 13 Oct 2026 | Sessions in Postgres; Redis runs with `appendonly yes` |
| 13 Oct 2026 | Per-document viewing tokens valid about 1 hour, bound to the session, replace 5-minute signed URLs |
| 13 Oct 2026 | AI concurrency per provider plus a per-bid cap; amendment-diff job added |
| 13 Oct 2026 | No admin endpoints in v1; settings changed in the database |

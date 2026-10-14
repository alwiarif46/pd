# v0 drop folder
Write every file for a screen under `design/v0/<screen>/`. Touch nothing outside this folder.
Build presentational components only: props in, callbacks out, sample data as constants, no fetching, no routing, no global state.
Plain React + TypeScript + Tailwind v4 + shadcn/ui. No Next.js imports, no `"use client"`.
Read the screen description in `docs/plans/05-ui.md` and the props contract in `docs/plans/09-ui-workflow.md` section 5.
Shared types (`Tab`, `ProcessingState`, `SourceLinkProps`) already exist; import them from `@/types`, do not redefine them.
shadcn components already exist at `@/components/ui/<name>`: button, input, label, select, checkbox, table, dialog, sheet, tabs, badge, dropdown-menu, tooltip, sonner.
Use the theme colors from `docs/plans/09-ui-workflow.md` section 4 (for example `bg-canvas`, `text-ink`, `border-line`, `bg-primary`).
This folder is never built, type-checked, or linted.
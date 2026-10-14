# v0 drop folder
Write every file for a screen under `design/v0/<screen>/`. Touch nothing outside this folder.
Build presentational components only: props in, callbacks out, sample data as constants, no fetching, no routing, no global state.
Plain React + TypeScript + Tailwind v4 + shadcn/ui. No Next.js imports, no `"use client"`.
Read the screen description in `docs/plans/05-ui.md` and the props contract in `docs/plans/09-ui-workflow.md` section 5. Where this README and plan 09 section 5 disagree, plan 09 section 5 wins.
Shared types that already exist in `@/types` (`Tab`, `ProcessingState`, `SourceLinkProps`, the auth props and `AuthStatus`): import them, do not redefine them. The other shared types in plan 09 section 5.12 (`Plan`, `BidType`, `Role`, `TabFrameProps`, and so on) are part of the contract: declare them in the screen folder exactly as written there, and they are moved into `@/types` at integration.
shadcn components already exist at `@/components/ui/<name>`: alert-dialog, badge, button, checkbox, dialog, dropdown-menu, input, label, progress, select, separator, sheet, skeleton, sonner, switch, table, tabs, textarea, tooltip. Use no others.
Use the theme colors from `docs/plans/09-ui-workflow.md` section 4 (for example `bg-canvas`, `text-ink`, `border-line`, `bg-primary`).
Every AI-extracted row shows a source control, and every tab draws the states in plan 05 section 4.
This folder is never built, type-checked, or linted.

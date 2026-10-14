# Project workflow instructions

## Repository layout

- `design/v0/<screen>/` is the only output location for v0-generated UI. These files are design references and are not part of any build.
- `apps/web/src/ui/` contains trimmed, plain React components copied from `design/v0/` by Claude Code. v0 must not write components here.
- `apps/web/src/features/` contains feature containers and application wiring maintained by Claude Code.
- `docs/plans/` contains the project plans that v0 should read before implementing UI. The current repository also has legacy plan files under `plans/`; prefer `docs/plans/` when both exist.

## v0 rules for this project

1. Read the relevant plan in `docs/plans/` before making UI changes, especially `00-overview.md` and `09-ui-workflow.md`.
2. Create one screen folder per chat under `design/v0/`, using a descriptive name such as `design/v0/compliance-matrix/`.
3. Put every new or updated v0-generated screen and component for that chat inside its screen folder. Do not write v0 output into `apps/web/src/`, `apps/web/src/ui/`, or `apps/web/src/features/`.
4. Keep v0 output presentational and self-contained. Do not add API, database, authentication, worker, or production feature-container code there.
5. Claude Code is responsible for copying and trimming approved components into `apps/web/src/ui/`, then composing them in `apps/web/src/features/`.
6. Preserve the existing app architecture and avoid changing build configuration unless the user explicitly asks for it.

## Current v0 screen

The existing proposal workspace prototype has been moved to `design/v0/proposal-workspace/`.

## Handoff contract

When a v0 chat finishes, report the screen folder containing the generated files and list any components that Claude Code should copy into `apps/web/src/ui/`.

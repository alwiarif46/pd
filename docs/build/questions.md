# Questions log

One heading per chat. Each entry: question, options, choice made, why. Design gaps (BUILD-PLAN s10) go here too, with the screen name and what was invented.

## Chat 1

- **PRs 3 to 6 already merged.** PD #35, #36, #37, #38 are ancestors of master. Options: redo, or skip. Chose skip; nothing left to finish. Open PD PRs #45, #46, #47 are outside chat 1's list and were left alone.
- **Docker daemon not running.** Options: native fallback or wait. Chose native fallback in the session; CI runs Compose.
- **rtk not installable.** Install script URL 404s and the rtk-ai repo is outside the session's GitHub scope. Chose to skip rtk and continue.
- **Superpowers marketplace.** `claude-plugins-official` has no superpowers. Chose `superpowers@superpowers-marketplace`.
- **Branch names.** The session note names `claude/fervent-ramanujan-4voegj`; BUILD-PLAN s6 names `e2e/c<chat>-<nn>-<slug>`. Chose the plan's names (one branch per PR is required by the loop). Asked the owner; unanswered.
- **Hook registration blocked.** Even with `.claude/` writes allowed, the classifier refused `settings.json` with a `SessionStart` hook entry. `settings.json` was written without it; `.claude/hooks/session-start.sh` exists. Owner step: add the `hooks.SessionStart` entry (`bash "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"`). Until then the Proposed check "a new session loads plugins and rtk with no manual steps" is partly unverified.
- **`.claude/` write block.** Lifted by the owner. Only the hook registration (above) remains an owner step, tracked as HUMAN-TODO H-12.

## Chat 2

## Chat 3

## Chat 4

## Chat 5

## Chat 6

## Chat 7

## Chat 8

## Chat 9

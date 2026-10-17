# Questions log

One heading per chat. Each entry: question, options, choice made, why. Design gaps (BUILD-PLAN s10) go here too, with the screen name and what was invented.

## Chat 1

- **PRs 3 to 6 already merged.** PD #35, #36, #37, #38 are ancestors of master. Options: redo, or skip. Chose skip; nothing left to finish. Open PD PRs #45, #46, #47 are outside chat 1's list and were left alone.
- **Docker daemon not running.** Options: native fallback or wait. Chose native fallback in the session; CI runs Compose.
- **rtk not installable.** Install script URL 404s and the rtk-ai repo is outside the session's GitHub scope. Chose to skip rtk and continue.
- **Superpowers marketplace.** `claude-plugins-official` has no superpowers. Chose `superpowers@superpowers-marketplace`.
- **Blocked: writing `.claude/` config.** The auto-mode classifier denied writing `.claude/settings.json` (hooks) and the session hook through both Bash and Write, reason "Self-Modification". BUILD-PLAN s3 and s4 require these files. Not worked around. Needs the owner to allow writes under `.claude/` for this session, or to add the files by hand.

## Chat 2

## Chat 3

## Chat 4

## Chat 5

## Chat 6

## Chat 7

## Chat 8

## Chat 9

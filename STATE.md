# STATE: PD infrastructure build log

Same format as Drive's STATE.md (pluggable hosting, Drive PR #3). Resume rule: read this file, `HUMAN-TODO.md` and
`docs/overnight-questions.md`, then continue from **Current position**. The infra scripts print `STATE.md:` lines for the log table.

## Current position
- Pluggable hosting merged offline (branch `infra/pluggable-hosting`): `[infra] provider` (`ovh-us`, `hetzner`, `ssh`), the
  base-server definition, LUKS volumes and root-disk containers, DNS and `switch-provider.sh`, encrypted Borg backups with a
  B2 copy, the restore drill, the compose data move to `/mnt/pddata`, CI tests, subprocessor naming in the app.
- **Nothing is bought, created or changed at any provider, Cloudflare or Backblaze.** No LUKS format was run. No secrets are in git.
- Production provider is OPEN (HUMAN-TODO H-02, question Q-02); the tenant file defaults to the `ssh` adapter.
- Mirrors Drive PR #3 at commit 5817b11b631eabba4f8b89fe0b95df7632ecb2ad (not merged when this was written): re-check against its head before merging.
- Next: the human steps H-01 to H-10, then a first `infra/provision.sh --dry-run` against the chosen provider.

## Pinned server versions
| Component | Version | Note |
|---|---|---|
| Ubuntu | 24.04 | |
| Docker Engine + compose plugin | from Docker's apt repository | pin after the first install |
| Postgres | 16-alpine (compose) | |
| Borg | Ubuntu 24.04 package | pin after the first install |
| rclone | Ubuntu 24.04 package | pin after the first install |

## Log
| Date | Doc | Step | Status | Note |
|---|---|---|---|---|
| 2026-10-16 | 01 | pluggable hosting (offline) | done | Drive D-146..D-150 mirrored in PD names; all tests run against fakes; see docs/overnight-questions.md |

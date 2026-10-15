# ops/restore-drill

A restore you have never practised is a hope, not a backup. `drill.sh` practises it without touching production.

| File | What it is |
|---|---|
| `drill.sh` | `plan` prints the steps; `run` restores the newest Borg archive into a throwaway `postgres:16-alpine` container (`--network none`) and checks it. |
| `restore-runbook.md` | the real disaster: a new server through any adapter, base system, B2 pull, restore, checks. |

```bash
ops/restore-drill/drill.sh plan
ops/restore-drill/drill.sh run --repo /mnt/pdbackup/borg --borg-pass /etc/pd/borg.pass          # on the server
ops/restore-drill/drill.sh run --from-offsite --rclone-env ~/pd-restore.env --borg-pass ~/borg.pass   # anywhere with docker, borg, rclone
```

`--from-offsite` pulls `b2crypt:borg` with the **read-only restore key** (H-03) into a temp directory first, so it also proves
the B2 copy and the crypt passwords. The run is timed against the 4 h RTO, compares the migration count with
`packages/core/src/db/migrations/meta/_journal.json`, always removes the container (EXIT trap) and shreds its temp files, and
prints a `STATE.md` line.

This differs from Drive's drill on purpose: Drive's creates a short-lived OVH VM (and only works at OVH). PD's drill needs
no provider, so a provider switch (`infra/switch-provider.sh`) rehearses the same restore path (open question Q-14).

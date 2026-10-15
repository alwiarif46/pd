# ops/backup - encrypted database backups with an off-site B2 copy

Mirrors Drive PR #3's backup layout (Borg on the LUKS backup volume, rclone crypt to Backblaze B2) in PD's names.
Design: `docs/plans/01-infrastructure.md` s4. Scripts run on the server, as root.

| File | What it does |
|---|---|
| `infra/scripts/backup.sh` | `pg_dump -Fc` piped into `borg create` (encrypted repo `/mnt/pdbackup/borg`), prune, compact, then `offsite-sync.sh`. `--init` creates the repository. Hourly via `pd-backup.timer`. |
| `infra/scripts/restore.sh` | `--list`, `--archive NAME\|latest --confirm`: safety backup, stop api/worker, recreate the database, roles, `borg extract --stdout \| pg_restore`, start. No file is written to `/tmp`. |
| `offsite-sync.sh` | `rclone sync` of the Borg repository to `b2crypt:borg`, then `pd/last-offsite-ok` LAST. Refuses on the guards listed in its header. |
| `rclone-setup.sh` | renders `/etc/pd/rclone.conf` (no secrets) and writes `/etc/pd/rclone.env` (0600) from hidden prompts. |
| `rclone.conf.template` | remotes `b2` and `b2crypt` (`b2:{{BUCKET}}/{{CRYPT_PREFIX}}`), `hard_delete = false`. |
| `../systemd/pd-backup.{service,timer}.template`, `../install.sh` | the hourly timer. |

## What is backed up

The **database only** (Postgres `pd`, dumped in custom format). Live files under `/mnt/pddata/files` are **not**
backed up (plan 01 s4: users hold the originals). A provider move copies them with `rsync`
(`infra/switch-provider.sh plan`, step 5). Provider backups and snapshots stay off: they would copy the LUKS keyfiles.

- **RPO 1 hour** (hourly dump), **RTO 4 hours** (`ops/restore-drill/drill.sh` times a restore against it).
- Retention: `[backup] borg_retention` in `config/tenant.toml` (default `--keep-within=2d --keep-daily=30`).
- WAL archiving is not built (open question Q-05).

## Single-disk servers (Drive D-147)

With `[infra] storage = "root-container"` (the production default, adapter `ssh`) the Borg repository lives in the
`pdbackup` LUKS container **on the same disk** as the data. Losing the server loses the local repository too, so
**the B2 copy is the only backup that survives losing the server.** Check `pd/last-offsite-ok` in B2 regularly
(`restore-runbook.md` s3) and never treat the local Borg repository as a backup on that setup.

## Setup (all manual steps are human tasks: HUMAN-TODO H-03, H-04)

1. LUKS volumes mounted (`infra/luks/README.md`): `/mnt/pdbackup` must come from `/dev/mapper/pdbackup`.
2. Borg: create `/etc/pd/borg.pass` (root, 0400, a long random passphrase), `sudo infra/scripts/backup.sh --init`,
   put the passphrase and `/etc/pd/borg-key.txt` in the vault, then `shred -u /etc/pd/borg-key.txt` (H-04).
3. B2 (manual in the Backblaze console, H-03): a private bucket `[backup] bucket` with a lifecycle rule for hidden
   files, a **server** application key limited to that bucket and prefix **without `deleteFiles`**, and a
   **read-only restore key** for the drill. There is no B2 API script: the server key could not delete anything, and
   a script holding a master key would defeat that.
4. `sudo ops/backup/rclone-setup.sh` (prompts), `sudo infra/scripts/backup.sh` once by hand, then `sudo ops/install.sh`.

## Follow-up (not built)

Drive's offsite-sync also refuses when too many Borg segments changed in place since the last good sync (a
ransomware guard with a manifest), and its observer key watches the bucket from another host. PD's version
has the mount, empty-source, ratio, hard-delete, remote-name and lock guards only.

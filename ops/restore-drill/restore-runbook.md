# Restore runbook: PD after losing the server

Use this when the production server is gone (or when `infra/switch-provider.sh plan` sends you here). It works the same
for every provider adapter (`ovh-us`, `hetzner`, `ssh`). Practise it with `ops/restore-drill/drill.sh` (a scratch
container, no server needed). Targets: **RPO 1 hour, RTO 4 hours** (`docs/plans/01-infrastructure.md` s4).

What you can restore: the **database** only. Live files under `/mnt/pddata/files` are not in any backup; if the old
server is still reachable, copy them (`rsync`, see `infra/switch-provider.sh plan` step 5), otherwise they are lost and users
re-upload. On a single-disk server (`storage = "root-container"`) the local Borg repository died with the server,
so section 3 (the B2 copy) is the only source.

You need, from the vault (never from git): the Borg passphrase and key export (H-04), the rclone crypt passwords and the
**read-only** B2 restore key (H-03), the LUKS recovery passphrases of the OLD server are not needed (new volumes get new
ones), `/opt/pd/.env` of the old server, the Cloudflare DNS token (H-01).

## 1. A new server

1. Put the provider key into the laptop secrets file (`config/secrets.env.example`) and set `[infra] provider` in a tenant
   file (`config/tenants/*.example.toml`). `infra/switch-provider.sh plan --to <file>` prints the whole checklist.
2. Create or order the server: `infra/provision.sh --confirm-purchase` (the `ssh` adapter only probes a server you ordered
   by hand). Billable: this is a human decision.
3. First boot: created servers run `infra/cloud-init.yaml` themselves; hand-ordered ones need
   `infra/server/bootstrap-existing.sh --confirm`.

## 2. Base system

`sudo infra/scripts/setup-server.sh`, join the admin network (`sudo infra/headscale/server-join.sh`), then the LUKS volumes
(`infra/luks/README.md`: `identify-volumes.sh`, `create-keyfiles.sh`, `format-volumes.sh` after Amaan's go-ahead,
`configure-boot.sh`). New recovery passphrases and header backups go into the vault. Put `/opt/pd/.env` back.

## 3. Get the backup

- **Local repository survived** (a separate backup volume was re-attached): nothing to pull; `/mnt/pdbackup/borg` is there.
- **Otherwise pull the off-site copy** from B2 with the read-only restore key:
  ```bash
  sudo ops/backup/rclone-setup.sh --conf-only          # /etc/pd/rclone.conf (no secrets)
  # put the restore key + crypt passwords in /etc/pd/rclone.env (0600), then:
  sudo rclone --config /etc/pd/rclone.conf copy b2crypt:borg /mnt/pdbackup/borg
  sudo rclone --config /etc/pd/rclone.conf cat b2crypt:pd/last-offsite-ok     # the time of the last complete sync
  ```
  If the sync died half way, the marker's time tells you which B2 version is consistent (`--b2-version-at`).
- Restore `/etc/pd/borg.pass` from the vault (root, 0400).

## 4. Restore the database

```bash
sudo infra/scripts/setup-server.sh        # once, if not done
sudo infra/scripts/deploy.sh              # builds/pulls the images; the migrations create the roles pd_app and pd_system
sudo infra/scripts/restore.sh --list
sudo infra/scripts/restore.sh --archive latest --confirm
```
Then set the `pd_app` password (plan 01 s6: it is not in the dump). `restore.sh` first checks the archive (`latest` is the
newest regular `pd-<time>` archive, never a `-pre-restore` copy; the archive must read back through
`pg_restore --file=/dev/null`, or nothing is touched), takes a safety backup, recreates the database, and streams
`borg extract` into `pg_restore --single-transaction`.

## 5. Checks, then DNS

1. `curl --resolve <domain>:443:<new IPv4> https://<domain>/health -k` (origin certificate; Cloudflare is bypassed).
2. Log in, open a pursuit, check the migrations: `drizzle.__drizzle_migrations` count equals the entries in
   `packages/core/src/db/migrations/meta/_journal.json`.
3. Point DNS: `python infra/dns/cloudflare-dns.py apply --from-provider --tenant <file> --confirm` (proxied records;
   `--confirm` because the existing records change to the new server), then
   `python infra/dns/cloudflare-dns.py check --from-provider --tenant <file>`.
4. `sudo infra/scripts/backup.sh --init` is **not** needed if the repository came back. If the old server can still be
   reached, disable its timer first (`sudo systemctl disable --now pd-backup.timer pd-backup-check.timer`): two servers
   must never sync one B2 prefix. Then run `sudo infra/scripts/backup.sh --adopt-offsite` once by hand (B2's
   `pd/last-offsite-ok` names the old machine, so a plain sync is refused), check that the marker moved and names this
   machine (`machine=` = `/etc/machine-id`), and install the timers: `sudo ops/install.sh`.
5. Log the incident and the restore time in `STATE.md`; update `config/tenant.toml` if the provider changed
   (counsel check for the hosting subprocessor: H-09).

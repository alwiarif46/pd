# Secrets inventory

Same idea as Drive's security/secrets-inventory.md. This file lists **where** each secret lives, never the value.
Nothing in this repository is a secret; the pre-commit secret scan (`.githooks/secret_scan.py`, H-10) and the CI
`test-infra` job look for the common shapes.

Rule: if an admin leaves, rotate every secret they could see within 24 hours.

## PD-only rule

Every credential below is created for PD alone, stored in PD's vault entry and PD's `/etc/pd/`, and rotated
independently. No secret is shared with Drive or with any other Shaavir system (the Headscale pre-auth key is single-use).

| Secret | Where it lives | Who can read it | Notes |
|---|---|---|---|
| Laptop secrets file `C:/projects/secrets/pd.env` | the admin's laptop, never in git | the admin | keys in `config/secrets.env.example`: provider key (`OS_*` / `HCLOUD_TOKEN`), `CLOUDFLARE_DNS_TOKEN` (no B2 key: the server's is in `/etc/pd/rclone.env`); plus `SSH_PUBKEY_PATH` and `ADMIN_IP` (not secret). Scoped keys, not account master keys. |
| `/opt/pd/.env` | the server, root, mode 600; copy in the vault | root | app settings: `POSTGRES_PASSWORD`, `PD_APP_PASSWORD`, API keys of the integrations. Read by docker compose; never printed by `deploy.sh`. |
| `/etc/pd/borg.pass` | the server, root, 0400; copy in the vault | root | Borg repository passphrase, read through `BORG_PASSCOMMAND` only. |
| Borg key export | the vault only (`/etc/pd/borg-key.txt` is shredded after `backup.sh --init`) | admins | needed to open a repository when the key in the repo header is lost with the server |
| `/etc/pd/rclone.env` | the server, root, 0600 | root | B2 **server** key (no `deleteFiles`) and the obscured rclone crypt passwords |
| rclone crypt passwords (plain) | the vault only | admins | without them the B2 copy cannot be read |
| B2 **restore** key (read-only) | the vault only | admins | used by `ops/restore-drill/drill.sh --from-offsite` |
| `/etc/pd/luks/*.key` | the server, root, 0400 (root disk) | root | LUKS keyfiles; why provider backups and snapshots stay off |
| LUKS recovery passphrases and header backups | the vault only | admins | created at `format-volumes.sh`, H-05 |
| `pdadmin` console password | the vault only | admins | H-08 |
| GitHub environment `production` secrets | GitHub | the repository admins | `PD_DEPLOY_HOST`, `PD_DEPLOY_SSH_KEY`, `PD_DEPLOY_KNOWN_HOSTS`, `PD_TS_AUTHKEY`, `PD_TS_LOGIN_SERVER` (H-07) |
| CI deploy key (private half) | GitHub secret `PD_DEPLOY_SSH_KEY` only | CI | its public half is bound to a forced command (`infra/server/deploy-user.sh`) |
| Headscale pre-auth keys | created on the Headscale host, single use, 1 hour | the admin who joins the node | passed to `server-join.sh` through `PD_TS_AUTHKEY` or a hidden prompt, never argv |

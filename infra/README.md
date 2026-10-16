# infra: PD hosting runbook

Pluggable hosting for PD, mirroring Drive PR #3 (`alwiarif46/drive`, branch `providers/pluggable`, commit
5817b11b631eabba4f8b89fe0b95df7632ecb2ad; Drive D-146 to D-150) in PD's names. The design and decisions are in
`docs/plans/01-infrastructure.md` (s9 "Hosting providers"); open questions are in `docs/overnight-questions.md`; the
steps only a person can do are in `HUMAN-TODO.md`.

**Safety rules for everything here:** nothing in the tests contacts a provider, Cloudflare, Backblaze or GHCR (fakes only);
no test runs a LUKS format; `--confirm-purchase` is a billable step and `--confirm` a visible one: both are your decision.

## Layout

| Path | What it is |
|---|---|
| `config/tenant.toml` | the tenant: `[infra] provider = "ovh-us" \| "hetzner" \| "ssh"`, `[infra] storage`, `[infra.hetzner]`, `[infra.ssh]`, `[volumes]`, `[network]`, `[dns]`, `[backup]` |
| `config/tenants/*.example.toml` | a second tenant file per provider, for `switch-provider.sh` |
| `config/secrets.env.example` | the laptop secrets file: the provider key (`OS_*`, `HCLOUD_TOKEN`, none for ssh), Cloudflare, B2 |
| `infra/lib/` | `tenant.sh`/`tenant.py` (tenant + secrets), `provider.sh` (adapters), `ops-common.sh`, `netutil.py`, `fwrender.py`, `openstack.sh` |
| `infra/providers/<name>/` | one adapter: `provider.conf` (KEY=VALUE) and one `<verb>.sh` per verb (`provision`, `addresses`, `firewall-temp-ssh`, `ssh-rules`, `break-glass`, `volume-extend`, `volume-ids`) |
| `infra/provision.sh`, `server-addresses.sh`, `firewall-temp-ssh.sh`, `ssh-rules.sh`, `break-glass.sh`, `volume-extend.sh`, `volume-ids.sh` | provider-neutral entry points: they run the adapter's script |
| `infra/switch-provider.sh` | `plan\|build\|cutover --to NEW.toml`: move a running PD to another provider |
| `infra/cloud-init.yaml`, `render-cloud-init.py` | the one first-boot definition for every provider |
| `infra/server/` | `host-firewall.{nft,sh}` + `pd-host-firewall.service` + `cloudflare-ips.txt`, `bootstrap-existing.sh`, `install-docker.sh`, `deploy-user.sh` |
| `infra/headscale/server-join.sh` | join the admin network with `tag:pd` |
| `infra/luks/` | encrypted volumes and root-disk containers (`README.md`) |
| `infra/dns/cloudflare-dns.py` | proxied A/AAAA records from the provider's addresses |
| `infra/scripts/` | `setup-server.sh`, `deploy.sh`, `backup.sh`, `restore.sh` (run on the server) |
| `ops/backup/`, `ops/restore-drill/`, `ops/install.sh`, `ops/systemd/` | off-site copy, restore drill and runbook, hourly timer |
| `ops/ci/set-exec-bits.sh`, `.githooks/` | executable bits (Drive D-150) and the secret scan |
| `infra/tests/`, `ops/tests/` | offline tests and their fakes |

All scripts take `--dry-run`, `--tenant PATH`, `--secrets PATH` (or `$PD_SECRETS`) and `-h`. Secrets are masked in output
and never appear in argv. Scripts print `STATE.md:` lines for the log table in `STATE.md`.

## Prerequisites (build machine)

- **Git Bash** on Windows (the `bash` in System32 is WSL and does not work for these scripts), or any Linux/macOS shell.
- **Python 3.11+** (`tomllib`); on Windows the Microsoft Store `python3` stub does not count (the scripts look for a working one).
- **PyYAML** (`pip install --user pyyaml`) for `render-cloud-init.py`.
- The **openstack CLI** (`pip install --user python-openstackclient`) only for the `ovh-us` adapter.
- Secrets file `C:/projects/secrets/pd.env` from `config/secrets.env.example` (HUMAN-TODO H-01).

## Runbook (first server)

0. **Offline checks.** `pnpm test:infra` (from Git Bash), `bash ops/ci/set-exec-bits.sh --check`,
   `python .githooks/secret_scan.py --all`. Then `bash infra/provision.sh --dry-run` against your tenant file.
1. **Provision.** Pick the provider in `config/tenant.toml` (H-02). `bash infra/provision.sh --dry-run`, then (a purchase, your
   call) `--confirm-purchase`. The `ssh` adapter only probes a server you ordered by hand.
2. **DNS.** `python infra/dns/cloudflare-dns.py apply --from-provider --dry-run`, then without `--dry-run`. Records are proxied. Creating a record needs nothing more; changing an existing one (another server) needs `--confirm`.
3. **Temporary SSH and the admin network.** `bash infra/firewall-temp-ssh.sh add` (API providers), the first-boot window opens
   from `ADMIN_IP`; for hand-ordered or adopted servers `bash infra/server/bootstrap-existing.sh --confirm`. Join the admin
   network (`sudo infra/headscale/server-join.sh`, H-06), then `bash infra/firewall-temp-ssh.sh remove --check-host <tailnet IP>`.
4. **Base system.** On the server: `sudo infra/scripts/setup-server.sh` (Docker Engine + compose plugin, host firewall check).
5. **Encrypted volumes.** `infra/luks/README.md`: `identify-volumes.sh` (`--root-container` on single-disk servers),
   `create-keyfiles.sh`, `format-volumes.sh` (**ask Amaan first**), `configure-boot.sh`.
6. **Deploy.** Put `/opt/pd/.env` in place, `sudo infra/scripts/deploy.sh`; set the `pd_app` password (plan 01 s6).
7. **Backups.** `sudo infra/scripts/backup.sh --init`, `sudo ops/backup/rclone-setup.sh`, one manual `backup.sh`, `sudo ops/install.sh`
   (H-03, H-04). Practise a restore with `ops/restore-drill/drill.sh`.
8. **Deploy user for CI.** `sudo infra/server/deploy-user.sh --pubkey FILE --confirm`, then the GitHub settings (H-07).

## Switch provider (Drive D-149)

Copy `config/tenants/<name>.example.toml` to `config/tenants/<name>.toml`, fill it in, then
`bash infra/switch-provider.sh plan --to config/tenants/<name>.toml`. `plan` checks that both files share `tenant.id`,
`tenant.domain`, `tenant.hostname`, `backup.bucket` and `backup.crypt_prefix`, and prints the ordered checklist (stop the old
app, backup, build, base system, B2 pull, restore, rsync of the live files, checks, `cutover`). The old server stays stopped for 7 days.

## Testing offline

```bash
pnpm test:infra                         # infra/tests/run-tests.sh && ops/tests/run-tests.sh (Git Bash on Windows)
sudo bash infra/tests/test-root-container.sh   # root + Linux only: container files, loop devices, nft in a namespace (CI runs it)
```
The runners put fakes (`ops/tests/fakes`, `infra/tests/fakes`) first on `PATH`. A fake without the executable bit would let the real
`curl`, `ssh` or `docker` run, so every runner aborts if one is not mode 100755 (Drive D-150): run `ops/ci/set-exec-bits.sh`
after adding files. Cases that need root, `nft`, `losetup` or `shellcheck` print `SKIP` on a machine without them; CI runs them.

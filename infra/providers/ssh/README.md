# infra/providers/ssh - generic SSH host (no provider API)

For any Ubuntu 24.04 machine you can reach as root over SSH: Contabo, another VPS provider, a box in an
office (Drive D-146, D-147). Nothing is ordered or created by these scripts.

| Verb | What it does here |
|---|---|
| `provision` | read-only probe over SSH: OS, free disk, addresses (`--confirm-purchase` runs it; nothing is bought) |
| `addresses` | prints `[infra.ssh] ipv4 ipv6` |
| `break-glass` | prints where the provider's console and rescue are, and the rules |
| `firewall-temp-ssh`, `ssh-rules` | none: there is no provider firewall; the host firewall is the only filter |
| `volume-extend`, `volume-ids` | none: storage is LUKS containers on the root disk (`infra/luks/grow-volume.sh --size`) |

Tenant values (`config/tenant.toml`):

```toml
[infra]
provider = "ssh"
storage  = "root-container"

[infra.ssh]
ipv4           = "203.0.113.10"
ipv6           = "2001:db8::10"          # "" if the provider gives none
bootstrap_user = "root"                  # first login; root SSH is turned off by bootstrap-existing.sh
panel_url      = "https://new.contabo.com"
```

Order: put the admin key on the box (provider panel, or `ssh-copy-id root@IP` once), `infra/provision.sh
--confirm-purchase` (probe), `infra/server/bootstrap-existing.sh --confirm`, DNS, then infra/README.md from
step 4 on (Headscale join). Public SSH stays open only for `[infra] bootstrap_ssh_hours` from ADMIN_IP.

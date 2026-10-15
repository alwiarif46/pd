# infra/luks — encrypted volumes and boot sequence (plan 01)

Scripts only. Keys, header backups and passphrases never enter this repo.

| Order | Script | Doc | Where | Destructive |
|---|---|---|---|---|
| 1 | `identify-volumes.sh --from-provider` (volumes) | | build machine | no |
| 1b | `identify-volumes.sh --root-container` (single disk, D-147: creates `/var/lib/pd/disks/pddata.img`, `pdbackup.img`, writes `volumes.env`) | | server, root | no (creates files only) |
| 2 | `identify-volumes.sh --data-id UUID --backup-id UUID` | | server, root | no (writes `/etc/pd/volumes.env`) |
| 3 | `create-keyfiles.sh` | | server, root | no (never overwrites a key) |
| 4 | `format-volumes.sh --i-understand-this-destroys UUID1 --i-understand-this-destroys UUID2` | | server, root, **terminal** | **yes** (CLAUDE.md conventions rule 6) |
| 5 | `configure-boot.sh` | | server, root | no |
| — | `grow-volume.sh --volume data\|backup` | | server, root | no (grows only) |

All scripts: `--dry-run`, `--tenant PATH`, `-h`; safe to run twice. They source
`infra/lib/tenant.sh` (tenant values) and `infra/lib/ops-common.sh` (logging, file install).
Volume names, sizes and Block Storage classes come from `config/tenant.toml [volumes]`; mapper names and mount
points are fixed constants (`pddata`, `pdbackup`, `/mnt/pddata`, `/mnt/pdbackup`).

## Guards against formatting the wrong thing

1. Devices are only ever addressed by their `/dev/disk/by-id` link named after the OpenStack
   volume UUID (`scsi-0QEMU_QEMU_HARDDISK_<uuid>` on virtio-scsi, `virtio-<first 20 chars>` on
   virtio-blk; *verify* which one OVHcloud uses on the first server); the UUID comes from the
   provider API by volume **name** (`--from-provider`; Hetzner volumes appear as `scsi-0HC_Volume_<id>`), is written once to
   `/etc/pd/volumes.env`, and a different second write is refused.
2. `format-volumes.sh` formats a volume only when its volume UUID is repeated on the
   command line (`--i-understand-this-destroys <id>`), so one confirmation cannot cover both
   volumes and a typo cannot hit the other one.
3. Before `luksFormat` the raw device must have no signature (`blkid -p`, `wipefs --no-act`),
   no mounts/holders, and its first 64 MiB must be zero (a new volume created with
   *format: none* reads as zeros). Anything else stops the script.
4. An existing LUKS header is never reformatted; the keyfile is tested against it
   (`cryptsetup open --test-passphrase`). A mismatch means wrong key or wrong volume: stop.
5. `mkfs.ext4` runs only on a mapper with no signature and only with the same confirmation.

## Boot sequence

```
crypttab  pddata/pdbackup  luks,discard,nofail,headless=true,x-systemd.device-timeout=60s
   │  systemd-cryptsetup@pddata.service (keyfile on root disk)
   ▼
fstab     /dev/mapper/pddata /mnt/pddata ext4 defaults,noatime,nodev,nosuid,noexec,nofail,x-systemd.device-timeout=60
   │  mnt-pddata.mount (wanted by local-fs.target, NOT ordered before it: nofail)
   ▼
docker.service.d/10-require-volumes.conf   RequiresMountsFor=/mnt/pddata /mnt/pdbackup
   │  Requires= + After= both mount units
   ▼
dockerd → docker compose stack (postgres, redis, api, worker, web)
```

Verified against systemd v255 man pages (Ubuntu 24.04 ships systemd 255):

- crypttab `nofail`: "This device will not be a hard dependency of cryptsetup.target … boot
  will not fail if this is unsuccessful … if the device is used for a mount point, the mount
  point itself also needs to have the nofail option". Drive's layout (mirrored here) has `nofail` in both files;
  without it in crypttab the unlock unit is a hard dependency of `cryptsetup.target`, boot
  waits for it and, per the man page, boot fails when it fails, which risks a server that is
  reachable only from the console. Both files carry it.
- crypttab `headless=true`: never ask for a passphrase on the console. A missing or bad
  keyfile then fails fast instead of waiting at a prompt; the operator unlocks by hand with
  the passphrase (break-glass below).
- crypttab/fstab `x-systemd.device-timeout`: how long to wait for the device (60 s, per doc).
- fstab `nofail`: "only wanted, not required, by local-fs.target … not ordered before these
  target units". Boot continues without the volume.
- `RequiresMountsFor=`: "adds dependencies of type Requires= and After= for all mount units
  required to access the specified path". The mount unit exists because of the fstab line;
  `configure-boot.sh` writes both. `systemctl show docker -p RequiresMountsFor` confirms it.

### What happens when…

| Situation | Result |
|---|---|
| Normal boot | volumes unlock → mount → Docker → the compose services come back |
| Volume detached / API problem | cryptsetup waits 60 s, fails; mount fails; boot finishes; SSH over Headscale and the provider's console work; `docker.service` fails with a dependency error; **no container runs** |
| Keyfile missing or corrupt | unlock fails immediately (headless); same as above |
| Something triggers `docker.socket` later | systemd starts `docker.service` again, which again requires the mounts; it fails again |
| Admin runs `systemctl stop mnt-pddata.mount` while Docker runs | `Requires=` propagates the stop: Docker (all containers) stops first |
| Docker forced up without mounts (e.g. `dockerd` by hand, drop-in deleted) | `/mnt/pddata` and `/mnt/pdbackup` are empty directories on the root disk with `chattr +i`: nothing can create files in them, so Postgres, the api and Borg cannot write there; they fail instead of filling the root disk |
| Shutdown | ordering is reversed: Docker stops, then the volumes unmount, then LUKS closes |

The immutable flag is set on the **root-disk directory**, never on the mounted filesystem's
root (that would stop the containers from creating their directories). When a volume is already
mounted, `configure-boot.sh` reaches the root-disk directory through a private,
non-recursive bind of `/` and also refuses to continue if that directory is not empty
(data written there while unmounted).

### Root disk contents (threat model)

LUKS on the volumes protects detached volumes, volume snapshots and decommissioned disks.
The keyfiles are on the root disk (`/etc/pd/luks`, 0400). Postgres, Redis and the uploaded files live on
`/mnt/pddata`, not in Docker named volumes (only the ClamAV signatures stay under `/var/lib/docker`).
Anyone with the root disk has the keys anyway, which is why provider instance backups and snapshots stay **off**
(plan 01; an instance backup or rescue-mode copy of the root disk carries the keyfiles) and why the passphrase keyslot is the recovery path if the root disk is lost.

## Data directory layout

`configure-boot.sh` sets owner and mode on the directories the compose stack bind-mounts (non-recursive):

| Path | Owner / mode | Used by |
|---|---|---|
| `/mnt/pddata` | root, 0755 | mount point |
| `/mnt/pddata/postgres` | root, 0700 | postgres (the image chowns it to its own user on first start) |
| `/mnt/pddata/redis` | root, 0700 | redis (same) |
| `/mnt/pddata/files` | 1000:1000, 0750 | api and worker (`DATA_DIR=/data/files`) |
| `/mnt/pdbackup`, `/mnt/pdbackup/borg` | root, 0700 | the Borg repository (`infra/scripts/backup.sh`) |

## Break-glass: unlock by hand

From the provider's console (`infra/break-glass.sh console`, or the panel named in `infra/providers/<provider>/`; login `pdadmin` + password from the password manager):
```bash
sudo cryptsetup open "$(sudo sed -n 's/^PD_DATA_DEVICE=//p' /etc/pd/volumes.env)" pddata   # prompts: passphrase
sudo systemctl start mnt-pddata.mount
sudo systemctl start docker
```
Lost root disk: build a new server, attach the volumes, unlock with the passphrases,
then re-create keyfiles (`create-keyfiles.sh`) and add them with
`cryptsetup luksAddKey <dev> /etc/pd/luks/pddata.key` (asks for the passphrase).
Damaged header: `cryptsetup luksHeaderRestore <dev> --header-backup-file <file>` with the
header backup from the password manager.

## Root-disk containers (D-147)

`[infra] storage = "root-container"` is for single-disk providers (the `ssh` adapter, the production default; any adapter can use it).
Each role is a preallocated file on the root disk, `/var/lib/pd/disks/<mapper>.img` (root, 0600), with its
own LUKS2 header, keyfile and recovery passphrase. The scripts treat it like a volume whose id is
`container-pddata` / `container-pdbackup`: `format-volumes.sh` runs the same blank checks on the file and needs
`--i-understand-this-destroys container-pddata`; crypttab names the file and systemd-cryptsetup attaches a loop
device; `grow-volume.sh --volume <role> --size <GB>` extends the file (keeping 15 GB free on `/`), refreshes the
loop device, then resizes LUKS and ext4 online. What changes: the local Borg repository shares the disk with the
data, so the off-site B2 copy is the backup that survives a lost server (plan 01 s4, `ops/restore-drill/restore-runbook.md`). Tested
offline: container creation, ownership/mode/symlink guards, blank checks, loop-device "in use" detection,
mapper-on-loop backing check, LUKS2 format of a file (`infra/tests/test-providers.sh`, `infra/tests/test-root-container.sh`); opening it through
dm-crypt is PENDING-LIVE (the test machine has no device-mapper).

**Ask Amaan before any `luksFormat`: no test runs it** (a static guard in `ops/tests/lib.sh` fails the suite if the word appears in a test).


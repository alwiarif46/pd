#!/usr/bin/env bash
# infra/tests/test-root-container.sh - tests for the D-147 root-disk container mode (infra/luks/*) that need root
# on Linux: real preallocated files, ownership/mode checks, loop devices, a dry-run of configure-boot.sh and the
# nftables ruleset in a network namespace. CI runs it with sudo (see .github/workflows/ci.yml).
#
# Prints SKIP and exits 0 when it is not run as root on Linux (this is the normal case on a developer machine).
#
# What it never does (PD safety rule): it never formats, opens, mounts or encrypts anything. There is NO test that
# calls the cryptsetup format command (the Drive case that did is deliberately not ported); format-volumes.sh is
# only run with --dry-run, which performs the blank checks and prints the plan. Loop devices are attached to the
# temp container files only, and detached again in the EXIT trap.
# Usage: sudo bash infra/tests/test-root-container.sh
# shellcheck disable=SC2015  # test harness: A && ok || bad is intentional
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../ops/tests/lib.sh
. "$HERE/../../ops/tests/lib.sh"
if [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]]; then
  skip "root-container suite: needs root on Linux (CI runs it with sudo)"
  summary
  exit $?
fi
harness_init "$(cd "$HERE/../.." && pwd)"
LOOPS=()
cleanup() {
  local l
  for l in ${LOOPS[@]+"${LOOPS[@]}"}; do losetup -d "$l" 2>/dev/null; done
  cleanup_tmp
}
trap cleanup EXIT
guard_fakes
guard_no_luksformat

L="$TMP/luks"; mkdir -p "$L/disks" "$L/keys" "$L/etc"
# tenant files with 1 GB containers (small and fast) and with the production sizes
sed -e 's/^data_size_gb   = .*/data_size_gb   = 1/' -e 's/^backup_size_gb = .*/backup_size_gb = 1/' config/tenant.toml >"$L/tiny.toml"
sed -e 's/^storage        = .*/storage        = "volumes"/' "$L/tiny.toml" >"$L/vol.toml"

lc() { PD_CONTAINER_DIR="$L/disks" bash -c 'die(){ echo "DIE $*"; exit 1; }; warn(){ :; }; is_dry(){ return 1; }; source infra/luks/luks-common.sh; '"$1" 2>&1; }

# ------------------------------------------------------------------ luks_check_dev_path: ownership and mode
umask 077; truncate -s 64M "$L/disks/pddata.img"; chmod 0644 "$L/disks/pddata.img"
o="$(lc 'luks_check_dev_path '"$L"'/disks/pddata.img container-pddata')"
grep -q "DIE .*must be owned by root with mode 0600" <<<"$o" && ok "container file mode 0644 refused" || bad "mode check" "$o"
chmod 0600 "$L/disks/pddata.img"
o="$(lc 'luks_check_dev_path '"$L"'/disks/pddata.img container-pddata && echo FINE')"
[[ "$o" == FINE ]] && ok "root-owned 0600 container accepted" || bad "container ok" "$o"
rm -f "$L/disks/pddata.img"

# ------------------------------------------------------------------ identify-volumes.sh --root-container
export PD_CONTAINER_DIR="$L/disks2" PD_VOLUMES_ENV="$L/volumes.env"
o="$(bash infra/luks/identify-volumes.sh --root-container --tenant "$L/tiny.toml" 2>&1)"; rc=$?
[[ $rc == 0 && -f "$L/disks2/pddata.img" && -f "$L/disks2/pdbackup.img" && "$(stat -c %a:%s "$L/disks2/pddata.img")" == "600:1073741824" ]] \
  && ok "identify --root-container: two 1 GB containers, mode 0600" || bad "identify container" "$o"
grep -q '^PD_STORAGE_MODE=root-container$' "$L/volumes.env" && grep -q "^PD_DATA_DEVICE=$L/disks2/pddata.img$" "$L/volumes.env" && [[ "$(stat -c %a "$L/volumes.env")" == 600 ]] \
  && ok "volumes.env written (mode 0600, paths, storage mode)" || bad "volumes.env" "$(cat "$L/volumes.env")"
printf 'x' | dd of="$L/disks2/pddata.img" bs=1 seek=100 conv=notrunc 2>/dev/null
o="$(bash infra/luks/identify-volumes.sh --root-container --tenant "$L/tiny.toml" 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "exists (kept)" <<<"$o" && [[ "$(dd if="$L/disks2/pddata.img" bs=1 skip=100 count=1 2>/dev/null)" == x ]] \
  && ok "a second run keeps existing containers (never recreated)" || bad "rerun" "$o"
o="$(bash infra/luks/identify-volumes.sh --root-container --tenant config/tenant.toml 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "tenant.toml says 40 GB" <<<"$o" && grep -q "exists (kept)" <<<"$o" && [[ "$(stat -c %s "$L/disks2/pddata.img")" == 1073741824 ]] \
  && ok "bigger tenant sizes only warn: containers are grown by grow-volume.sh, never recreated" || bad "size drift" "$o"
mkdir -p "$L/d3"; ln -s "$L/elsewhere.img" "$L/d3/pddata.img"
o="$(PD_CONTAINER_DIR="$L/d3" PD_VOLUMES_ENV="$L/v3.env" bash infra/luks/identify-volumes.sh --root-container --tenant "$L/tiny.toml" 2>&1)"; rc=$?
[[ $rc != 0 && ! -e "$L/elsewhere.img" ]] && grep -q "not a regular file" <<<"$o" && ok "a dangling symlink in place of a container is refused (no file created at its target)" || bad "dangling symlink" "$o"
ln -s "$L/disks2" "$L/linkdir"
o="$(PD_CONTAINER_DIR="$L/linkdir" PD_VOLUMES_ENV="$L/v4.env" bash infra/luks/identify-volumes.sh --root-container --tenant "$L/tiny.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "is a symlink" <<<"$o" && ok "a symlinked container directory is refused" || bad "symlink dir" "$o"
o="$(bash infra/luks/identify-volumes.sh --root-container --tenant "$L/vol.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "not root-container" <<<"$o" && ok "--root-container refused when the tenant says storage = volumes" || bad "storage mismatch" "$o"

# ------------------------------------------------------------------ format-volumes.sh: dry-run only
o="$(PD_LUKS_KEY_DIR="$L/keys" bash infra/luks/format-volumes.sh --dry-run --only backup 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "Re-run with --i-understand-this-destroys container-pdbackup" <<<"$o" \
  && ok "format-volumes --dry-run: blank checks pass on a fresh container; asks for --i-understand-this-destroys container-pdbackup" || bad "format plan" "$o"
printf 'x' | dd of="$L/disks2/pdbackup.img" bs=1 seek=4096 conv=notrunc 2>/dev/null
o="$(PD_LUKS_KEY_DIR="$L/keys" bash infra/luks/format-volumes.sh --dry-run --only backup 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "first 64 MiB are not all zero" <<<"$o" && ok "format-volumes refuses a container that is not blank" || bad "non-blank" "$o"
dd if=/dev/zero of="$L/disks2/pdbackup.img" bs=1 seek=4096 count=1 conv=notrunc 2>/dev/null

# ------------------------------------------------------------------ loop devices (read-only questions about an attached file)
if command -v losetup >/dev/null 2>&1 && l="$(losetup -f --show "$L/disks2/pdbackup.img" 2>/dev/null)"; then
  LOOPS+=("$l")
  o="$(bash -c 'die(){ echo "DIE $*"; exit 1; }; source infra/luks/luks-common.sh; luks_dev_in_use "$1" && echo INUSE' _ "$L/disks2/pdbackup.img" 2>&1)"
  [[ "$o" == INUSE ]] && ok "an attached container counts as in use (format refuses it)" || bad "in use" "$o"
  o="$(bash -c 'die(){ echo "DIE $*"; exit 1; }; source infra/luks/luks-common.sh; luks_mapper_backing(){ echo '"$l"'; }; luks_mapper_backed_by pdbackup "$1" && echo BACKED' _ "$L/disks2/pdbackup.img" 2>&1)"
  [[ "$o" == BACKED ]] && ok "mapper-on-loop recognised as backed by its container file" || bad "backed_by" "$o"
  o="$(bash -c 'die(){ echo "DIE $*"; exit 1; }; source infra/luks/luks-common.sh; luks_mapper_backing(){ echo '"$l"'; }; luks_mapper_backed_by pddata "$1" || echo NOT' _ "$L/disks2/pddata.img" 2>&1)"
  [[ "$o" == NOT ]] && ok "a mapper on the other container's loop is NOT accepted (no cross-wiring)" || bad "backed_by other" "$o"
else
  skip "loop-device checks (losetup unavailable or no free loop device here)"
fi
unset PD_CONTAINER_DIR PD_VOLUMES_ENV

# ------------------------------------------------------------------ configure-boot.sh --dry-run with temp crypttab / fstab
: >"$L/crypttab"; : >"$L/fstab"
o="$(CRYPTTAB="$L/crypttab" FSTAB="$L/fstab" PD_VOLUMES_ENV="$L/none.env" bash infra/luks/configure-boot.sh --dry-run --tenant "$L/tiny.toml" 2>&1)"; rc=$?
if [[ $rc == 0 ]]; then
  grep -q "pddata  */var/lib/pd/disks/pddata.img" <<<"$o" && grep -q "luks,discard,nofail,headless=true,x-systemd.device-timeout=60s" <<<"$o" \
    && ok "configure-boot --dry-run: the crypttab line names the container file with the boot options" || bad "crypttab line" "$o"
  grep -q "RequiresMountsFor=/mnt/pddata /mnt/pdbackup" <<<"$o" && ok "configure-boot --dry-run: Docker drop-in requires both mounts" || bad "drop-in" "$o"
  grep -q "install -d -m 0750 -o 1000 -g 1000 /mnt/pddata/files" <<<"$o" && ok "configure-boot --dry-run: files/ directory for uid 1000, postgres/ and redis/ for their images" || bad "data dirs" "$o"
else
  bad "configure-boot --dry-run" "rc=$rc $(tail -5 <<<"$o")"
fi

# ------------------------------------------------------------------ the nftables ruleset in a network namespace
if command -v nft >/dev/null 2>&1 && command -v unshare >/dev/null 2>&1; then
  bash infra/server/host-firewall.sh render >"$L/fw.nft" 2>"$L/fw.err" || bad "render for the nft test" "$(cat "$L/fw.err")"
  if unshare -n nft -c -f "$L/fw.nft" >/dev/null 2>&1; then
    unshare -n sh -c "nft -f '$L/fw.nft' && nft -f '$L/fw.nft' && nft add element inet pd_fw bootstrap_ssh4 '{ 203.0.113.9 timeout 1h }' && nft list table inet pd_fw" >"$L/nft.txt" 2>&1 \
      && grep -q 'policy drop' "$L/nft.txt" && ok "rendered ruleset loads twice in nft (netns); the timed bootstrap element is accepted" || bad "nft load" "$(cat "$L/nft.txt")"
    grep -q 'ip daddr 169.254.169.254' "$L/nft.txt" && grep -q 'reject' "$L/nft.txt" && grep -q '@cloudflare4' "$L/nft.txt" && ! grep -qE 'dport (\{ *)?80\b' "$L/nft.txt" \
      && ok "metadata service rules present, 443 from the Cloudflare sets, no port 80" || bad "nft rules" "$(cat "$L/nft.txt")"
    if command -v iptables-nft >/dev/null 2>&1; then
      unshare -n sh -c "iptables-nft -N DOCKER-USER && iptables-nft -A FORWARD -j DOCKER-USER && nft -f '$L/fw.nft' && nft list tables" >"$L/nft2.txt" 2>&1 \
        && grep -q 'table ip filter' "$L/nft2.txt" && grep -q 'table inet pd_fw' "$L/nft2.txt" && ok "loads beside an iptables-nft (Docker-style) filter table" || skip "iptables-nft coexistence ($(head -1 "$L/nft2.txt"))"
    fi
  else
    skip "nft ruleset test (nft cannot run in a network namespace here)"
  fi
else
  skip "nft ruleset test (nft or unshare missing)"
fi

summary

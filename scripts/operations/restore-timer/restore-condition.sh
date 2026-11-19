#!/usr/bin/env bash
# systemd ExecCondition: 1 skips ExecStart, 0 requests the ordinary restore.
set -euo pipefail
if [[ ${1:-} != --proof ]]; then
  [[ ${TRIGGER_UNIT:-} == grabenplaner-offsite-restore-test.timer ]] || exit 0
  # Isolate every failure of the optional check (including helpers using
  # "exit 1"). Only its *success* may become a systemd skip.
  if /bin/bash "${BASH_SOURCE[0]}" --proof; then exit 1; fi
  echo "Kein passender vollständiger Nachweis. Reguläre Wiederherstellungsprüfung folgt."
  exit 0
fi

umask 077
[[ ${TRIGGER_TIMER_REALTIME_USEC:-} =~ ^[0-9]{15,17}$ ]]
source /opt/grabenplaner-offsite/module/lib/offsite-common.sh
offsite_require_root
# Same order as the nightly. Read its final signed result after both locks,
# including when the standalone timer arrived during snapshot preparation.
offsite_acquire_assurance_lock
offsite_acquire_repository_lock
nightly=grabenplaner-offsite-assurance@scheduled-nightly.service
[[ $(systemctl show "$nightly" -p ActiveState --value) == inactive ]]
[[ $(systemctl show "$nightly" -p Result --value) == success ]]
offsite_assert_runtime_binaries
op=$(mktemp -d)
credentials=""
cleanup() {
  [[ -z "$credentials" ]] || offsite_remove_uploader_credentials "$credentials"
  rm -f -- "$op/config" "$op/snapshots" "$op/selected"
  rmdir -- "$op"
}
trap cleanup EXIT
credentials=$(offsite_make_uploader_credentials "$(offsite_credentials_directory)")
offsite_verify_repository_identity "$credentials" "$op/config"
host=$(offsite_installation_host "$credentials")
offsite_restic "$credentials" snapshots --json --host "$host" --tag grabenplaner-offsite \
  --path "$OFFSITE_STAGE_CURRENT" >"$op/snapshots"
"$OFFSITE_NODE" "$OFFSITE_APP_ROOT/server-tools/linux/recovery/lib/recovery-metadata.js" \
  select-latest "$op/snapshots" "$host" "$OFFSITE_STAGE_CURRENT" >"$op/selected"
"$OFFSITE_NODE" --no-global-search-paths "$(dirname -- "${BASH_SOURCE[0]}")/restore-proof.cjs" \
  "$op/selected" "$TRIGGER_TIMER_REALTIME_USEC"

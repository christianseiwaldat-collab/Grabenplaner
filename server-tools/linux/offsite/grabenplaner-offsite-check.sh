#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

lock_already_held=0
while (($#)); do
  case "$1" in
    --lock-already-held) lock_already_held=1; shift ;;
    -h|--help)
      printf '%s\n' "Verwendung: sudo grabenplaner-offsite-check [--lock-already-held]"
      exit 0
      ;;
    *) offsite_die "Unbekannte Option." ;;
  esac
done

offsite_require_root
for command_name in awk flock mktemp rm runuser sha256sum stat; do offsite_require_command "$command_name"; done
offsite_assert_runtime_binaries
system_credentials="$(offsite_credentials_directory)"
uploader_credentials="$(offsite_make_uploader_credentials "$system_credentials")"
offsite_assert_persistent_rclone_config
operation_root="$(mktemp --directory --tmpdir="$OFFSITE_STATE_ROOT" .check.XXXXXXXX)"
chmod 0700 -- "$operation_root"
cleanup() {
  rm -rf --one-file-system -- "$operation_root" 2>/dev/null || true
  offsite_remove_uploader_credentials "$uploader_credentials" 2>/dev/null || true
}
trap cleanup EXIT
if (( lock_already_held == 1 )); then
  offsite_assert_inherited_repository_lock
else
  offsite_acquire_repository_lock
fi

if ! offsite_verify_repository_identity "$uploader_credentials" "$operation_root/repository-config.json"; then
  offsite_fixed_failure FULL_CHECK_REPOSITORY_ID_MISMATCH "Die Identitaet des Offsite-Repositorys konnte fuer die Vollpruefung nicht bestaetigt werden."
fi
if ! offsite_restic "$uploader_credentials" check --read-data >"$operation_root/check.out" 2>"$operation_root/check.error"; then
  offsite_fixed_failure FULL_CHECK_FAILED "Die vollstaendige Offsite-Datenpruefung ist fehlgeschlagen."
fi
offsite_status full-check >/dev/null
offsite_info "Die monatliche vollstaendige Offsite-Datenpruefung war erfolgreich."

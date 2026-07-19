#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

offsite_require_root
for command_name in awk flock mktemp rm runuser sha256sum stat; do offsite_require_command "$command_name"; done
offsite_assert_runtime_binaries
system_credentials="$(offsite_credentials_directory)"
uploader_credentials="$(offsite_make_uploader_credentials "$system_credentials")"
offsite_assert_persistent_rclone_config
installation_host="$(offsite_installation_host "$uploader_credentials")"
restore_root="$(mktemp --directory --tmpdir="$OFFSITE_RESTORE_ROOT" .restore.XXXXXXXX)"
operation_root="$(mktemp --directory --tmpdir="$OFFSITE_STATE_ROOT" .restore-operation.XXXXXXXX)"
chown "$OFFSITE_USER:$OFFSITE_GROUP" -- "$restore_root"
chmod 0700 -- "$restore_root" "$operation_root"
cleanup() {
  rm -rf --one-file-system -- "$restore_root" "$operation_root" 2>/dev/null || true
  offsite_remove_uploader_credentials "$uploader_credentials" 2>/dev/null || true
}
trap cleanup EXIT
offsite_acquire_repository_lock

if ! offsite_verify_repository_identity "$uploader_credentials" "$operation_root/repository-config.json"; then
  offsite_fixed_failure RESTORE_TEST_REPOSITORY_ID_MISMATCH "Die Identitaet des Offsite-Repositorys konnte fuer den Restore-Test nicht bestaetigt werden."
fi
if ! offsite_restic "$uploader_credentials" restore latest --host "$installation_host" --tag grabenplaner-offsite \
  --path "$OFFSITE_STAGE_CURRENT" --target "$restore_root" >"$operation_root/restore.out" 2>"$operation_root/restore.error"; then
  offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
fi
restored_stage="$restore_root${OFFSITE_STAGE_CURRENT}"
[[ -d "$restored_stage" && ! -L "$restored_stage" ]] \
  || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
"$OFFSITE_NODE" "$OFFSITE_MODULE_ROOT/lib/offsite-restore-verify.js" \
  "$restored_stage" "$OFFSITE_STAGE_HELPER" \
  "$OFFSITE_APP_ROOT/server-tools/linux/lib/verify-backup.js" "$OFFSITE_APP_ROOT/lib/amu-storage.js" "$OFFSITE_APP_ENV" >/dev/null 2>&1 \
  || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
offsite_status restore-test >/dev/null
offsite_info "Der quartalsweise isolierte Offsite-Wiederherstellungstest war erfolgreich."

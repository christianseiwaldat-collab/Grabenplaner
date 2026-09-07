#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

backup_result=""
lock_already_held=0
while (($#)); do
  case "$1" in
    --backup-result) backup_result="${2:?Wert fehlt}"; shift 2 ;;
    --lock-already-held) lock_already_held=1; shift ;;
    *) offsite_die "Unbekannte Option: $1" ;;
  esac
done
offsite_require_root
[[ -n "$backup_result" && "$lock_already_held" -eq 1 ]] || offsite_die "Der Update-Hook benoetigt den exakten Backupbeleg und die bereits gehaltene Wartungssperre."
for command_name in awk flock runuser sha256sum stat; do offsite_require_command "$command_name"; done
offsite_assert_runtime_binaries
offsite_acquire_repository_lock
"$OFFSITE_MODULE_ROOT/grabenplaner-offsite-prepare.sh" --backup-result "$backup_result" --lock-already-held --repository-lock-already-held
"$OFFSITE_MODULE_ROOT/grabenplaner-offsite-upload.sh" --credentials-source "$OFFSITE_CONFIG_ROOT" --lock-already-held \
  || offsite_fixed_failure UPLOAD_FAILED "Die verschluesselte Offsite-Sicherung konnte nicht uebertragen werden."
offsite_info "Der Sicherungspunkt vor dem Update wurde extern bestaetigt."

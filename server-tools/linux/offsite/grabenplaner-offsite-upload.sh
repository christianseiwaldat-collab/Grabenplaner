#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

credentials_source=""
lock_already_held=0
while (($#)); do
  case "$1" in
    --credentials-source) credentials_source="${2:?Wert fehlt}"; shift 2 ;;
    --lock-already-held) lock_already_held=1; shift ;;
    *) offsite_die "Unbekannte Option: $1" ;;
  esac
done
offsite_require_root
for command_name in awk flock mktemp rm runuser sha256sum stat; do offsite_require_command "$command_name"; done
offsite_assert_runtime_binaries
[[ -d "$OFFSITE_STAGE_CURRENT" && ! -L "$OFFSITE_STAGE_CURRENT" ]] \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
"$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" verify "$OFFSITE_STAGE_CURRENT" >/dev/null 2>&1 \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."

if [[ -n "$credentials_source" ]]; then
  [[ "$credentials_source" == "$OFFSITE_CONFIG_ROOT" && "$lock_already_held" -eq 1 ]] \
    || offsite_die "Direkte Credentials sind nur fuer den bereits gesperrten Update-Hook erlaubt."
  system_credentials="$OFFSITE_CONFIG_ROOT"
else
  system_credentials="$(offsite_credentials_directory)"
fi
uploader_credentials="$(offsite_make_uploader_credentials "$system_credentials")"
offsite_assert_persistent_rclone_config
installation_host="$(offsite_installation_host "$uploader_credentials")"
operation_root="$(mktemp --directory --tmpdir="$OFFSITE_STATE_ROOT" .upload.XXXXXXXX)"
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
offsite_status attempt >/dev/null
repository_config="$operation_root/repository-config.json"
if ! offsite_verify_repository_identity "$uploader_credentials" "$repository_config"; then
  offsite_fixed_failure REPOSITORY_ID_MISMATCH "Das Offsite-Repository stimmt nicht mit der eingerichteten Identitaet ueberein."
fi

backup_output="$operation_root/backup.jsonl"
backup_error="$operation_root/backup.error"
if ! offsite_restic "$uploader_credentials" backup --json --host "$installation_host" --tag grabenplaner-offsite --tag daily \
  -- "$OFFSITE_STAGE_CURRENT" >"$backup_output" 2>"$backup_error"; then
  offsite_fixed_failure UPLOAD_FAILED "Die verschluesselte Offsite-Sicherung konnte nicht uebertragen werden."
fi
snapshot_id="$("$OFFSITE_NODE" - "$backup_output" <<'NODE'
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean);
let snapshot = "";
for (const line of lines) {
  let value;
  try { value = JSON.parse(line); } catch { continue; }
  if (value.message_type === "summary" && /^[a-f0-9]{64}$/i.test(String(value.snapshot_id || ""))) snapshot = String(value.snapshot_id).toLowerCase();
}
if (!snapshot) process.exit(1);
process.stdout.write(snapshot);
NODE
)" || offsite_fixed_failure SNAPSHOT_VERIFY_FAILED "Der uebertragene Offsite-Sicherungspunkt konnte nicht eindeutig bestaetigt werden."
[[ "$snapshot_id" =~ ^[a-f0-9]{64}$ ]] \
  || offsite_fixed_failure SNAPSHOT_VERIFY_FAILED "Der uebertragene Offsite-Sicherungspunkt konnte nicht eindeutig bestaetigt werden."

snapshot_output="$operation_root/snapshots.json"
if ! offsite_restic "$uploader_credentials" snapshots --json "$snapshot_id" >"$snapshot_output" 2>"$operation_root/snapshots.error"; then
  offsite_fixed_failure SNAPSHOT_VERIFY_FAILED "Der uebertragene Offsite-Sicherungspunkt konnte nicht eindeutig bestaetigt werden."
fi
"$OFFSITE_NODE" - "$snapshot_output" "$snapshot_id" <<'NODE' >/dev/null \
  || offsite_fixed_failure SNAPSHOT_VERIFY_FAILED "Der uebertragene Offsite-Sicherungspunkt konnte nicht eindeutig bestaetigt werden."
const fs = require("node:fs");
const values = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = process.argv[3];
if (!Array.isArray(values) || values.length !== 1 || String(values[0]?.id || "").toLowerCase() !== expected) process.exit(1);
NODE

if ! offsite_restic "$uploader_credentials" check >"$operation_root/check.out" 2>"$operation_root/check.error"; then
  offsite_fixed_failure REPOSITORY_CHECK_FAILED "Die Offsite-Repository-Pruefung ist fehlgeschlagen."
fi

retention=(--host "$installation_host" --tag grabenplaner-offsite --path "$OFFSITE_STAGE_CURRENT" \
  --keep-daily "$OFFSITE_RETENTION_DAILY" --keep-weekly "$OFFSITE_RETENTION_WEEKLY" --keep-monthly "$OFFSITE_RETENTION_MONTHLY")
if ! offsite_restic "$uploader_credentials" forget --json --dry-run "${retention[@]}" >"$operation_root/forget-dry.json" 2>"$operation_root/forget-dry.error"; then
  offsite_fixed_failure RETENTION_FAILED "Die Offsite-Aufbewahrung konnte nicht sicher angewendet werden."
fi
"$OFFSITE_NODE" "$OFFSITE_MODULE_ROOT/lib/offsite-retention-verify.js" \
  "$operation_root/forget-dry.json" "$snapshot_id" "$installation_host" "$OFFSITE_STAGE_CURRENT" >/dev/null 2>&1 \
  || offsite_fixed_failure RETENTION_FAILED "Die Offsite-Aufbewahrung konnte nicht sicher angewendet werden."
if ! offsite_restic "$uploader_credentials" forget --prune "${retention[@]}" >"$operation_root/forget.out" 2>"$operation_root/forget.error"; then
  offsite_fixed_failure RETENTION_FAILED "Die Offsite-Aufbewahrung konnte nicht sicher angewendet werden."
fi
if ! offsite_restic "$uploader_credentials" check >"$operation_root/post-check.out" 2>"$operation_root/post-check.error"; then
  offsite_fixed_failure REPOSITORY_CHECK_FAILED "Die Offsite-Repository-Pruefung ist fehlgeschlagen."
fi

offsite_status success --snapshot "$snapshot_id" >/dev/null
rm -rf --one-file-system -- "$OFFSITE_STAGE_CURRENT"
offsite_info "Offsite-Sicherung, Repository-Pruefung und Aufbewahrung 14/8/12 wurden bestaetigt."

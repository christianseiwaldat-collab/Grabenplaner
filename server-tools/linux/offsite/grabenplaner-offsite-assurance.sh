#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

core_common="$OFFSITE_APP_ROOT/server-tools/linux/lib/common.sh"
[[ -f "$core_common" && ! -L "$core_common" ]] \
  || offsite_die "Die verifizierte Core-Wartungssperre fehlt."
# shellcheck source=server-tools/linux/lib/common.sh
source "$core_common"

trigger=""
while (($#)); do
  case "$1" in
    --trigger) trigger="${2:?Wert fuer --trigger fehlt}"; shift 2 ;;
    -h|--help)
      printf '%s\n' "Verwendung: sudo grabenplaner-offsite-assurance --trigger AUSLOESER"
      exit 0
      ;;
    *) offsite_die "Unbekannte Option." ;;
  esac
done

case "$trigger" in
  scheduled-weekly|oauth-config-changed|offsite-config-changed|binary-changed|offsite-module-changed|app-updated|server-updated|manual-cli|manual-admin-ui) ;;
  *) offsite_die "Der Recovery-Assurance-Ausloeser ist nicht freigegeben." ;;
esac

offsite_require_root
for command_name in awk flock getent install mktemp readlink rm sha256sum stat; do
  offsite_require_command "$command_name"
done
[[ -x "$OFFSITE_NODE" ]] || offsite_die "Die freigegebene Node.js-Laufzeit fehlt."
offsite_prepare_run_root

# Der Lauf wartet kontrolliert auf Updates oder Backups und haelt danach den
# gesamten App-/Backupstand stabil. FD 6 bleibt bewusst von Repository- (8),
# Core- (9) und Assurance-Sperre (7) getrennt.
maintenance_lock="$(gp_safe_absolute_path "$GP_DEFAULT_MAINTENANCE_LOCK" "Wartungssperre")"
gp_prepare_runtime_directory "$(dirname -- "$maintenance_lock")" >/dev/null
if [[ -e "$maintenance_lock" || -L "$maintenance_lock" ]]; then
  [[ -f "$maintenance_lock" && ! -L "$maintenance_lock" \
    && "$(stat --format='%u:%g' -- "$maintenance_lock")" == "0:0" ]] \
    || offsite_die "Die Core-Wartungssperre ist unsicher."
  chmod 0600 -- "$maintenance_lock"
else
  install -m 0600 -o root -g root /dev/null "$maintenance_lock"
fi
exec 6<>"$maintenance_lock"
flock --wait 14400 6 \
  || offsite_die "Eine laufende Grabenplaner-Wartung konnte nicht innerhalb des Wartungsfensters abgeschlossen werden."
offsite_acquire_assurance_lock
offsite_assert_runtime_binaries

operation_root="$(mktemp --directory --tmpdir="$OFFSITE_RUN_ROOT" assurance.XXXXXXXX)"
chown root:root -- "$operation_root"
chmod 0700 -- "$operation_root"
restore_result="$operation_root/restore-result.json"
run_id="$($OFFSITE_NODE -e 'process.stdout.write(require("node:crypto").randomUUID())')"
app_version="$($OFFSITE_NODE - "$OFFSITE_APP_ROOT/package.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const version = String(value?.version || "");
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) process.exit(1);
process.stdout.write(version);
NODE
)" || offsite_die "Die installierte App-Version ist ungueltig."

started=0
completed=0
failure_code="ASSURANCE_RUN_FAILED"
snapshot_prefix=""
receipt_sha256=""

record_event() {
  local event_type="$1"
  shift
  offsite_assurance_history record --event-type "$event_type" --run-id "$run_id" \
    --trigger "$trigger" --app-version "$app_version" "$@" >/dev/null
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if (( started == 1 && completed == 0 )); then
    record_event full-assurance-failed --error-code "$failure_code" >/dev/null 2>&1 || true
  fi
  rm -rf --one-file-system -- "$operation_root" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

offsite_assurance_history inspect >/dev/null \
  || offsite_die "Der signierte Recovery-Assurance-Verlauf ist nicht sicher lesbar."
record_event full-assurance-started
started=1

failure_code="CONFIGURATION_VERIFY_FAILED"
credentials_source="$(offsite_credentials_directory)"
offsite_assert_dedicated_rclone_oauth "$credentials_source"
record_event oauth-policy-passed

failure_code="PREPARE_FAILED"
"$OFFSITE_MODULE_ROOT/grabenplaner-offsite-prepare.sh" --lock-already-held

# Ab der Uebertragung bleibt das Repository bis einschliesslich Vollpruefung
# und isoliertem Restore auf exakt demselben Stand. Die Child-Skripte duerfen
# FD 8 nicht erneut oeffnen, weil sie sonst gegen den wartenden Parent
# deadlocken wuerden.
offsite_acquire_repository_lock
failure_code="UPLOAD_FAILED"
"$OFFSITE_MODULE_ROOT/grabenplaner-offsite-upload.sh" --lock-already-held
snapshot_prefix="$($OFFSITE_NODE - "$OFFSITE_APP_ROOT/lib/offsite-backup-status.js" "$OFFSITE_STATUS_FILE" <<'NODE'
const { readOffsiteBackupStatus } = require(process.argv[2]);
const status = readOffsiteBackupStatus({ configured: true, statusPath: process.argv[3], requireRootOwner: true });
if (!status.statusAvailable || !/^[a-f0-9]{12}$/.test(String(status.lastSnapshotId || ""))) process.exit(1);
process.stdout.write(status.lastSnapshotId);
NODE
)" || offsite_die "Der Assurance-Snapshotnachweis ist nicht sicher lesbar."
record_event backup-passed --snapshot-prefix "$snapshot_prefix"

failure_code="FULL_CHECK_FAILED"
"$OFFSITE_MODULE_ROOT/grabenplaner-offsite-check.sh" --lock-already-held
record_event repository-check-passed --snapshot-prefix "$snapshot_prefix"

failure_code="RESTORE_TEST_FAILED"
"$OFFSITE_MODULE_ROOT/grabenplaner-offsite-restore-test.sh" --lock-already-held --assurance-result "$restore_result"
readarray -t restore_evidence < <("$OFFSITE_NODE" - "$restore_result" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const before = fs.lstatSync(file);
if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > 1024) process.exit(1);
const value = JSON.parse(fs.readFileSync(file, "utf8"));
if (Object.keys(value).sort().join(",") !== "receiptSha256,snapshotIdPrefix"
  || !/^[a-f0-9]{12}$/.test(String(value.snapshotIdPrefix || ""))
  || !/^[a-f0-9]{64}$/.test(String(value.receiptSha256 || ""))) process.exit(1);
process.stdout.write(`${value.snapshotIdPrefix}\n${value.receiptSha256}\n`);
NODE
) || offsite_die "Der Restore-Testnachweis ist nicht sicher lesbar."
(( ${#restore_evidence[@]} == 2 )) || offsite_die "Der Restore-Testnachweis ist unvollstaendig."
[[ "${restore_evidence[0]}" == "$snapshot_prefix" ]] \
  || offsite_die "Backup- und Restore-Testnachweis beziehen sich nicht auf denselben Snapshot."
receipt_sha256="${restore_evidence[1]}"
record_event restore-test-passed --snapshot-prefix "$snapshot_prefix" --receipt-sha256 "$receipt_sha256"

# v0.76 dokumentiert diese Grenze ausdruecklich. Der nebenwirkungsfreie,
# isolierte App-Start folgt erst mit dem spaeteren vollautomatischen RAS-Ausbau.
record_event application-smoke-not-run --snapshot-prefix "$snapshot_prefix" --receipt-sha256 "$receipt_sha256"
record_event full-assurance-passed --snapshot-prefix "$snapshot_prefix" --receipt-sha256 "$receipt_sha256"
completed=1
offsite_info "Der signierte Recovery-Assurance-Lauf wurde erfolgreich abgeschlossen."

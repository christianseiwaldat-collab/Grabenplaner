#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

readonly RECOVERY_HELPER_ROOT="$OFFSITE_APP_ROOT/server-tools/linux/recovery/lib"
readonly RECOVERY_METADATA="$RECOVERY_HELPER_ROOT/recovery-metadata.js"
readonly RECOVERY_VERIFY="$RECOVERY_HELPER_ROOT/recovery-verify.js"
readonly RECOVERY_INTEGRATION_MODULE="$OFFSITE_APP_ROOT/lib/integration-secret-vault.js"
readonly RECOVERY_DATABASE_LOCK_MODULE="$OFFSITE_APP_ROOT/lib/database-lock.js"
readonly RECOVERY_TARGET_PACKAGE="$OFFSITE_APP_ROOT/package.json"
readonly RECOVERY_TARGET_RUNTIME="$OFFSITE_APP_ROOT/server-tools/linux/runtime-schema.json"

assurance_result=""
lock_already_held=0
while (($#)); do
  case "$1" in
    --assurance-result) assurance_result="${2:?Wert fuer --assurance-result fehlt}"; shift 2 ;;
    --lock-already-held) lock_already_held=1; shift ;;
    -h|--help)
      printf '%s\n' "Verwendung: sudo grabenplaner-offsite-restore-test [--lock-already-held] [--assurance-result PFAD]"
      exit 0
      ;;
    *) offsite_die "Unbekannte Option." ;;
  esac
done
[[ -z "$assurance_result" || "$lock_already_held" -eq 1 ]] \
  || offsite_die "Ein Assurance-Ergebnispfad ist nur innerhalb der uebernommenen Repository-Sperre erlaubt."

offsite_require_root
# Ab diesem Punkt darf kein alter erfolgreicher Quartalsstatus mehr sichtbar
# bleiben. Der geschuetzte Statuspfad wird bewusst vor dem restlichen
# Preflight auf "fehlgeschlagen/offen" gesetzt.
offsite_status failure --code RESTORE_TEST_FAILED --summary "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen." >/dev/null \
  || offsite_die "Der Restore-Teststatus konnte nicht sicher begonnen werden."
started_at="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
for command_name in awk chown chmod cp df dirname find flock getent grep install mktemp readlink realpath rm runuser sha256sum stat sync systemctl tail tr; do
  offsite_require_command "$command_name"
done

if [[ -n "$assurance_result" ]]; then
  assurance_result="$(realpath --canonicalize-missing -- "$assurance_result")" \
    || offsite_die "Der Assurance-Ergebnispfad ist ungueltig."
  assurance_parent="$(dirname -- "$assurance_result")"
  [[ "$assurance_result" == "$OFFSITE_RUN_ROOT/assurance."*/restore-result.json \
    && -d "$assurance_parent" && ! -L "$assurance_parent" \
    && "$(stat --format='%u:%g:%a' -- "$assurance_parent")" == "0:0:700" \
    && ! -e "$assurance_result" && ! -L "$assurance_result" ]] \
    || offsite_die "Der Assurance-Ergebnispfad ist nicht freigegeben."
fi
offsite_assert_runtime_binaries
for helper in "$RECOVERY_METADATA" "$RECOVERY_VERIFY" "$RECOVERY_INTEGRATION_MODULE" \
  "$RECOVERY_DATABASE_LOCK_MODULE" "$RECOVERY_TARGET_PACKAGE" "$RECOVERY_TARGET_RUNTIME"; do
  [[ -f "$helper" && ! -L "$helper" ]] \
    || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
done

system_credentials="$(offsite_credentials_directory)"
uploader_credentials="$(offsite_make_uploader_credentials "$system_credentials")"
offsite_assert_persistent_rclone_config
installation_host="$(offsite_installation_host "$uploader_credentials")"
restore_root="$(mktemp --directory --tmpdir="$OFFSITE_RESTORE_ROOT" .restore.XXXXXXXX)"
operation_root="$(mktemp --directory --tmpdir="$OFFSITE_STATE_ROOT" .restore-operation.XXXXXXXX)"
receipt_root="$OFFSITE_RESTORE_ROOT/receipts"
restore_test_complete=0
smoke_root_owned=0
chown "$OFFSITE_USER:$OFFSITE_GROUP" -- "$restore_root"
chmod 0700 -- "$restore_root" "$operation_root"
cleanup() {
  local status=$?
  systemctl stop "$OFFSITE_SMOKE_SERVICE" >/dev/null 2>&1 || true
  systemctl reset-failed "$OFFSITE_SMOKE_SERVICE" >/dev/null 2>&1 || true
  if (( smoke_root_owned == 1 )) && [[ -d "$OFFSITE_SMOKE_ROOT" && ! -L "$OFFSITE_SMOKE_ROOT" ]]; then
    rm -rf --one-file-system -- "$OFFSITE_SMOKE_ROOT" 2>/dev/null || true
  fi
  chown root:root -- "$restore_root" 2>/dev/null || true
  chmod 0700 -- "$restore_root" 2>/dev/null || true
  if (( restore_test_complete == 0 )); then
    offsite_status failure --code RESTORE_TEST_FAILED --summary "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen." >/dev/null 2>&1 || true
  fi
  rm -rf --one-file-system -- "$restore_root" "$operation_root" 2>/dev/null || true
  offsite_remove_uploader_credentials "$uploader_credentials" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
if (( lock_already_held == 1 )); then
  offsite_assert_inherited_repository_lock
else
  offsite_acquire_repository_lock
fi

if ! offsite_verify_repository_identity "$uploader_credentials" "$operation_root/repository-config.json"; then
  offsite_fixed_failure RESTORE_TEST_REPOSITORY_ID_MISMATCH "Die Identitaet des Offsite-Repositorys konnte fuer den Restore-Test nicht bestaetigt werden."
fi
if ! offsite_restic "$uploader_credentials" snapshots --json --host "$installation_host" --tag grabenplaner-offsite \
  --path "$OFFSITE_STAGE_CURRENT" >"$operation_root/snapshots.json"; then
  offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
fi
"$OFFSITE_NODE" "$RECOVERY_METADATA" select-latest "$operation_root/snapshots.json" "$installation_host" "$OFFSITE_STAGE_CURRENT" \
  >"$operation_root/snapshot.json" \
  || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
snapshot_id="$("$OFFSITE_NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[a-f0-9]{64}$/.test(String(v.id||"")))process.exit(1);process.stdout.write(v.id)' "$operation_root/snapshot.json")" \
  || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
offsite_info "Quartalspruefung des exakten Offsite-Snapshotnachweises ${snapshot_id:0:12}."

if ! offsite_restic "$uploader_credentials" stats --mode restore-size --json "$snapshot_id" >"$operation_root/stats.json"; then
  offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
fi
readarray -t capacity < <("$OFFSITE_NODE" - "$operation_root/stats.json" <<'NODE'
const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(!Number.isSafeInteger(v.total_size)||v.total_size<1||!Number.isSafeInteger(v.total_file_count)||v.total_file_count<1)process.exit(1);
const reserve=Math.max(1024*1024*1024,Math.ceil(v.total_size/4));process.stdout.write(`${v.total_size}\n${v.total_size+reserve}\n`);
NODE
) || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
(( ${#capacity[@]} == 2 )) || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
available="$(df --block-size=1 --output=avail -- "$OFFSITE_RESTORE_ROOT" | tail -n 1 | tr -d '[:space:]')"
[[ "$available" =~ ^[0-9]+$ ]] && (( available >= capacity[1] )) \
  || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."

if ! offsite_restic "$uploader_credentials" restore "$snapshot_id" --host "$installation_host" --tag grabenplaner-offsite \
  --path "$OFFSITE_STAGE_CURRENT" --target "$restore_root" >"$operation_root/restore.out" 2>"$operation_root/restore.error"; then
  offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
fi
# Der Uploader verliert unmittelbar nach dem Download den Zugriff. Erst danach
# werden Inhalt, Links, Dateitypen, Eigentum und Schreibschutz geprueft.
chown root:root -- "$restore_root"
chmod 0700 -- "$restore_root"
if find "$restore_root" -xdev \( -type l -o -type f -links +1 -o \( ! -type f -a ! -type d \) \) -print -quit | grep -q .; then
  offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
fi
chown -R --no-dereference root:root -- "$restore_root"
find "$restore_root" -xdev -type d -exec chmod 0500 -- {} +
find "$restore_root" -xdev -type f -exec chmod 0400 -- {} +
restored_stage="$restore_root${OFFSITE_STAGE_CURRENT}"
[[ -d "$restored_stage" && ! -L "$restored_stage" ]] \
  || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."

"$OFFSITE_NODE" "$RECOVERY_VERIFY" --stage "$restored_stage" --stage-helper "$OFFSITE_STAGE_HELPER" \
  --backup-verifier "$OFFSITE_APP_ROOT/server-tools/linux/lib/verify-backup.js" --amu-module "$OFFSITE_APP_ROOT/lib/amu-storage.js" \
  --integration-module "$RECOVERY_INTEGRATION_MODULE" --environment "$OFFSITE_APP_ENV" \
  --target-package "$RECOVERY_TARGET_PACKAGE" --target-runtime "$RECOVERY_TARGET_RUNTIME" \
  --scratch-root "$operation_root" --output "$operation_root/verification.json" >/dev/null 2>&1 \
  || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."

application_smoke_passed=0
if [[ -n "$assurance_result" ]]; then
  # Die Root-Pruefung oben hat den exakten Restore-Stand samt geschuetzten
  # Datensaetzen und Dokumenten bereits mit den echten Schluesseln verifiziert.
  # Die unprivilegierte Anwendung erhaelt danach nur eine bereinigte Kopie der
  # Datenbank und einmalige Testschluessel. Live-Secrets, echte AUM-Dateien,
  # externe Netze und produktive Ports bleiben vollstaendig ausgesperrt.
  systemctl stop "$OFFSITE_SMOKE_SERVICE" >/dev/null 2>&1 || true
  systemctl reset-failed "$OFFSITE_SMOKE_SERVICE" >/dev/null 2>&1 || true
  if [[ -e "$OFFSITE_SMOKE_ROOT" || -L "$OFFSITE_SMOKE_ROOT" ]]; then
    [[ -d "$OFFSITE_SMOKE_ROOT" && ! -L "$OFFSITE_SMOKE_ROOT" ]] \
      || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte App-Smoke-Testpfad ist unsicher."
    rm -rf --one-file-system -- "$OFFSITE_SMOKE_ROOT"
  fi
  smoke_uid="$(id -u "$OFFSITE_USER")"
  smoke_gid="$(getent group "$OFFSITE_GROUP" | awk -F: '{print $3}')"
  [[ "$smoke_uid" =~ ^[0-9]+$ && "$smoke_gid" =~ ^[0-9]+$ ]] \
    || offsite_fixed_failure RESTORE_TEST_FAILED "Das isolierte Smoke-Test-Dienstkonto fehlt."
  install -d -m 0700 -o root -g root \
    "$OFFSITE_SMOKE_ROOT" "$OFFSITE_SMOKE_ROOT/home" "$OFFSITE_SMOKE_ROOT/data-root" \
    "$OFFSITE_SMOKE_ROOT/data-root/data" "$OFFSITE_SMOKE_ROOT/data-root/private"
  smoke_root_owned=1
  "$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" verify "$restored_stage" >"$operation_root/smoke-stage.json" \
    || offsite_fixed_failure RESTORE_TEST_FAILED "Der App-Smoke-Quellstand ist ungueltig."
  readarray -t smoke_sources < <("$OFFSITE_NODE" - "$operation_root/smoke-stage.json" "$restored_stage" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [file, stageValue] = process.argv.slice(2);
const stage = path.resolve(stageValue);
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const database = path.resolve(String(value.database || ""));
if (!database.startsWith(`${stage}${path.sep}`)) process.exit(1);
process.stdout.write(`${database}\n`);
NODE
  ) || offsite_fixed_failure RESTORE_TEST_FAILED "Der App-Smoke-Quellstand ist ungueltig."
  (( ${#smoke_sources[@]} == 1 )) \
    || offsite_fixed_failure RESTORE_TEST_FAILED "Der App-Smoke-Quellstand ist unvollstaendig."
  smoke_source_database="${smoke_sources[0]}"
  restored_database_before="$(sha256sum --binary -- "$smoke_source_database" | awk '{print tolower($1)}')"
  cp --reflink=never -- "$smoke_source_database" "$OFFSITE_SMOKE_ROOT/data-root/data/dienstplan.db"
  "$OFFSITE_NODE" "$OFFSITE_MODULE_ROOT/lib/application-smoke.js" --sanitize-database >/dev/null \
    || offsite_fixed_failure RESTORE_TEST_FAILED "Die isolierte App-Smoke-Datenbank konnte nicht sicher bereinigt werden."
  chown -R --no-dereference "$OFFSITE_USER:$OFFSITE_GROUP" -- "$OFFSITE_SMOKE_ROOT"
  find "$OFFSITE_SMOKE_ROOT" -xdev -type d -exec chmod 0700 -- {} +
  find "$OFFSITE_SMOKE_ROOT" -xdev -type f -exec chmod 0600 -- {} +
  set +e
  systemctl start "$OFFSITE_SMOKE_SERVICE" >/dev/null 2>&1
  smoke_service_status=$?
  set -e
  # systemctl start wartet auf das Ende der oneshot-Unit. Danach wird der
  # Dienst-Cgroup nochmals explizit gestoppt und der direkte Elternpfad dem
  # unprivilegierten Konto entzogen. Der Verifier liest das Ergebnis nur noch
  # ueber einen O_NOFOLLOW-Dateideskriptor mit Identitaetspruefung davor/danach.
  systemctl stop "$OFFSITE_SMOKE_SERVICE" >/dev/null 2>&1 || true
  systemctl reset-failed "$OFFSITE_SMOKE_SERVICE" >/dev/null 2>&1 || true
  chown --no-dereference root:root -- "$OFFSITE_SMOKE_ROOT"
  chmod 0500 -- "$OFFSITE_SMOKE_ROOT"
  [[ "$(stat --format='%u:%g:%a' -- "$OFFSITE_SMOKE_ROOT")" == "0:0:500" ]] \
    || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte App-Smoke-Testpfad konnte nicht versiegelt werden."
  smoke_result="$OFFSITE_SMOKE_ROOT/result.json"
  application_smoke_passed="$("$OFFSITE_NODE" "$OFFSITE_MODULE_ROOT/lib/application-smoke.js" \
    --verify-result "$smoke_result" "$smoke_uid" "$smoke_gid" "$smoke_service_status")" \
    || application_smoke_passed=0
  restored_database_after="$(sha256sum --binary -- "$smoke_source_database" | awk '{print tolower($1)}')"
  [[ "$restored_database_before" == "$restored_database_after" ]] \
    || offsite_fixed_failure RESTORE_TEST_FAILED "Der verifizierte Restore-Stand wurde beim App-Smoke-Test veraendert."
fi

if [[ -e "$receipt_root" || -L "$receipt_root" ]]; then
  [[ -d "$receipt_root" && ! -L "$receipt_root" && "$(stat --format='%u:%g:%a' -- "$receipt_root")" == "0:0:700" ]] \
    || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
else
  install -d -m 0700 -o root -g root -- "$receipt_root"
fi
receipt_file="$receipt_root/restore-test-$(date --utc '+%Y%m%dT%H%M%SZ')-${snapshot_id:0:12}.json"
[[ ! -e "$receipt_file" && ! -L "$receipt_file" ]] \
  || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
"$OFFSITE_NODE" "$RECOVERY_METADATA" restore-test-receipt "$receipt_file" "$operation_root/snapshot.json" \
  "$operation_root/stats.json" "$operation_root/verification.json" "$started_at" \
  "$OFFSITE_CONFIG_ROOT/repository-id" "$OFFSITE_CONFIG_ROOT/installation-id" "$OFFSITE_STAGE_CURRENT" >/dev/null \
  || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
chmod 0400 -- "$receipt_file"

if [[ -n "$assurance_result" ]]; then
  receipt_sha256="$(sha256sum --binary -- "$receipt_file" | awk '{print tolower($1)}')"
  [[ "$receipt_sha256" =~ ^[a-f0-9]{64}$ ]] \
    || offsite_fixed_failure RESTORE_TEST_FAILED "Der isolierte Offsite-Wiederherstellungstest ist fehlgeschlagen."
  result_temporary="$assurance_parent/.restore-result.$$"
  (umask 077; printf '{"snapshotIdPrefix":"%s","receiptSha256":"%s","applicationSmokePassed":%s}\n' \
    "${snapshot_id:0:12}" "$receipt_sha256" "$([[ "$application_smoke_passed" == "1" ]] && printf true || printf false)" >"$result_temporary")
  chmod 0600 -- "$result_temporary"
  sync -f "$result_temporary"
  mv -- "$result_temporary" "$assurance_result"
  sync -f "$assurance_parent"
fi

offsite_status restore-test >/dev/null
restore_test_complete=1
if [[ -n "$assurance_result" ]]; then
  offsite_info "Der isolierte Recovery-Assurance-Restore war erfolgreich; Snapshotnachweis: ${snapshot_id:0:12}."
  offsite_info "Der App-Smoke-Test lief in einem getrennten Loopback-Netz ohne Zugriff auf Live-Daten oder Secrets."
else
  offsite_info "Der quartalsweise isolierte Offsite-Wiederherstellungstest war erfolgreich; Snapshotnachweis: ${snapshot_id:0:12}."
fi

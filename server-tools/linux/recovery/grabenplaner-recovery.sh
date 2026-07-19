#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly OFFSITE_COMMON="/opt/grabenplaner-offsite/module/lib/offsite-common.sh"
[[ -f "$OFFSITE_COMMON" && ! -L "$OFFSITE_COMMON" ]] || { printf '%s\n' "Das verifizierte Offsite-Modul ist nicht eingerichtet." >&2; exit 1; }
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$OFFSITE_COMMON"

readonly RECOVERY_ROOT="$OFFSITE_STATE_ROOT/recovery"
readonly RECOVERY_SAFETY_ROOT="$OFFSITE_BACKUP_ROOT/recovery-safety"
readonly RECOVERY_HELPER_ROOT="$OFFSITE_APP_ROOT/server-tools/linux/recovery/lib"
readonly RECOVERY_METADATA="$RECOVERY_HELPER_ROOT/recovery-metadata.js"
readonly RECOVERY_VERIFY="$RECOVERY_HELPER_ROOT/recovery-verify.js"
readonly RECOVERY_APPLY="$RECOVERY_HELPER_ROOT/recovery-apply.js"
readonly RECOVERY_STAGE_HELPER="$OFFSITE_MODULE_ROOT/lib/offsite-stage.js"
readonly RECOVERY_BACKUP_VERIFIER="$OFFSITE_APP_ROOT/server-tools/linux/lib/verify-backup.js"
readonly RECOVERY_AMU_MODULE="$OFFSITE_APP_ROOT/lib/amu-storage.js"
readonly RECOVERY_INTEGRATION_MODULE="$OFFSITE_APP_ROOT/lib/integration-secret-vault.js"
readonly RECOVERY_DATABASE_LOCK_MODULE="$OFFSITE_APP_ROOT/lib/database-lock.js"
readonly RECOVERY_TARGET_PACKAGE="$OFFSITE_APP_ROOT/package.json"
readonly RECOVERY_TARGET_RUNTIME="$OFFSITE_APP_ROOT/server-tools/linux/runtime-schema.json"
readonly RECOVERY_SOURCE_PATH="$OFFSITE_STAGE_CURRENT"
readonly RECOVERY_CADDY_SERVICE="caddy.service"

usage() {
  cat <<'EOF'
Ueberwachte Grabenplaner-Wiederherstellung (nur root)

  sudo grabenplaner-recovery list
  sudo grabenplaner-recovery prepare --snapshot 64_HEX --recovery-id 64_HEX
  sudo grabenplaner-recovery verify  --snapshot 64_HEX --recovery-id 64_HEX
  sudo grabenplaner-recovery apply   --snapshot 64_HEX --recovery-id 64_HEX \
    --confirm-snapshot 64_HEX --confirm-recovery 64_HEX

Es gibt absichtlich kein implizites "latest" bei einer echten Wiederherstellung.
Vor apply muessen Grabenplaner und Caddy durch die verantwortliche Person beendet sein.
Nach apply werden beide Dienste absichtlich nicht automatisch gestartet.
EOF
}

phase="${1:-}"
[[ -n "$phase" ]] || { usage; exit 2; }
shift || true
snapshot_id=""
recovery_id=""
confirm_snapshot=""
confirm_recovery=""
while (($#)); do
  case "$1" in
    --snapshot) snapshot_id="${2:?Wert fuer --snapshot fehlt}"; shift 2 ;;
    --recovery-id) recovery_id="${2:?Wert fuer --recovery-id fehlt}"; shift 2 ;;
    --confirm-snapshot) confirm_snapshot="${2:?Wert fuer --confirm-snapshot fehlt}"; shift 2 ;;
    --confirm-recovery) confirm_recovery="${2:?Wert fuer --confirm-recovery fehlt}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) offsite_die "Unbekannte Recovery-Option: $1" ;;
  esac
done

offsite_require_root
for command_name in awk chown chmod df du find flock getent grep install mktemp readlink realpath rm runuser sha256sum stat systemctl tail tr; do
  offsite_require_command "$command_name"
done
[[ -x "$OFFSITE_NODE" ]] || offsite_die "Die freigegebene Node.js-Laufzeit fehlt."
offsite_assert_runtime_binaries
for helper in "$RECOVERY_METADATA" "$RECOVERY_VERIFY" "$RECOVERY_APPLY" "$RECOVERY_STAGE_HELPER" \
  "$RECOVERY_BACKUP_VERIFIER" "$RECOVERY_AMU_MODULE" "$RECOVERY_INTEGRATION_MODULE" \
  "$RECOVERY_DATABASE_LOCK_MODULE" "$RECOVERY_TARGET_PACKAGE" "$RECOVERY_TARGET_RUNTIME"; do
  [[ -f "$helper" && ! -L "$helper" && "$(stat --format='%u:%h' -- "$helper")" == "0:1" ]] \
    || offsite_die "Ein vertrauenswuerdiger Recovery-Helfer fehlt."
  helper_mode="$(stat --format='%a' -- "$helper")"
  (( (8#$helper_mode & 022) == 0 )) || offsite_die "Ein Recovery-Helfer ist unzulaessig beschreibbar."
done

operation_root=""
restore_root=""
uploader_credentials=""
operation_success=0
failure_code="RECOVERY_FAILED"
declare -a temporary_files=()
cleanup() {
  local status=$?
  for temporary_file in "${temporary_files[@]}"; do rm -f -- "$temporary_file" 2>/dev/null || true; done
  if [[ -n "$restore_root" && -d "$restore_root" && ! -L "$restore_root" ]]; then
    chown root:root -- "$restore_root" 2>/dev/null || true
    chmod 0700 -- "$restore_root" 2>/dev/null || true
  fi
  if [[ -n "$operation_root" && -d "$operation_root" && ! -L "$operation_root" ]]; then
    chown root:root -- "$operation_root" 2>/dev/null || true
    chmod 0700 -- "$operation_root" 2>/dev/null || true
  fi
  if [[ -n "$uploader_credentials" ]]; then offsite_remove_uploader_credentials "$uploader_credentials" 2>/dev/null || true; fi
  if (( status != 0 && operation_success == 0 )) && [[ -n "$operation_root" && -d "$operation_root" && ! -L "$operation_root" \
    && "$recovery_id" =~ ^[a-f0-9]{64}$ && "$snapshot_id" =~ ^[a-f0-9]{64}$ ]]; then
    "$OFFSITE_NODE" "$RECOVERY_METADATA" operation "$operation_root/operation.json" failed "$recovery_id" "$snapshot_id" "$failure_code" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

assert_identifier() {
  [[ "$1" =~ ^[a-f0-9]{64}$ ]] || offsite_die "$2 muss eine vollstaendige, kleingeschriebene 64-stellige Hex-Kennung sein."
}

assert_operation_root() {
  operation_root="$RECOVERY_ROOT/$recovery_id"
  [[ -d "$operation_root" && ! -L "$operation_root" && "$(stat --format='%u:%g:%a' -- "$operation_root")" == "0:0:700" ]] \
    || offsite_die "Der vorbereitete Recovery-Vorgang fehlt oder ist unsicher."
}

write_operation() {
  "$OFFSITE_NODE" "$RECOVERY_METADATA" operation "$operation_root/operation.json" "$1" "$recovery_id" "$snapshot_id" "${2:-}" >/dev/null
}

repository_credentials() {
  offsite_assert_persistent_rclone_config
  uploader_credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")"
  printf '%s\n' "$uploader_credentials"
}

assert_repository_identity() {
  local credentials="$1" output="$2"
  offsite_verify_repository_identity "$credentials" "$output" \
    || offsite_die "Die eingerichtete Repository-Identitaet konnte nicht bestaetigt werden."
}

snapshot_list() {
  local credentials="$1" output="$2" installation_host
  installation_host="$(offsite_installation_host "$credentials")"
  offsite_restic "$credentials" snapshots --json --host "$installation_host" --tag grabenplaner-offsite --path "$RECOVERY_SOURCE_PATH" >"$output" \
    || offsite_die "Die gebundene Snapshotliste konnte nicht gelesen werden."
}

assert_capacity() {
  local target="$1" bytes="$2" label="$3" available reserve required
  [[ "$bytes" =~ ^[0-9]+$ ]] || offsite_die "Die Recovery-Groessenangabe ist ungueltig."
  available="$(df --block-size=1 --output=avail -- "$target" | tail -n 1 | tr -d '[:space:]')"
  [[ "$available" =~ ^[0-9]+$ ]] || offsite_die "Der freie Speicherplatz konnte nicht sicher bestimmt werden."
  reserve=$(( bytes / 4 ))
  (( reserve < 1073741824 )) && reserve=1073741824
  required=$(( bytes + reserve ))
  (( available >= required )) || offsite_die "$label hat nicht ausreichend freien Speicher fuer Recovery und Sicherheitsreserve."
}

run_verifier() {
  local stage="$1" output="$2" scratch="$3"
  "$OFFSITE_NODE" "$RECOVERY_VERIFY" \
    --stage "$stage" --stage-helper "$RECOVERY_STAGE_HELPER" --backup-verifier "$RECOVERY_BACKUP_VERIFIER" \
    --amu-module "$RECOVERY_AMU_MODULE" --integration-module "$RECOVERY_INTEGRATION_MODULE" \
    --environment "$OFFSITE_APP_ENV" --target-package "$RECOVERY_TARGET_PACKAGE" \
    --target-runtime "$RECOVERY_TARGET_RUNTIME" --scratch-root "$scratch" --output "$output" >/dev/null
}

case "$phase" in
  list)
    [[ -z "$snapshot_id$recovery_id$confirm_snapshot$confirm_recovery" ]] || offsite_die "list akzeptiert keine Recovery-Kennungen."
    offsite_acquire_repository_lock
    credentials="$(repository_credentials)"
    uploader_credentials="$credentials"
    temporary="$(mktemp --tmpdir="$OFFSITE_RUN_ROOT" recovery-list.XXXXXXXX)"
    temporary_repository="$(mktemp --tmpdir="$OFFSITE_RUN_ROOT" recovery-repository.XXXXXXXX)"
    temporary_files+=("$temporary" "$temporary_repository")
    assert_repository_identity "$credentials" "$temporary_repository"
    snapshot_list "$credentials" "$temporary"
    installation_host="$(offsite_installation_host "$credentials")"
    "$OFFSITE_NODE" "$RECOVERY_METADATA" list "$temporary" "$installation_host" "$RECOVERY_SOURCE_PATH"
    operation_success=1
    ;;
  prepare)
    assert_identifier "$snapshot_id" "--snapshot"
    assert_identifier "$recovery_id" "--recovery-id"
    [[ -z "$confirm_snapshot$confirm_recovery" ]] || offsite_die "Bestaetigungswerte sind erst bei apply zulaessig."
    if [[ -e "$RECOVERY_ROOT" || -L "$RECOVERY_ROOT" ]]; then
      [[ -d "$RECOVERY_ROOT" && ! -L "$RECOVERY_ROOT" && "$(stat --format='%u:%g:%a' -- "$RECOVERY_ROOT")" == "0:$(getent group "$OFFSITE_GROUP" | awk -F: '{print $3}'):750" ]] \
        || offsite_die "Der Recovery-Arbeitsbereich ist unsicher."
    else
      install -d -m 0750 -o root -g "$OFFSITE_GROUP" -- "$RECOVERY_ROOT"
    fi
    operation_root="$RECOVERY_ROOT/$recovery_id"
    [[ ! -e "$operation_root" && ! -L "$operation_root" ]] || offsite_die "Diese Recovery-ID wurde bereits verwendet."
    install -d -m 0750 -o root -g "$OFFSITE_GROUP" -- "$operation_root"
    write_operation started
    failure_code="RECOVERY_PREPARE_FAILED"
    offsite_acquire_repository_lock
    credentials="$(repository_credentials)"
    uploader_credentials="$credentials"
    assert_repository_identity "$credentials" "$operation_root/repository-config.json"
    snapshot_list "$credentials" "$operation_root/snapshots.json"
    installation_host="$(offsite_installation_host "$credentials")"
    "$OFFSITE_NODE" "$RECOVERY_METADATA" select-exact "$operation_root/snapshots.json" "$snapshot_id" "$installation_host" "$RECOVERY_SOURCE_PATH" >"$operation_root/snapshot.json"
    offsite_restic "$credentials" stats --mode restore-size --json "$snapshot_id" >"$operation_root/stats.json" \
      || offsite_die "Die exakte Restore-Groesse konnte nicht gelesen werden."
    expected_bytes="$("$OFFSITE_NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!Number.isSafeInteger(v.total_size)||v.total_size<1)process.exit(1);process.stdout.write(String(v.total_size))' "$operation_root/stats.json")" \
      || offsite_die "Die exakte Restore-Groesse ist ungueltig."
    assert_capacity "$RECOVERY_ROOT" "$expected_bytes" "Der Recovery-Arbeitsbereich"
    restore_root="$operation_root/restored"
    install -d -m 0700 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" -- "$restore_root"
    if ! offsite_restic "$credentials" restore "$snapshot_id" --host "$installation_host" --tag grabenplaner-offsite \
      --path "$RECOVERY_SOURCE_PATH" --target "$restore_root" >"$operation_root/restore.out" 2>"$operation_root/restore.error"; then
      offsite_die "Der exakt gewaehlte Snapshot konnte nicht isoliert wiederhergestellt werden."
    fi
    chown root:root -- "$restore_root"
    chmod 0700 -- "$restore_root"
    if find "$restore_root" -xdev \( -type l -o -type f -links +1 -o \( ! -type f -a ! -type d \) \) -print -quit | grep -q .; then
      offsite_die "Der heruntergeladene Recovery-Baum enthaelt Links oder besondere Dateien."
    fi
    chown -R --no-dereference root:root -- "$restore_root"
    find "$restore_root" -xdev -type d -exec chmod 0500 -- {} +
    find "$restore_root" -xdev -type f -exec chmod 0400 -- {} +
    chown root:root -- "$operation_root"
    chmod 0700 -- "$operation_root"
    restored_stage="$restore_root$RECOVERY_SOURCE_PATH"
    [[ -d "$restored_stage" && ! -L "$restored_stage" ]] || offsite_die "Der Snapshot enthaelt keinen gebundenen Grabenplaner-Sicherungspunkt."
    run_verifier "$restored_stage" "$operation_root/verification-prepared.json" "$operation_root"
    "$OFFSITE_NODE" "$RECOVERY_METADATA" prepared "$operation_root/prepared.json" "$recovery_id" \
      "$operation_root/snapshot.json" "$operation_root/stats.json" "$operation_root/verification-prepared.json" \
      "$OFFSITE_CONFIG_ROOT/repository-id" "$OFFSITE_CONFIG_ROOT/installation-id" >/dev/null
    chmod 0400 -- "$operation_root"/*.json "$operation_root"/*.out "$operation_root"/*.error 2>/dev/null || true
    write_operation prepared
    operation_success=1
    offsite_info "Recovery vorbereitet. Vor apply ist die ausdrueckliche Phase verify erforderlich."
    ;;
  verify)
    assert_identifier "$snapshot_id" "--snapshot"
    assert_identifier "$recovery_id" "--recovery-id"
    [[ -z "$confirm_snapshot$confirm_recovery" ]] || offsite_die "Bestaetigungswerte sind erst bei apply zulaessig."
    assert_operation_root
    failure_code="RECOVERY_VERIFY_FAILED"
    [[ ! -e "$operation_root/verified.json" && ! -L "$operation_root/verified.json" ]] || offsite_die "Dieser Recovery-Vorgang wurde bereits abschliessend verifiziert."
    "$OFFSITE_NODE" "$RECOVERY_METADATA" check-receipt "$operation_root/prepared.json" prepared "$recovery_id" "$snapshot_id" >/dev/null
    "$OFFSITE_NODE" "$RECOVERY_METADATA" check-binding "$operation_root/prepared.json" "$OFFSITE_CONFIG_ROOT/repository-id" \
      "$OFFSITE_CONFIG_ROOT/installation-id" "$RECOVERY_SOURCE_PATH" >/dev/null
    offsite_acquire_repository_lock
    credentials="$(repository_credentials)"
    uploader_credentials="$credentials"
    assert_repository_identity "$credentials" "$operation_root/repository-verify.json"
    snapshot_list "$credentials" "$operation_root/snapshots-verify.json"
    installation_host="$(offsite_installation_host "$credentials")"
    "$OFFSITE_NODE" "$RECOVERY_METADATA" select-exact "$operation_root/snapshots-verify.json" "$snapshot_id" "$installation_host" "$RECOVERY_SOURCE_PATH" >/dev/null
    restored_stage="$operation_root/restored$RECOVERY_SOURCE_PATH"
    run_verifier "$restored_stage" "$operation_root/verification-verified.json" "$operation_root"
    "$OFFSITE_NODE" "$RECOVERY_METADATA" verified "$operation_root/verified.json" "$operation_root/prepared.json" \
      "$operation_root/verification-verified.json" "$recovery_id" "$snapshot_id" >/dev/null
    chmod 0400 -- "$operation_root"/*.json 2>/dev/null || true
    write_operation verified
    operation_success=1
    offsite_info "Recovery lokal und gegen die exakte Repository-Bindung verifiziert."
    ;;
  apply)
    assert_identifier "$snapshot_id" "--snapshot"
    assert_identifier "$recovery_id" "--recovery-id"
    assert_identifier "$confirm_snapshot" "--confirm-snapshot"
    assert_identifier "$confirm_recovery" "--confirm-recovery"
    [[ "$confirm_snapshot" == "$snapshot_id" && "$confirm_recovery" == "$recovery_id" ]] \
      || offsite_die "Die zwei ausdruecklichen Recovery-Bestaetigungen stimmen nicht exakt ueberein."
    assert_operation_root
    failure_code="RECOVERY_APPLY_FAILED"
    "$OFFSITE_NODE" "$RECOVERY_METADATA" check-receipt "$operation_root/prepared.json" prepared "$recovery_id" "$snapshot_id" >/dev/null
    "$OFFSITE_NODE" "$RECOVERY_METADATA" check-receipt "$operation_root/verified.json" verified "$recovery_id" "$snapshot_id" >/dev/null
    "$OFFSITE_NODE" "$RECOVERY_METADATA" check-binding "$operation_root/verified.json" "$OFFSITE_CONFIG_ROOT/repository-id" \
      "$OFFSITE_CONFIG_ROOT/installation-id" "$RECOVERY_SOURCE_PATH" >/dev/null
    systemctl is-active --quiet "$OFFSITE_APP_SERVICE" && offsite_die "Der Grabenplaner-Dienst muss vor apply bewusst beendet werden."
    systemctl is-active --quiet "$RECOVERY_CADDY_SERVICE" && offsite_die "Caddy muss vor apply bewusst beendet werden."
    core_common="$OFFSITE_APP_ROOT/server-tools/linux/lib/common.sh"
    [[ -f "$core_common" && ! -L "$core_common" ]] || offsite_die "Die Core-Wartungssperre fehlt."
    # shellcheck source=server-tools/linux/lib/common.sh
    source "$core_common"
    gp_acquire_maintenance_lock
    offsite_acquire_repository_lock
    restored_stage="$operation_root/restored$RECOVERY_SOURCE_PATH"
    run_verifier "$restored_stage" "$operation_root/verification-apply.json" "$operation_root"
    "$OFFSITE_NODE" "$RECOVERY_METADATA" verified "$operation_root/pre-apply.json" "$operation_root/prepared.json" \
      "$operation_root/verification-apply.json" "$recovery_id" "$snapshot_id" >/dev/null
    chmod 0400 -- "$operation_root/verification-apply.json" "$operation_root/pre-apply.json"
    write_operation applying

    readarray -t live_paths < <("$OFFSITE_NODE" - "$OFFSITE_APP_ENV" "$OFFSITE_DATA_ROOT" <<'NODE'
const fs=require("node:fs"),path=require("node:path");const [file,root]=process.argv.slice(2);const values=new Map();
for(const line of fs.readFileSync(file,"utf8").split(/\r?\n/)){const m=line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);if(m)values.set(m[1],m[2]);}
const database=path.resolve(values.get("DB_PATH")||path.join(root,"data","dienstplan.db"));const data=path.resolve(root);
if(!database.startsWith(`${data}${path.sep}`))process.exit(1);process.stdout.write(`${database}\n${path.join(data,"private","amu")}\n${path.join(data,"runtime-config.json")}\n${path.join(data,"branding-kits")}\n`);
NODE
    ) || offsite_die "Die gebundenen Live-Datenpfade konnten nicht gelesen werden."
    (( ${#live_paths[@]} == 4 )) || offsite_die "Die Live-Datenpfade sind unvollstaendig."
    live_database="${live_paths[0]}"
    live_documents="${live_paths[1]}"
    live_runtime="${live_paths[2]}"
    live_branding="${live_paths[3]}"
    [[ -f "$live_database" && ! -L "$live_database" && -d "$live_documents" && ! -L "$live_documents" ]] \
      || offsite_die "Der aktuelle Live-Datenbestand ist unvollstaendig."
    live_scan_paths=("$live_database" "$live_documents")
    [[ -e "$live_runtime" || -L "$live_runtime" ]] && live_scan_paths+=("$live_runtime")
    [[ -e "$live_branding" || -L "$live_branding" ]] && live_scan_paths+=("$live_branding")
    for suffix in -wal -shm; do
      [[ -e "$live_database$suffix" || -L "$live_database$suffix" ]] && live_scan_paths+=("$live_database$suffix")
    done
    if find "${live_scan_paths[@]}" \
      -xdev \( -type l -o -type f -links +1 -o \( ! -type f -a ! -type d \) \) -print -quit 2>/dev/null | grep -q .; then
      offsite_die "Der aktuelle Live-Datenbestand enthaelt Links oder besondere Dateien."
    fi
    expected_bytes="$("$OFFSITE_NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!Number.isSafeInteger(v.expectedBytes)||v.expectedBytes<1)process.exit(1);process.stdout.write(String(v.expectedBytes))' "$operation_root/prepared.json")" \
      || offsite_die "Der vorbereitete Kapazitaetsbeleg ist ungueltig."
    live_bytes="$(du --bytes --summarize -- "${live_scan_paths[@]}" | awk '{sum+=$1} END {print sum+0}')"
    combined_bytes=$(( expected_bytes + live_bytes ))
    assert_capacity "$OFFSITE_DATA_ROOT" "$combined_bytes" "Der Live-Datentraeger"
    assert_capacity "$OFFSITE_BACKUP_ROOT" "$combined_bytes" "Der Sicherheitsbackup-Datentraeger"

    if [[ -e "$RECOVERY_SAFETY_ROOT" || -L "$RECOVERY_SAFETY_ROOT" ]]; then
      [[ -d "$RECOVERY_SAFETY_ROOT" && ! -L "$RECOVERY_SAFETY_ROOT" \
        && "$(stat --format='%u:%g:%a' -- "$RECOVERY_SAFETY_ROOT")" == "0:0:700" ]] \
        || offsite_die "Der permanente Recovery-Sicherheitsbereich ist unsicher."
    else
      install -d -m 0700 -o root -g root -- "$RECOVERY_SAFETY_ROOT"
    fi
    safety_root="$RECOVERY_SAFETY_ROOT/$recovery_id"
    [[ ! -e "$safety_root" && ! -L "$safety_root" ]] || offsite_die "Der permanente Vorab-Sicherheitsbeleg fuer diese Recovery-ID existiert bereits."
    install -d -m 0700 -o root -g root -- "$safety_root"
    # Der Apply-Helfer erwirbt zuerst die Datenbanksperre und erstellt darunter
    # den vollstaendig fsync-gesicherten, gehashten Live-Sicherheitsbaum. Erst
    # danach darf er irgendeinen Live-Pfad atomar umschalten.
    "$OFFSITE_NODE" "$RECOVERY_APPLY" --stage "$restored_stage" --prepared-receipt "$operation_root/prepared.json" \
      --verified-receipt "$operation_root/pre-apply.json" --safety-receipt "$safety_root/pre-restore-safety.json" --safety-root "$safety_root" \
      --recovery-id "$recovery_id" --snapshot "$snapshot_id" --data-root "$OFFSITE_DATA_ROOT" --database "$live_database" \
      --amu-module "$RECOVERY_AMU_MODULE" --database-lock-module "$RECOVERY_DATABASE_LOCK_MODULE" \
      --output "$safety_root/application.json" >/dev/null
    chown "$OFFSITE_APP_USER:$OFFSITE_APP_GROUP" -- "$live_database"
    chmod 0640 -- "$live_database"
    chown -R "$OFFSITE_APP_USER:$OFFSITE_APP_GROUP" -- "$live_documents"
    find "$live_documents" -type d -exec chmod 0750 -- {} +
    find "$live_documents" -type f -exec chmod 0640 -- {} +
    if [[ -f "$live_runtime" && ! -L "$live_runtime" ]]; then chown "$OFFSITE_APP_USER:$OFFSITE_APP_GROUP" -- "$live_runtime"; chmod 0640 -- "$live_runtime"; fi
    if [[ -d "$live_branding" && ! -L "$live_branding" ]]; then
      chown -R "$OFFSITE_APP_USER:$OFFSITE_APP_GROUP" -- "$live_branding"
      find "$live_branding" -type d -exec chmod 0750 -- {} +
      find "$live_branding" -type f -exec chmod 0640 -- {} +
    fi
    for preserved in "$live_database.pre-recovery-$recovery_id" "$live_database-wal.pre-recovery-$recovery_id" \
      "$live_database-shm.pre-recovery-$recovery_id" "$live_documents.pre-recovery-$recovery_id" \
      "$live_runtime.pre-recovery-$recovery_id" "$live_branding.pre-recovery-$recovery_id"; do
      if [[ -e "$preserved" && ! -L "$preserved" ]]; then
        chown -R --no-dereference root:root -- "$preserved"
        [[ -d "$preserved" ]] && find "$preserved" -type d -exec chmod 0500 -- {} +
        [[ -d "$preserved" ]] && find "$preserved" -type f -exec chmod 0400 -- {} +
        [[ -f "$preserved" ]] && chmod 0400 -- "$preserved"
      fi
    done
    chmod 0400 -- "$safety_root/application.json"
    write_operation applied
    operation_success=1
    offsite_info "Recovery angewendet. Alter Live-Zustand und Vorab-Sicherheitsbeleg bleiben dauerhaft erhalten."
    offsite_warn "Dienste wurden absichtlich nicht gestartet. Bitte zuerst lokal pruefen, dann Grabenplaner und zuletzt Caddy bewusst starten."
    ;;
  -h|--help|help)
    usage
    operation_success=1
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

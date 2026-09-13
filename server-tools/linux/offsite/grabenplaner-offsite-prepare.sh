#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

backup_result=""
lock_already_held=0
repository_lock_already_held=0
while (($#)); do
  case "$1" in
    --backup-result) backup_result="${2:?Wert fuer --backup-result fehlt}"; shift 2 ;;
    --lock-already-held) lock_already_held=1; shift ;;
    --repository-lock-already-held) repository_lock_already_held=1; shift ;;
    -h|--help)
      printf '%s\n' "Verwendung: sudo grabenplaner-offsite-prepare [--backup-result PFAD --lock-already-held [--repository-lock-already-held]]"
      exit 0
      ;;
    *) offsite_die "Unbekannte Option: $1" ;;
  esac
done
(( repository_lock_already_held == 0 || lock_already_held == 1 )) \
  || offsite_die "Die Repository-Sperre darf nur zusammen mit der uebernommenen Wartungssperre verwendet werden."

offsite_require_root
for command_name in awk basename cp curl find flock getent grep install mktemp mv readlink realpath rm runuser sha256sum stat systemctl; do offsite_require_command "$command_name"; done
[[ -x "$OFFSITE_NODE" ]] || offsite_die "Die freigegebene Node.js-Laufzeit fehlt."
offsite_assert_runtime_binaries
offsite_prepare_run_root

core_common="$OFFSITE_APP_ROOT/server-tools/linux/lib/common.sh"
backup_script="$OFFSITE_APP_ROOT/server-tools/linux/backup-grabenplaner.sh"
backup_verifier="$OFFSITE_APP_ROOT/server-tools/linux/lib/verify-backup.js"
amu_module="$OFFSITE_APP_ROOT/lib/amu-storage.js"
env_example="$OFFSITE_APP_ROOT/server-tools/linux/grabenplaner.env.example"
for required in "$core_common" "$backup_script" "$backup_verifier" "$amu_module" "$OFFSITE_APP_ENV" "$env_example"; do
  [[ -f "$required" && ! -L "$required" ]] || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
done

# Lock before inspecting or creating staging. A second preparation must see
# the first one's committed point; upload must not remove it during this read.
source "$core_common"
backup_provider="$("$OFFSITE_NODE" -e 'const fs=require("node:fs"),v=require("node:util").parseEnv(fs.readFileSync(process.argv[1],"utf8"));const p=v.DB_PROVIDER||"sqlite";if(!["sqlite","postgresql"].includes(p))process.exit(1);process.stdout.write(p)' "$OFFSITE_APP_ENV")" \
  || offsite_fixed_failure PREPARE_FAILED 'Der Datenbankprovider ist ungueltig.'
backup_root="$OFFSITE_BACKUP_ROOT"
if [[ "$backup_provider" == postgresql ]]; then backup_root=/var/backups/grabenplaner-postgresql; fi
deploy_workflow="$(offsite_core_deploy_workflow)" \
  || offsite_fixed_failure PREPARE_FAILED "Der installierte App-Vertrag ist fuer den Sicherungsablauf ungueltig."
readonly OFFSITE_MAINTENANCE_LOCK_WAIT_SECONDS=300
(( lock_already_held == 1 )) \
  || offsite_acquire_maintenance_lock_with_wait "$OFFSITE_MAINTENANCE_LOCK_WAIT_SECONDS"
if (( repository_lock_already_held == 1 )); then
  offsite_assert_inherited_repository_lock
else
  offsite_acquire_repository_lock
fi

if [[ -d "$OFFSITE_STAGE_CURRENT" && ! -L "$OFFSITE_STAGE_CURRENT" ]]; then
  if "$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" verify "$OFFSITE_STAGE_CURRENT" >/dev/null 2>&1; then
    if [[ -n "$backup_result" ]]; then
      result_for_match="$(realpath --canonicalize-existing -- "$backup_result")" \
        || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
      "$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" verify-result "$OFFSITE_STAGE_CURRENT" "$result_for_match" >/dev/null 2>&1 \
        || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
    fi
    offsite_info "Ein verifiziertes Offsite-Staging wartet bereits auf die Uebertragung."
    exit 0
  fi
  offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
elif [[ -e "$OFFSITE_STAGE_CURRENT" || -L "$OFFSITE_STAGE_CURRENT" ]]; then
  offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
fi

app_port="$("$OFFSITE_NODE" - "$OFFSITE_APP_ENV" <<'NODE'
const fs = require("node:fs");
const matches = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter((line) => /^PORT=/.test(line));
if (matches.length !== 1) process.exit(1);
const port = Number(matches[0].slice(5));
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
process.stdout.write(String(port));
NODE
)" || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
internal_ready_url="http://127.0.0.1:${app_port}/api/health/ready"

status_gid="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $3}')"
[[ "$status_gid" =~ ^[0-9]+$ && -d "$OFFSITE_STATE_ROOT" && ! -L "$OFFSITE_STATE_ROOT" \
  && "$(stat --format='%u:%g:%a' -- "$OFFSITE_STATE_ROOT")" == "0:$status_gid:750" ]] \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Statuspfad ist unsicher."
install -d -m 0750 -o root -g "$OFFSITE_GROUP" -- "$OFFSITE_STAGE_ROOT"
"$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" assert-empty-root "$OFFSITE_STAGE_ROOT" >/dev/null \
  || offsite_fixed_failure PREPARE_FAILED "Ein verbliebener Offsite-Arbeitsstand muss vor einer neuen Vorbereitung geprueft werden."
temporary_stage="$(mktemp --directory --tmpdir="$OFFSITE_STAGE_ROOT" .prepare.XXXXXXXX)"
result_owned=0
service_was_active=0
stage_committed=0
workspace_held=0

cleanup() {
  local cleanup_status=$?
  # Remove an incomplete copy while its workspace lease is still held.
  if (( stage_committed == 0 )) && [[ -d "$temporary_stage" && ! -L "$temporary_stage" ]]; then
    if ! rm -rf --one-file-system -- "$temporary_stage"; then
      offsite_warn "Der unvollstaendige Offsite-Arbeitsstand konnte nicht entfernt werden."
      cleanup_status=1
    fi
  fi
  # Startup/shutdown backups must never wait for a lease held by their parent.
  if (( workspace_held == 1 )); then gp_release_backup_workspace_lock; workspace_held=0; fi
  if (( service_was_active == 1 )); then
    if ! gp_start_service "$OFFSITE_APP_SERVICE" >/dev/null 2>&1; then
      offsite_warn "Der App-Dienst konnte nach dem lokalen Staging nicht neu gestartet werden."
      offsite_status failure --code PREPARE_FAILED --summary "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden." >/dev/null 2>&1 || true
      cleanup_status=1
    elif ! gp_wait_ready "$internal_ready_url" 1500; then
      offsite_warn "Der App-Dienst wurde nach dem lokalen Staging nicht rechtzeitig bereit."
      offsite_status failure --code PREPARE_FAILED --summary "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden." >/dev/null 2>&1 || true
      cleanup_status=1
    fi
  fi
  if (( result_owned == 1 )) && [[ -f "$backup_result" && ! -L "$backup_result" ]]; then rm -f -- "$backup_result"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT

if [[ -z "$backup_result" ]]; then
  # FD 8 belongs to the repository, FD 6 to an enclosing Assurance run.
  # Keep the lifecycle owner on FD 4 until cleanup has restarted the app.
  workspace_database="$("$OFFSITE_NODE" - "$OFFSITE_APP_ENV" "$OFFSITE_DATA_ROOT/data/dienstplan.db" <<'NODE'
const fs = require("node:fs");
const rows = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(line => /^DB_PATH=/.test(line));
if (rows.length > 1) process.exit(1);
const value = rows.length ? rows[0].slice(8) : process.argv[3];
if (!value.startsWith("/") || /[\x00-\x1f\x7f]/.test(value)) process.exit(1);
process.stdout.write(value);
NODE
  )" || offsite_fixed_failure PREPARE_FAILED "Der gemeinsame Backup-Arbeitsbereich ist ungueltig."
  maintenance_fd=9
  if [[ "$(readlink -f -- /proc/$$/fd/6 2>/dev/null || true)" == "$GP_DEFAULT_MAINTENANCE_LOCK" ]]; then maintenance_fd=6; fi
  if [[ "$deploy_workflow" == current ]]; then
    gp_begin_backup_ownership "$workspace_database" "$OFFSITE_NODE" "$OFFSITE_APP_ROOT/lib/backup-maintenance.js" "$maintenance_fd" 4
  # Heavy archive work precedes the stop; the app remains available while
  # already verified, immutable rollback points are archived in order.
  "$backup_script" --env-file "$OFFSITE_APP_ENV" --app-dir "$OFFSITE_APP_ROOT" --data-dir "$OFFSITE_DATA_ROOT" \
    --backup-dir "$backup_root" --service "$OFFSITE_APP_SERVICE" --node "$OFFSITE_NODE" \
    --service-user "$OFFSITE_APP_USER" --service-group "$OFFSITE_APP_GROUP" --lock-already-held --finish-deferred \
    || offsite_fixed_failure PREPARE_FAILED "Die aufgeschobenen Archivabschluesse konnten nicht beendet werden."
  fi
  if systemctl is-active --quiet "$OFFSITE_APP_SERVICE"; then
    service_was_active=1
    gp_stop_service "$OFFSITE_APP_SERVICE" 150
  fi
  backup_result="$(mktemp --tmpdir="$OFFSITE_RUN_ROOT" prepare-backup.XXXXXXXX)"
  result_owned=1
  chmod 0600 -- "$backup_result"
  if ! "$backup_script" --env-file "$OFFSITE_APP_ENV" --app-dir "$OFFSITE_APP_ROOT" --data-dir "$OFFSITE_DATA_ROOT" \
    --backup-dir "$backup_root" --service "$OFFSITE_APP_SERVICE" --node "$OFFSITE_NODE" \
    --service-user "$OFFSITE_APP_USER" --service-group "$OFFSITE_APP_GROUP" --lock-already-held >"$backup_result"; then
    offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
  fi
else
  backup_result="$(realpath --canonicalize-existing -- "$backup_result")" \
    || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
  [[ -f "$backup_result" && ! -L "$backup_result" ]] \
    || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
  backup_result_mode="$(stat --format='%a' -- "$backup_result")"
  [[ "$(stat --format='%u:%g:%h' -- "$backup_result")" == "0:0:1" \
    && $((8#$backup_result_mode & 022)) -eq 0 ]] \
    || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
fi

readarray -t backup_paths < <("$OFFSITE_NODE" - "$backup_result" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/, ""));
if (value.ok !== true) process.exit(1);
for (const key of ["path", "amuBackup", "commitMarker"]) {
  const item = String(value[key] || "");
  if (!item.startsWith("/") || item.includes("\0") || item.includes("\n") || item.includes("\r")) process.exit(1);
  process.stdout.write(`${item}\n`);
}
NODE
) || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
(( ${#backup_paths[@]} == 3 )) || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
backup_database="$(realpath --canonicalize-existing -- "${backup_paths[0]}")" \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
backup_documents="$(realpath --canonicalize-existing -- "${backup_paths[1]}")" \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
backup_marker="$(realpath --canonicalize-existing -- "${backup_paths[2]}")" \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."

for target in "$backup_database" "$backup_documents" "$backup_marker"; do
  [[ "$target" == "$backup_root/"* ]] \
    || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
done
if [[ "$backup_provider" == postgresql ]]; then
  [[ -d "$backup_database" && ! -L "$backup_database" && "$backup_documents" == "$backup_database/private/amu" && "$backup_marker" == "$backup_database.complete.json" ]] \
    || offsite_fixed_failure PREPARE_FAILED 'Das PostgreSQL-Sicherungspaar ist ungueltig.'
  "$OFFSITE_NODE" "$OFFSITE_APP_ROOT/server-tools/linux/lib/postgresql-operations.js" verify /etc/grabenplaner/postgresql-operations.json "$backup_database" "$backup_marker" >/dev/null \
    || offsite_fixed_failure PREPARE_FAILED 'Das PostgreSQL-Sicherungspaar konnte nicht bestaetigt werden.'
else
[[ -f "$backup_database" && ! -L "$backup_database" && -d "$backup_documents" && ! -L "$backup_documents" \
  && -f "$backup_marker" && ! -L "$backup_marker" ]] \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
[[ "$(stat --format='%h' -- "$backup_database")" == "1" && "$(stat --format='%h' -- "$backup_marker")" == "1" ]] \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
if find "$backup_documents" -xdev \( -type l -o -type f -links +1 \) -print -quit | grep -q .; then
  offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
fi
"$OFFSITE_NODE" "$backup_verifier" "$backup_database" "$backup_documents" "$amu_module" "$backup_marker" >/dev/null 2>&1 \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
fi

workspace_database="$("$OFFSITE_NODE" - "$OFFSITE_APP_ENV" "$OFFSITE_DATA_ROOT/data/dienstplan.db" <<'NODE'
const fs = require("node:fs");
const rows = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(line => /^DB_PATH=/.test(line));
if (rows.length > 1) process.exit(1);
const value = rows.length ? rows[0].slice(8) : process.argv[3];
if (!value.startsWith("/") || /[\x00-\x1f\x7f]/.test(value)) process.exit(1);
process.stdout.write(value);
NODE
)" || offsite_fixed_failure PREPARE_FAILED "Der gemeinsame Backup-Arbeitsbereich ist ungueltig."
gp_acquire_backup_workspace_lock "$workspace_database" "$OFFSITE_NODE" "$OFFSITE_APP_ROOT/lib/backup-workspace.js"
workspace_held=1

install -d -m 0700 -o root -g root -- "$temporary_stage/backup" "$temporary_stage/recovery"
if [[ "$backup_provider" == postgresql ]]; then
  cp --archive --reflink=never -- "$backup_database" "$temporary_stage/backup/"
  cp --reflink=never --preserve=mode,timestamps -- "$backup_marker" "$temporary_stage/backup/"
else
  cp --reflink=never --preserve=mode,timestamps -- "$backup_database" "$backup_marker" "$temporary_stage/backup/"
  cp --archive --reflink=never -- "$backup_documents" "$temporary_stage/backup/"
fi
staged_database="$temporary_stage/backup/$(basename -- "$backup_database")"
staged_documents="$temporary_stage/backup/$(basename -- "$backup_documents")"
staged_marker="$temporary_stage/backup/$(basename -- "$backup_marker")"
if [[ "$backup_provider" == postgresql ]]; then
  "$OFFSITE_NODE" "$OFFSITE_APP_ROOT/server-tools/linux/lib/postgresql-operations.js" verify /etc/grabenplaner/postgresql-operations.json "$staged_database" "$staged_marker" >/dev/null \
    || offsite_fixed_failure PREPARE_FAILED 'Das kopierte PostgreSQL-Sicherungspaar konnte nicht bestaetigt werden.'
else
  "$OFFSITE_NODE" "$backup_verifier" "$staged_database" "$staged_documents" "$amu_module" "$staged_marker" >/dev/null 2>&1 \
    || offsite_fixed_failure PREPARE_FAILED "Der kopierte Offsite-Sicherungspunkt konnte nicht bestaetigt werden."
fi
cp --reflink=never --preserve=mode,timestamps -- "$env_example" "$temporary_stage/recovery/grabenplaner.env.example"
cp --reflink=never --preserve=mode,timestamps -- "$OFFSITE_APP_ROOT/package.json" "$temporary_stage/recovery/package.json"
cp --reflink=never --preserve=mode,timestamps -- "$OFFSITE_APP_ROOT/server-tools/linux/runtime-schema.json" "$temporary_stage/recovery/runtime-schema.json"
if [[ -f "$OFFSITE_DATA_ROOT/runtime-config.json" && ! -L "$OFFSITE_DATA_ROOT/runtime-config.json" ]]; then
  cp --reflink=never --preserve=mode,timestamps -- "$OFFSITE_DATA_ROOT/runtime-config.json" "$temporary_stage/recovery/runtime-config.json"
fi
if [[ -f "/etc/caddy/Caddyfile" && ! -L "/etc/caddy/Caddyfile" ]]; then
  cp --reflink=never --preserve=mode,timestamps -- "/etc/caddy/Caddyfile" "$temporary_stage/recovery/Caddyfile"
fi
if [[ -d "$OFFSITE_DATA_ROOT/branding-kits" && ! -L "$OFFSITE_DATA_ROOT/branding-kits" ]]; then
  cp --archive --reflink=never -- "$OFFSITE_DATA_ROOT/branding-kits" "$temporary_stage/recovery/branding-kits"
fi

"$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" create "$temporary_stage" "$backup_result" \
  "$temporary_stage/recovery/grabenplaner.env.example" "$temporary_stage/recovery/package.json" "$temporary_stage/recovery/runtime-schema.json" >/dev/null \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."
"$OFFSITE_NODE" "$OFFSITE_STAGE_HELPER" verify "$temporary_stage" >/dev/null \
  || offsite_fixed_failure PREPARE_FAILED "Der lokale Offsite-Sicherungspunkt konnte nicht vorbereitet werden."

chown -R "root:$OFFSITE_GROUP" -- "$temporary_stage"
find "$temporary_stage" -xdev -type d -exec chmod 0750 -- {} +
find "$temporary_stage" -xdev -type f -exec chmod 0440 -- {} +
mv -T -- "$temporary_stage" "$OFFSITE_STAGE_CURRENT"
stage_committed=1
offsite_info "Der exakte lokale Sicherungspunkt wurde fuer die Offsite-Uebertragung vorbereitet."

#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_SOURCE="${BASH_SOURCE[0]}"
readonly EXPECTED_COMMAND_TARGET="/opt/grabenplaner/app/server-tools/linux/update-grabenplaner-server.sh"
SCRIPT_PATH="$(readlink -f -- "$SCRIPT_SOURCE" 2>/dev/null || true)"
[[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] \
  || { printf '%s\n' "Das Wartungsskript konnte nicht sicher aufgeloest werden." >&2; exit 1; }
[[ ! -L "$SCRIPT_SOURCE" || "$SCRIPT_PATH" == "$EXPECTED_COMMAND_TARGET" ]] \
  || { printf '%s\n' "Der Wartungsbefehl zeigt nicht auf die erwartete Grabenplaner-Installation." >&2; exit 1; }
readonly SCRIPT_PATH
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Verwendung:
  sudo ./update-grabenplaner-server.sh --package /absolut/paket.zip \
    [--sha256 HEX | --sha256-file /absolut/paket.zip.sha256] [Optionen]

Das Werkzeug laedt niemals selbst ein Update herunter. Es akzeptiert nur ein
lokales Linux-x64-Serverpaket, prueft Paket- und Einzeldatei-Hashes, erstellt
vor dem Austausch ein gekoppeltes DB-/Dokumentbackup und rollt bei einem
fehlgeschlagenen Healthcheck automatisch zurueck. Aendert ein Paket den
versionierten systemd-/Caddy-/Bootstrap-/Env-Runtimevertrag, wird es vor jeder
Aenderung mit dem Hinweis auf eine explizite Servermigration abgelehnt.
EOF
}

package_arg=""
sha256_arg=""
sha256_file_arg=""
env_file="$GP_DEFAULT_ENV_FILE"
app_arg=""
data_arg=""
database_arg=""
backup_arg=""
public_url_arg=""
node_arg=""
pnpm_arg=""
service="$GP_DEFAULT_SERVICE"
caddy_service="$GP_DEFAULT_CADDY_SERVICE"
service_user="$GP_DEFAULT_SERVICE_USER"
service_group="$GP_DEFAULT_SERVICE_GROUP"
build_user="$GP_DEFAULT_BUILD_USER"
build_group="$GP_DEFAULT_BUILD_GROUP"
build_cache_arg=""
backup_keep_arg=""
health_timeout=120
maximum_expanded_bytes=2147483648
allow_downgrade=0
lock_already_held=0
commit_marker_arg=""

while (($#)); do
  case "$1" in
    --package) package_arg="${2:?Wert fuer --package fehlt}"; shift 2 ;;
    --sha256) sha256_arg="${2:?Wert fuer --sha256 fehlt}"; shift 2 ;;
    --sha256-file) sha256_file_arg="${2:?Wert fuer --sha256-file fehlt}"; shift 2 ;;
    --env-file) env_file="${2:?Wert fuer --env-file fehlt}"; shift 2 ;;
    --app-dir) app_arg="${2:?Wert fuer --app-dir fehlt}"; shift 2 ;;
    --data-dir) data_arg="${2:?Wert fuer --data-dir fehlt}"; shift 2 ;;
    --database) database_arg="${2:?Wert fuer --database fehlt}"; shift 2 ;;
    --backup-dir) backup_arg="${2:?Wert fuer --backup-dir fehlt}"; shift 2 ;;
    --public-url) public_url_arg="${2:?Wert fuer --public-url fehlt}"; shift 2 ;;
    --node) node_arg="${2:?Wert fuer --node fehlt}"; shift 2 ;;
    --pnpm) pnpm_arg="${2:?Wert fuer --pnpm fehlt}"; shift 2 ;;
    --service) service="${2:?Wert fuer --service fehlt}"; shift 2 ;;
    --caddy-service) caddy_service="${2:?Wert fuer --caddy-service fehlt}"; shift 2 ;;
    --service-user) service_user="${2:?Wert fuer --service-user fehlt}"; shift 2 ;;
    --service-group) service_group="${2:?Wert fuer --service-group fehlt}"; shift 2 ;;
    --build-user) build_user="${2:?Wert fuer --build-user fehlt}"; shift 2 ;;
    --build-group) build_group="${2:?Wert fuer --build-group fehlt}"; shift 2 ;;
    --build-cache) build_cache_arg="${2:?Wert fuer --build-cache fehlt}"; shift 2 ;;
    --backup-keep) backup_keep_arg="${2:?Wert fuer --backup-keep fehlt}"; shift 2 ;;
    --health-timeout) health_timeout="${2:?Wert fuer --health-timeout fehlt}"; shift 2 ;;
    --maximum-expanded-bytes) maximum_expanded_bytes="${2:?Wert fehlt}"; shift 2 ;;
    --allow-downgrade-or-reinstall) allow_downgrade=1; shift ;;
    # Ausschliesslich fuer die versionierte Runtime-Migration. FD 9 muss dabei
    # bereits auf der echten root-only Wartungssperre liegen und wird unten
    # nochmals mit flock validiert.
    --lock-already-held) lock_already_held=1; shift ;;
    --commit-marker) commit_marker_arg="${2:?Wert fuer --commit-marker fehlt}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

gp_require_root
for command_name in cmp realpath readlink flock sha256sum unzip zipinfo systemctl curl find grep sort stat du getent clamscan runuser; do gp_require_command "$command_name"; done
[[ "$(uname -m)" == "x86_64" ]] || gp_die "Das Serverpaket wird derzeit nur auf Linux x86_64 unterstuetzt."
[[ -n "$package_arg" ]] || gp_die "--package ist erforderlich."
[[ "$health_timeout" =~ ^[0-9]+$ ]] && (( health_timeout >= 30 && health_timeout <= 600 )) || gp_die "--health-timeout muss zwischen 30 und 600 liegen."
[[ "$maximum_expanded_bytes" =~ ^[0-9]+$ ]] && (( maximum_expanded_bytes >= 1048576 && maximum_expanded_bytes <= 4294967296 )) \
  || gp_die "--maximum-expanded-bytes liegt ausserhalb des erlaubten Bereichs."
[[ -z "$sha256_arg" || -z "$sha256_file_arg" ]] || gp_die "--sha256 und --sha256-file duerfen nicht gleichzeitig verwendet werden."
[[ -z "$commit_marker_arg" || "$lock_already_held" -eq 1 ]] \
  || gp_die "--commit-marker ist ausschliesslich innerhalb einer uebernommenen Runtime-Migrationssperre erlaubt."

gp_load_env_file "$env_file"
app_dir="$(gp_existing_directory "${app_arg:-$GP_DEFAULT_APP_DIR}" "App-Ordner")"
data_dir="$(gp_existing_directory "${data_arg:-${GRABENPLANER_DATA_DIR:-$GP_DEFAULT_DATA_DIR}}" "Datenordner")"
database="$(gp_existing_file "${database_arg:-${DB_PATH:-$data_dir/data/dienstplan.db}}" "SQLite-Datenbank")"
backup_dir="$(gp_safe_absolute_path "${backup_arg:-${BACKUP_DIR:-$GP_DEFAULT_BACKUP_DIR}}" "Backupordner")"
amu_dir="$(gp_existing_directory "$data_dir/private/amu" "Geschuetzter Dokumentordner")"
public_url="${public_url_arg:-${GRABENPLANER_PUBLIC_URL:-}}"
backup_keep="${backup_keep_arg:-${GRABENPLANER_BACKUP_KEEP:-30}}"
[[ "$backup_keep" =~ ^[0-9]+$ ]] && (( backup_keep >= 1 && backup_keep <= 1000 )) || gp_die "--backup-keep muss zwischen 1 und 1000 liegen."
port="${PORT:-3000}"
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || gp_die "PORT ist ungueltig."
if [[ -n "$node_arg" ]]; then node="$(gp_existing_file "$node_arg" "Node.js")"; else gp_require_command node; node="$(command -v node)"; fi
if [[ -n "$pnpm_arg" ]]; then
  pnpm_program="$(gp_existing_file "$pnpm_arg" "pnpm")"
  pnpm_arguments=()
elif command -v pnpm >/dev/null 2>&1; then
  pnpm_program="$(command -v pnpm)"
  pnpm_arguments=()
elif command -v corepack >/dev/null 2>&1; then
  pnpm_program="$(command -v corepack)"
  pnpm_arguments=(pnpm)
else
  gp_die "Weder pnpm noch Corepack/pnpm ist installiert."
fi
"$node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)' \
  || gp_die "Node.js >=22.13.0 wird benoetigt."
gp_validate_https_url "$node" "$public_url" || gp_die "GRABENPLANER_PUBLIC_URL muss eine reine HTTPS-Ursprungsadresse sein."
getent passwd "$service_user" >/dev/null || gp_die "Dienstbenutzer fehlt: $service_user"
getent group "$service_group" >/dev/null || gp_die "Dienstgruppe fehlt: $service_group"
getent passwd "$build_user" >/dev/null || gp_die "Isolierter Build-Benutzer fehlt: $build_user"
getent group "$build_group" >/dev/null || gp_die "Isolierte Build-Gruppe fehlt: $build_group"
[[ "$(id -gn "$build_user")" == "$build_group" ]] || gp_die "Der Build-Benutzer verwendet eine unerwartete Hauptgruppe."
build_cache="$(gp_existing_directory "${build_cache_arg:-$GP_DEFAULT_BUILD_CACHE}" "Build-Cache")"

package="$(gp_existing_file "$package_arg" "Updatepaket")"
[[ "$package" == *.zip ]] || gp_die "Das Linux-Serverupdate muss als ZIP-Paket vorliegen."
if [[ -n "$sha256_file_arg" ]]; then
  sha256_file="$(gp_existing_file "$sha256_file_arg" "SHA256-Datei")"
elif [[ -z "$sha256_arg" ]]; then
  sha256_file="$(gp_existing_file "$package.sha256" "SHA256-Datei")"
else
  sha256_file=""
fi
if [[ -n "$sha256_file" ]]; then
  sha256_arg="$(awk 'NR == 1 { print $1; exit }' "$sha256_file")"
fi
gp_validate_sha256 "$sha256_arg"
actual_package_sha256=""
commit_marker=""
if [[ -n "$commit_marker_arg" ]]; then
  commit_marker="$(gp_safe_absolute_path "$commit_marker_arg" "Updater-Commitmarker")"
  commit_marker_parent="$(dirname -- "$commit_marker")"
  [[ "$commit_marker_parent" =~ ^/opt/grabenplaner/\.runtime-v(2|3)-migration\.[A-Za-z0-9]+$ \
    && -d "$commit_marker_parent" && ! -L "$commit_marker_parent" \
    && "$(stat --format='%u:%g:%a' -- "$commit_marker_parent")" == "0:0:711" \
    && ! -e "$commit_marker" && ! -L "$commit_marker" ]] \
    || gp_die "Der Updater-Commitmarker ist nicht sicher an eine freigegebene Runtime-Migration gebunden."
fi

gp_path_is_same_or_child "$database" "$data_dir" || gp_die "DB_PATH muss innerhalb des geschuetzten Datenordners liegen."
gp_path_is_same_or_child "$amu_dir" "$data_dir" || gp_die "Der Dokumentordner muss innerhalb des geschuetzten Datenordners liegen."
gp_assert_separate_trees "$app_dir" "$data_dir" "App- und Datenordner"
gp_assert_separate_trees "$backup_dir" "$data_dir" "Backup- und Datenordner"
gp_assert_separate_trees "$backup_dir" "$app_dir" "Backup- und App-Ordner"
gp_require_systemd_unit "$service"
gp_require_systemd_unit "$caddy_service"
systemctl is-active --quiet "$service" || gp_die "$service muss vor dem Update aktiv sein."
systemctl is-active --quiet "$caddy_service" || gp_die "$caddy_service muss vor dem Update aktiv sein."
trusted_package_verifier="$app_dir/server-tools/linux/lib/verify-package.js"
trusted_tree_verifier="$app_dir/server-tools/linux/lib/verify-install-tree.js"
[[ -f "$trusted_package_verifier" && ! -L "$trusted_package_verifier" ]] || gp_die "Die installierte vertrauenswuerdige Paketpruefung fehlt."
[[ -f "$trusted_tree_verifier" && ! -L "$trusted_tree_verifier" ]] || gp_die "Die installierte vertrauenswuerdige Baumpruefung fehlt."

internal_live_url="http://127.0.0.1:$port/api/health/live"
internal_ready_url="http://127.0.0.1:$port/api/health/ready"
public_live_url="${public_url%/}/api/health/live"
public_ready_url="${public_url%/}/api/health/ready"
gp_url_reports_ready "$internal_live_url" 8 || gp_die "Der laufende Grabenplaner beantwortet den internen Livenesscheck nicht."
gp_url_reports_ready "$public_live_url" 15 || gp_die "Der laufende Grabenplaner ist ueber Caddy/HTTPS nicht erreichbar."
gp_url_reports_ready "$internal_ready_url" 8 || gp_die "Der laufende Grabenplaner ist intern nicht vollstaendig betriebsbereit."
gp_url_reports_ready "$public_ready_url" 15 || gp_die "Der laufende Grabenplaner ist oeffentlich nicht vollstaendig betriebsbereit."

app_parent="$(dirname -- "$app_dir")"
gp_path_is_same_or_child "$app_dir" "$app_parent" || gp_die "Der App-Pfad ist ungueltig."
maintenance_root="$(mktemp --directory --tmpdir="$app_parent" .grabenplaner-update.XXXXXXXX)"
chown root:root -- "$maintenance_root"
chmod 0711 -- "$maintenance_root"
extract_root="$maintenance_root/extract"
pnpm_store="$maintenance_root/pnpm-store"
rollback_root="$maintenance_root/previous-app"
staged_package="$maintenance_root/update-package.zip"
entries_file="$maintenance_root/archive-entries.txt"
manifest_result_file="$maintenance_root/manifest-result.json"
installed_runtime_result_file="$maintenance_root/installed-runtime-result.json"
backup_result_file="$maintenance_root/backup-result.json"
database_lock_state="$maintenance_root/database-lock"
install -d -m 0700 -o "$service_user" -g "$service_group" -- "$database_lock_state"
database_lock_ready="$database_lock_state/ready"
database_lock_error="$maintenance_root/database-lock.error"
history_dir="$data_dir/maintenance/history"
mkdir -m 0750 -- "$extract_root"

services_touched=0
old_app_moved=0
new_service_started=0
update_committed=0
database_lock_pid=""
database_lock_runner_pid=""
database_lock_helper=""
backup_database=""
backup_amu=""
candidate_version=""
old_version="$("$node" -p "require(process.argv[1]).version" "$app_dir/package.json")"
rollback_data_ok=1
rollback_public_ok=1
rollback_app_ok=1
rollback_stop_ok=1

write_receipt() {
  local status="$1"
  local error_text="${2:-}"
  install -d -m 0750 -o root -g "$service_group" -- "$history_dir"
  local receipt="$history_dir/update-$(date --utc '+%Y-%m-%dT%H-%M-%S-%3N').json"
  "$node" - "$receipt" "$status" "$old_version" "$candidate_version" "$(basename -- "$package")" "$actual_package_sha256" \
    "$backup_database" "$error_text" "$rollback_stop_ok" "$rollback_app_ok" "$rollback_data_ok" "$rollback_public_ok" <<'NODE'
const fs = require("node:fs");
const [file, status, previousVersion, requestedVersion, packageFile, packageSha256, backupFile, error, rollbackStop, rollbackApp, rollbackData, rollbackPublic] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  status,
  completedAt: new Date().toISOString(),
  previousVersion,
  requestedVersion: requestedVersion || null,
  packageFile,
  packageSha256,
  backupFile: backupFile || null,
  error: error || null,
  rollbackServiceStopped: rollbackStop === "1",
  rollbackAppReady: rollbackApp === "1",
  rollbackDataReady: rollbackData === "1",
  rollbackPublicReady: rollbackPublic === "1",
}, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
NODE
  chown "root:$service_group" -- "$receipt"
  chmod 0640 -- "$receipt"
  printf '%s\n' "$receipt"
}

commit_marker_is_valid() {
  [[ -n "$commit_marker" && -f "$commit_marker" && ! -L "$commit_marker" ]] || return 1
  "$node" - "$commit_marker" "$candidate_version" "$actual_package_sha256" <<'NODE' >/dev/null
const fs=require("node:fs");const [file,version,sha]=process.argv.slice(2);
const stat=fs.lstatSync(file);const value=JSON.parse(fs.readFileSync(file,"utf8"));
if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o077)!==0||value?.format!=="grabenplaner-update-commit"||value?.schemaVersion!==1||value?.status!=="committed"||value?.installedVersion!==version||value?.packageSha256!==sha||!Number.isFinite(Date.parse(value?.committedAt||"")))process.exit(1);
NODE
}

write_commit_marker() {
  [[ -n "$commit_marker" ]] || return 0
  "$node" - "$commit_marker" "$candidate_version" "$actual_package_sha256" "$receipt" <<'NODE'
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const [file,installedVersion,packageSha256,receipt]=process.argv.slice(2);
const parent=path.dirname(file);const temporary=path.join(parent,`.updater-commit.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
const payload={format:"grabenplaner-update-commit",schemaVersion:1,status:"committed",committedAt:new Date().toISOString(),installedVersion,packageSha256,updateReceipt:path.basename(receipt)};
let fd,dir;
try{fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);fs.writeFileSync(fd,`${JSON.stringify(payload,null,2)}\n`);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.chownSync(temporary,0,0);fs.chmodSync(temporary,0o600);fs.renameSync(temporary,file);dir=fs.openSync(parent,fs.constants.O_RDONLY);fs.fsyncSync(dir);}finally{if(fd!==undefined)try{fs.closeSync(fd)}catch{}if(dir!==undefined)try{fs.closeSync(dir)}catch{}try{fs.unlinkSync(temporary)}catch{}}
NODE
  commit_marker_is_valid || gp_die "Der dauerhafte Updater-Commitmarker konnte nicht bestaetigt werden."
}

database_lock_process_is_expected() {
  [[ -n "$database_lock_pid" && "$database_lock_pid" =~ ^[0-9]+$ && -r "/proc/$database_lock_pid/status" && -r "/proc/$database_lock_pid/cmdline" ]] || return 1
  local expected_uid actual_uid command_line
  expected_uid="$(id -u "$service_user")"
  actual_uid="$(awk '/^Uid:/ { print $2; exit }' "/proc/$database_lock_pid/status")"
  command_line="$(tr '\0' ' ' <"/proc/$database_lock_pid/cmdline")"
  [[ "$actual_uid" == "$expected_uid" && "$command_line" == *"$database_lock_helper"* && "$command_line" == *"$database"* ]]
}

release_database_lock() {
  if [[ -n "$database_lock_pid" ]]; then
    if database_lock_process_is_expected; then
      kill -TERM "$database_lock_pid" 2>/dev/null || true
      local deadline=$((SECONDS + 10))
      while kill -0 "$database_lock_pid" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
      if kill -0 "$database_lock_pid" 2>/dev/null && database_lock_process_is_expected; then
        kill -KILL "$database_lock_pid" 2>/dev/null || true
      fi
    else
      gp_warn "Der Datenbank-Wartungslockprozess ist nicht mehr eindeutig zuordenbar; es wird kein fremder PID beendet."
    fi
    database_lock_pid=""
  fi
  if [[ -n "$database_lock_runner_pid" ]]; then
    wait "$database_lock_runner_pid" 2>/dev/null || true
    database_lock_runner_pid=""
  fi
}

start_database_lock() {
  local helper="$app_dir/server-tools/linux/lib/hold-database-lock.js"
  local module="$app_dir/lib/database-lock.js"
  local previous_directory="$PWD"
  [[ -f "$helper" && -f "$module" ]] || gp_die "Datenbank-Wartungslockmodule fehlen."
  database_lock_helper="$helper"
  cd -- "$data_dir"
  runuser --user "$service_user" -- env -i PATH="/usr/local/bin:/usr/bin:/bin" NODE_ENV=production \
    "$node" "$helper" "$module" "$database" "$database_lock_ready" >/dev/null 2>"$database_lock_error" &
  database_lock_runner_pid=$!
  cd -- "$previous_directory"
  local deadline=$((SECONDS + 10))
  while [[ ! -f "$database_lock_ready" ]]; do
    if ! kill -0 "$database_lock_runner_pid" 2>/dev/null; then
      gp_die "Der Datenbank-Wartungslock konnte nicht gesetzt werden."
    fi
    (( SECONDS < deadline )) || gp_die "Zeitueberschreitung beim Datenbank-Wartungslock."
    sleep 1
  done
  database_lock_pid="$(tr -d '[:space:]' <"$database_lock_ready")"
  [[ "$database_lock_pid" =~ ^[0-9]+$ ]] && kill -0 "$database_lock_pid" 2>/dev/null \
    || gp_die "Der Datenbank-Wartungslock meldete keinen gueltigen Prozess."
}

rollback_update() {
  set +e
  gp_warn "Das Update ist fehlgeschlagen; automatischer Rollback wird ausgefuehrt."
  rollback_stop_ok=0
  systemctl stop "$service" >/dev/null 2>&1
  rollback_service_state="$(systemctl is-active "$service" 2>/dev/null || true)"
  if [[ "$rollback_service_state" == "inactive" || "$rollback_service_state" == "failed" ]]; then
    rollback_stop_ok=1
  else
    gp_log ERROR "$service konnte fuer den Rollback nicht sicher beendet werden (Status: ${rollback_service_state:-unbekannt}). App und Daten werden nicht destruktiv veraendert."
  fi
  release_database_lock
  rollback_app_ok="$rollback_stop_ok"
  if (( rollback_stop_ok == 1 && old_app_moved == 1 )) && [[ -d "$rollback_root" && ! -L "$rollback_root" ]]; then
    rollback_app_ok=0
    replacement_removed=1
    if [[ -e "$app_dir" || -L "$app_dir" ]]; then
      replacement_removed=0
      if [[ -d "$app_dir" && ! -L "$app_dir" ]] && rm -rf -- "$app_dir" && [[ ! -e "$app_dir" && ! -L "$app_dir" ]]; then
        replacement_removed=1
      else
        gp_log ERROR "Der fehlgeschlagene neue App-Baum konnte nicht sicher entfernt werden; die vorherige App bleibt unter $rollback_root erhalten."
      fi
    fi
    if (( replacement_removed == 1 )) && mv -T -- "$rollback_root" "$app_dir" \
      && [[ -d "$app_dir" && ! -L "$app_dir" && ! -e "$rollback_root" ]]; then
      rollback_app_ok=1
      old_app_moved=0
    else
      gp_log ERROR "Der vorherige App-Baum konnte nicht vollstaendig zurueckverschoben werden; das Wartungsverzeichnis bleibt erhalten."
    fi
  elif (( rollback_stop_ok == 1 && old_app_moved == 1 )); then
    rollback_app_ok=0
    gp_log ERROR "Der vorherige App-Baum fehlt oder ist unzulaessig; das Wartungsverzeichnis bleibt zur Analyse erhalten."
  fi
  rollback_data_ok="$rollback_stop_ok"
  if (( rollback_app_ok == 1 && new_service_started == 1 )) && [[ -n "$backup_database" && -f "$backup_database" && -d "$backup_amu" ]]; then
    rollback_helper="$app_dir/server-tools/linux/lib/restore-backup.js"
    if [[ -f "$rollback_helper" ]] && (cd -- "$data_dir" && runuser --user "$service_user" -- env -i PATH="/usr/local/bin:/usr/bin:/bin" NODE_ENV=production \
      "$node" "$rollback_helper" "$backup_database" "$backup_amu" "$database" "$amu_dir" \
      "$app_dir/lib/database-lock.js" "$app_dir/lib/amu-storage.js" >/dev/null); then
      chown "$service_user:$service_group" -- "$database"
      chmod 0640 -- "$database"
      chown -R "$service_user:$service_group" -- "$amu_dir"
    else
      rollback_data_ok=0
      gp_log ERROR "Der gekoppelte Datenrollback ist fehlgeschlagen; sofortiger manueller IT-Eingriff ist erforderlich."
    fi
  fi
  rollback_public_ok=0
  if (( rollback_app_ok == 1 && rollback_data_ok == 1 )) && [[ -d "$app_dir" && ! -L "$app_dir" ]]; then
    systemctl start "$service"
    if gp_wait_ready "$internal_ready_url" "$health_timeout" && gp_wait_ready "$public_ready_url" "$health_timeout"; then
      rollback_public_ok=1
      gp_warn "Vorherige App- und Datenversion wurden wiederhergestellt und sind wieder erreichbar."
    else
      gp_log ERROR "Die vorherige Version ist nach dem Rollback nicht HTTPS-bereit."
    fi
  fi
  rollback_status="rolled-back"
  if (( rollback_stop_ok == 0 || rollback_app_ok == 0 || rollback_data_ok == 0 || rollback_public_ok == 0 )); then rollback_status="rollback-incomplete"; fi
  write_receipt "$rollback_status" "Updateprozess mit Exitcode $1 fehlgeschlagen." >/dev/null 2>&1
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  release_database_lock
  if (( update_committed == 0 )) && commit_marker_is_valid; then update_committed=1; fi
  if (( exit_code != 0 && services_touched == 1 && update_committed == 0 )); then
    rollback_update "$exit_code"
  fi
  if [[ -d "$maintenance_root" && ! -L "$maintenance_root" ]] && gp_path_is_same_or_child "$maintenance_root" "$app_parent"; then
    if (( update_committed == 1 || (old_app_moved == 0 && rollback_app_ok == 1) )); then rm -rf -- "$maintenance_root"; fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT

create_exact_local_backup() {
  local backup_script="$app_dir/server-tools/linux/backup-grabenplaner.sh"
  [[ -x "$backup_script" ]] || gp_die "Installiertes Linux-Backupwerkzeug fehlt: $backup_script"
  "$backup_script" --env-file "$env_file" --app-dir "$app_dir" --data-dir "$data_dir" --database "$database" \
    --backup-dir "$backup_dir" --keep "$backup_keep" --service "$service" --node "$node" \
    --service-user "$service_user" --service-group "$service_group" --lock-already-held >"$backup_result_file"
  backup_database="$("$node" -e 'const fs=require("node:fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).path))' "$backup_result_file")"
  backup_amu="$("$node" -e 'const fs=require("node:fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).amuBackup))' "$backup_result_file")"
  [[ -f "$backup_database" && -d "$backup_amu" ]] || gp_die "Das Sicherheitsbackup vor dem Update ist unvollstaendig."
}

install -m 0600 -o root -g root -- "$package" "$staged_package"
actual_package_sha256="$(gp_sha256 "$staged_package")"
[[ "$actual_package_sha256" == "${sha256_arg,,}" ]] \
  || gp_die "Die Paketpruefsumme stimmt nicht; das Update wurde vor dem Entpacken abgebrochen."
chown "root:$build_group" -- "$staged_package"
chmod 0640 -- "$staged_package"
chown "$build_user:$build_group" -- "$extract_root"
chmod 0750 -- "$extract_root"
install -d -m 0700 -o "$build_user" -g "$build_group" -- "$pnpm_store"

gp_info "Pruefe ZIP-Struktur und entpackte Maximalgroesse."
zip_summary="$(unzip -Z -t "$staged_package")" || gp_die "Das ZIP-Zentralverzeichnis kann nicht gelesen werden."
declared_entry_count="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ { print $1; exit }')"
declared_expanded_bytes="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ { print $3; exit }')"
[[ "$declared_entry_count" =~ ^[0-9]+$ && "$declared_expanded_bytes" =~ ^[0-9]+$ ]] \
  || gp_die "Die ZIP-Groessenangaben sind ungueltig."
(( declared_entry_count > 0 && declared_entry_count <= 100000 )) || gp_die "Das ZIP enthaelt keine oder zu viele Eintraege."
(( declared_expanded_bytes <= maximum_expanded_bytes )) || gp_die "Das entpackte Paket ueberschreitet die freigegebene Maximalgroesse."
zip_listing="$(unzip -Z -l "$staged_package")" || gp_die "Die ZIP-Dateitypen koennen nicht gelesen werden."
parsed_modes=0
while IFS= read -r mode; do
  ((parsed_modes += 1))
  case "${mode:0:1}" in
    -|d) ;;
    *) gp_die "Links, Sockets und Spezialdateien sind im Serverpaket nicht erlaubt." ;;
  esac
done < <(printf '%s\n' "$zip_listing" | awk '$1 ~ /^[-dlbcps]/ && $2 ~ /^[0-9]/ { print $1 }')
(( parsed_modes == declared_entry_count )) || gp_die "Nicht alle ZIP-Dateitypen konnten sicher bestimmt werden."
unzip -tq "$staged_package" >/dev/null || gp_die "Das Server-ZIP ist beschaedigt oder unvollstaendig."
unzip -Z1 "$staged_package" >"$entries_file" || gp_die "Die ZIP-Dateiliste kann nicht gelesen werden."
declare -A archive_entries=()
entry_count=0
while IFS= read -r entry; do
  ((entry_count += 1))
  normalized_entry="${entry#./}"
  [[ -n "$normalized_entry" ]] || continue
  [[ ! "$entry" =~ [[:cntrl:]] && "$normalized_entry" != /* && "$normalized_entry" != *\\* ]] \
    || gp_die "Ungueltiger ZIP-Pfad im Serverpaket."
  normalized_entry="${normalized_entry%/}"
  [[ -n "$normalized_entry" && -z "${archive_entries[$normalized_entry]+x}" ]] || gp_die "Doppelter ZIP-Pfad im Serverpaket."
  archive_entries["$normalized_entry"]=1
  IFS=/ read -ra path_segments <<<"$normalized_entry"
  for path_segment in "${path_segments[@]}"; do
    [[ -n "$path_segment" && "$path_segment" != "." && "$path_segment" != ".." ]] || gp_die "Ein ZIP-Pfad ist nicht kanonisch."
  done
done <"$entries_file"
(( entry_count == declared_entry_count )) || gp_die "ZIP-Dateiliste und Zentralverzeichnis sind inkonsistent."
(cd -- "$build_cache" && runuser --user "$build_user" -- unzip -qq "$staged_package" -d "$extract_root")
actual_expanded_bytes="$(du --bytes --summarize "$extract_root" | awk '{print $1}')"
(( actual_expanded_bytes <= maximum_expanded_bytes )) || gp_die "Die tatsaechlich entpackte Paketgroesse ist zu gross."

"$node" "$trusted_package_verifier" "$extract_root" >"$manifest_result_file" || gp_die "Die Einzeldatei- und Manifestpruefung ist fehlgeschlagen."
"$node" "$trusted_package_verifier" --runtime-contract "$app_dir" >"$installed_runtime_result_file" \
  || gp_die "Der installierte Linux-Runtimevertrag ist ungueltig; das Update erfordert eine explizite Serverwartung."
runtime_gate="$("$node" - "$installed_runtime_result_file" "$manifest_result_file" <<'NODE'
const fs = require("node:fs");
const [installedFile, candidateFile] = process.argv.slice(2);
const installed = JSON.parse(fs.readFileSync(installedFile, "utf8"));
const candidate = JSON.parse(fs.readFileSync(candidateFile, "utf8")).runtimeContract;
if (!candidate) process.stdout.write("invalid-candidate");
else if (installed.deploymentSchemaVersion !== candidate.deploymentSchemaVersion) {
  process.stdout.write(`migration-required:${installed.deploymentSchemaVersion}->${candidate.deploymentSchemaVersion}`);
} else if (installed.fingerprint !== candidate.fingerprint) {
  process.stdout.write("schema-not-incremented");
} else process.stdout.write("compatible");
NODE
)"
case "$runtime_gate" in
  compatible) ;;
  migration-required:*)
    gp_die "Das Update aendert den Linux-Deploymentvertrag ($runtime_gate). systemd, Caddy, Bootstrap und Env werden nicht blind ueberschrieben; bitte die freigegebene Servermigration ausfuehren."
    ;;
  schema-not-incremented)
    gp_die "Runtime-Artefakte wurden geaendert, ohne die Deployment-Schemaversion zu erhoehen. Das Paket wird aus Sicherheitsgruenden abgelehnt."
    ;;
  *) gp_die "Der Runtimevertrag des Updatepakets konnte nicht sicher verglichen werden." ;;
esac
installed_runtime_schema="$("$node" -e \
  'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).deploymentSchemaVersion))' \
  "$installed_runtime_result_file")"
if [[ "$installed_runtime_schema" == "3" ]]; then
  host_control_group="grabenplaner-host-control"
  host_control_module="/opt/grabenplaner-host-control/module"
  host_control_socket_unit="/etc/systemd/system/grabenplaner-host-control.socket"
  host_control_worker_unit="/etc/systemd/system/grabenplaner-host-control@.service"
  host_reboot_unit="/etc/systemd/system/grabenplaner-host-reboot.service"
  host_control_socket="/run/grabenplaner-host-control/request.sock"
  host_control_members="$(getent group "$host_control_group" | awk -F: 'NR == 1 { print $4 }')" \
    || gp_die "Die geschuetzte Host-Control-Gruppe fehlt."
  host_control_gid="$(getent group "$host_control_group" | awk -F: 'NR == 1 { print $3 }')"
  [[ "$host_control_gid" =~ ^[0-9]+$
    && -z "$(getent passwd | awk -F: -v gid="$host_control_gid" '$4 == gid { print $1 }')" ]] \
    || gp_die "Die Host-Control-Gruppe darf fuer keinen Benutzer Hauptgruppe sein."
  [[ "$host_control_members" == "$service_user" ]] \
    || gp_die "Nur der Grabenplaner-Dienstbenutzer darf Mitglied der Host-Control-Gruppe sein."
  id -nG "$service_user" | tr ' ' '\n' | grep -Fxq "$host_control_group" \
    || gp_die "Der Dienstbenutzer ist nicht sicher an den Host-Control-Socket gebunden."
  [[ -d "$host_control_module" && ! -L "$host_control_module" ]] \
    || gp_die "Das root-geschuetzte Host-Control-Modul fehlt."
  [[ -z "$(find "$host_control_module" -xdev \( ! -user root -o ! -group root -o -perm /022 \) -print -quit)" \
    && -z "$(find "$host_control_module" -xdev ! -type f ! -type d -print -quit)" ]] \
    || gp_die "Das Host-Control-Modul besitzt unsichere Eigentumsrechte oder Dateitypen."
  "$node" - "$host_control_module" "$app_dir/server-tools/linux/host-control" <<'NODE' >/dev/null \
    || gp_die "Die installierte Host-Control-Modulkopie weicht vom Runtimevertrag ab."
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
function inventory(root) {
  const found = [];
  function walk(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) process.exit(1);
      if (stat.isDirectory()) {
        found.push(`d:${relative}`);
        walk(target, relative);
      } else if (stat.isFile()) {
        const hash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
        found.push(`f:${relative}:${hash}`);
      } else process.exit(1);
    }
  }
  walk(root);
  return found.sort();
}
if (JSON.stringify(inventory(process.argv[2])) !== JSON.stringify(inventory(process.argv[3]))) process.exit(1);
NODE
  installed_host_broker="$host_control_module/lib/host-reboot-broker.js"
  app_host_broker="$app_dir/server-tools/linux/host-control/lib/host-reboot-broker.js"
  [[ -f "$installed_host_broker" && ! -L "$installed_host_broker" \
    && "$(stat --format='%u:%g:%a:%h' -- "$installed_host_broker")" == "0:0:644:1" ]] \
    || gp_die "Der installierte Host-Control-Broker ist ungueltig."
  cmp --silent -- "$installed_host_broker" "$app_host_broker" \
    || gp_die "Der installierte Host-Control-Broker weicht vom Runtimevertrag ab."

  host_control_render_root="$maintenance_root/host-control-runtime"
  install -d -m 0700 -o root -g root -- "$host_control_render_root"
  resolved_node="$(readlink -f -- "$node")"
  "$node" - "$app_dir" "$host_control_render_root" "$resolved_node" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [appRoot, outputRoot, nodeExecutable] = process.argv.slice(2);
const templates = new Map([
  ["grabenplaner-host-control.socket", "grabenplaner-host-control.socket.in"],
  ["grabenplaner-host-control@.service", "grabenplaner-host-control@.service.in"],
  ["grabenplaner-host-reboot.service", "grabenplaner-host-reboot.service.in"],
]);
for (const [target, source] of templates) {
  let content = fs.readFileSync(path.join(appRoot, "server-tools/linux/host-control/systemd", source), "utf8");
  content = content.replaceAll("{{NODE_EXECUTABLE}}", nodeExecutable);
  if (/\{\{[A-Z0-9_]+\}\}/.test(content)) process.exit(1);
  fs.writeFileSync(path.join(outputRoot, target), content, { mode: 0o600 });
}
NODE
  for host_unit in grabenplaner-host-control.socket grabenplaner-host-control@.service grabenplaner-host-reboot.service; do
    installed_host_unit="/etc/systemd/system/$host_unit"
    [[ -f "$installed_host_unit" && ! -L "$installed_host_unit" \
      && "$(stat --format='%u:%g:%a:%h' -- "$installed_host_unit")" == "0:0:644:1" ]] \
      || gp_die "Eine installierte Host-Control-Unit ist ungueltig: $host_unit"
    cmp --silent -- "$installed_host_unit" "$host_control_render_root/$host_unit" \
      || gp_die "Eine installierte Host-Control-Unit weicht vom Runtimevertrag ab: $host_unit"
  done
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "$host_control_socket_unit" "$host_control_worker_unit" "$host_reboot_unit" >/dev/null \
      || gp_die "Die installierten Host-Control-Units sind nicht valide."
  fi
  systemctl is-enabled --quiet grabenplaner-host-control.socket \
    || gp_die "Der Host-Control-Socket ist nicht aktiviert."
  systemctl is-active --quiet grabenplaner-host-control.socket \
    || gp_die "Der Host-Control-Socket ist nicht aktiv."
  [[ -S "$host_control_socket" \
    && "$(stat --format='%U:%G:%a' -- "$host_control_socket")" == "root:${host_control_group}:660" ]] \
    || gp_die "Der Host-Control-Socket besitzt nicht den freigegebenen Zugriffsschutz."
  if systemctl is-active --quiet grabenplaner-host-reboot.service; then
    gp_die "Ein Host-Neustart ist bereits aktiv; das App-Update wird nicht parallel gestartet."
  fi
fi
if [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == "1" ]]; then
  installed_offsite_receipt="/etc/grabenplaner/offsite/installed-contract.json"
  [[ -f "$installed_offsite_receipt" && ! -L "$installed_offsite_receipt" \
    && "$(stat --format='%u:%g:%a:%h' -- "$installed_offsite_receipt")" == "0:0:600:1" ]] \
    || gp_die "Der Installationsbeleg des eingerichteten Offsite-Moduls ist ungueltig."
  offsite_gate_helper="$SCRIPT_DIR/lib/offsite-update-compat.js"
  service_group_gid="$(getent group "$service_group" | awk -F: 'NR == 1 { print $3 }')" \
    || gp_die "Die Dienstgruppe der installierten Offsite-Kompatibilitaetspruefung kann nicht aufgeloest werden."
  [[ "$service_group_gid" =~ ^[0-9]+$ ]] \
    || gp_die "Die Dienstgruppe der installierten Offsite-Kompatibilitaetspruefung ist ungueltig."
  [[ -f "$offsite_gate_helper" && ! -L "$offsite_gate_helper" \
    && "$(stat --format='%u:%g:%h' -- "$offsite_gate_helper")" == "0:$service_group_gid:1" ]] \
    || gp_die "Die installierte Offsite-Kompatibilitaetspruefung ist ungueltig."
  offsite_gate_helper_mode="$(stat --format='%a' -- "$offsite_gate_helper")"
  (( (8#$offsite_gate_helper_mode & 022) == 0 )) \
    || gp_die "Die installierte Offsite-Kompatibilitaetspruefung hat unsichere Dateirechte."
  offsite_module_gate="$("$node" "$offsite_gate_helper" "$manifest_result_file" "$installed_offsite_receipt")" \
    || gp_die "Der Vertrag des eingerichteten Offsite-Moduls konnte nicht sicher verglichen werden."
  case "$offsite_module_gate" in
    compatible|compatible-installer-only) ;;
    migration-required:*)
      gp_die "Das Update aendert das eingerichtete Offsite-Modul ($offsite_module_gate). Bitte zuerst die explizit freigegebene Offsite-Migration ausfuehren."
      ;;
    *) gp_die "Der Vertrag des eingerichteten Offsite-Moduls konnte nicht sicher verglichen werden." ;;
  esac
fi
candidate_version="$("$node" -e 'const fs=require("node:fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).appVersion))' "$manifest_result_file")"
required_pnpm="$("$node" -e 'const fs=require("node:fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).packageManager).split("@").pop())' "$manifest_result_file")"
if (( allow_downgrade == 0 )); then
  version_comparison="$(gp_compare_semver "$node" "$old_version" "$candidate_version")"
  (( version_comparison < 0 )) || gp_die "Gleiche oder aeltere App-Versionen erfordern --allow-downgrade-or-reinstall."
fi
actual_pnpm="$(cd -- "$build_cache" && runuser --user "$build_user" -- env -i \
  HOME="$build_cache" XDG_CACHE_HOME="$build_cache" PNPM_HOME="$build_cache/pnpm" COREPACK_HOME="$build_cache/corepack" \
  PATH="$(dirname -- "$node"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$pnpm_program" "${pnpm_arguments[@]}" --version)"
[[ "$actual_pnpm" == "$required_pnpm" ]] || gp_die "Das Paket erfordert pnpm $required_pnpm; installiert ist $actual_pnpm."

gp_info "Installiere eingefrorene Produktionsabhaengigkeiten im isolierten Stagingordner."
chown -R "$build_user:$build_group" -- "$extract_root"
chmod 0750 -- "$extract_root"
(cd -- "$build_cache" && runuser --user "$build_user" -- env -i \
  HOME="$build_cache" XDG_CACHE_HOME="$build_cache" PNPM_HOME="$build_cache/pnpm" COREPACK_HOME="$build_cache/corepack" \
  PATH="$(dirname -- "$node"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" NODE_ENV=production \
  "$pnpm_program" "${pnpm_arguments[@]}" --dir "$extract_root" install --prod --frozen-lockfile \
    --config.node-linker=hoisted --store-dir "$pnpm_store" --package-import-method=copy)
[[ -d "$extract_root/node_modules" && ! -L "$extract_root/node_modules" ]] || gp_die "node_modules fehlt nach dem Produktionsinstall."
"$node" "$trusted_tree_verifier" "$extract_root" >/dev/null || gp_die "Der installierte Abhaengigkeitsbaum enthaelt unzulaessige Links oder Dateitypen."
(cd -- "$build_cache" && runuser --user "$build_user" -- env -i PATH="$(dirname -- "$node"):/usr/local/bin:/usr/bin:/bin" NODE_ENV=production \
  "$node" - "$extract_root" <<'NODE' >/dev/null
const path = require("node:path");
const root = process.argv[2];
const metadata = require(path.join(root, "package.json"));
for (const dependency of Object.keys(metadata.dependencies || {})) require.resolve(dependency, { paths: [root] });
for (const dependency of ["express", "sharp", "pdfkit"]) require(require.resolve(dependency, { paths: [root] }));
NODE
)
gp_info "Pruefe den vollstaendigen Stagingordner mit ClamAV."
clamscan --recursive --infected --no-summary -- "$extract_root" >/dev/null \
  || gp_die "ClamAV hat das Updatepaket abgelehnt oder konnte es nicht vollstaendig pruefen."
gp_apply_app_permissions "$extract_root" "$service_group"

if (( lock_already_held == 1 )); then
  inherited_lock_target="$(readlink -f -- /proc/$$/fd/9 2>/dev/null || true)"
  expected_lock_target="$(gp_resolve_path "$GP_DEFAULT_MAINTENANCE_LOCK")"
  [[ "$inherited_lock_target" == "$expected_lock_target" ]] \
    || gp_die "Die uebernommene Wartungssperre ist nicht eindeutig gebunden."
  flock --nonblock 9 || gp_die "Die uebernommene Wartungssperre ist nicht aktiv."
else
  gp_acquire_maintenance_lock
fi
services_touched=1
gp_stop_service "$service" 150
create_exact_local_backup

# Das Offsite-Modul wird ausschliesslich durch seine root-only Einrichtung
# aktiviert. Der Hook bekommt nur den bereits verifizierten lokalen
# Sicherungsbeleg; ein fehlgeschlagener Upload bricht das Update vor dem
# App-Tausch ab und loest damit den normalen Rollback aus.
if [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == "1" ]]; then
  [[ "${GRABENPLANER_OFFSITE_STATUS_FILE:-}" == "/var/lib/grabenplaner-offsite/status.json" ]] \
    || gp_die "Die Offsite-Konfiguration ist unvollstaendig oder unzulaessig."
  offsite_pre_update_hook="/usr/local/sbin/grabenplaner-offsite-pre-update"
  [[ -x "$offsite_pre_update_hook" ]] || gp_die "Der eingerichtete Offsite-Pre-Update-Hook fehlt oder ist nicht ausfuehrbar."
  offsite_pre_update_target="$(readlink -f -- "$offsite_pre_update_hook")"
  [[ "$offsite_pre_update_target" == "/opt/grabenplaner-offsite/module/grabenplaner-offsite-pre-update.sh" \
    && -f "$offsite_pre_update_target" && ! -L "$offsite_pre_update_target" ]] \
    || gp_die "Der eingerichtete Offsite-Pre-Update-Hook hat kein freigegebenes Ziel."
  gp_info "Starte den bisherigen Grabenplaner vor der externen Uebertragung wieder."
  gp_start_service "$service"
  gp_wait_ready "$internal_ready_url" "$health_timeout" || gp_die "Der bisherige Grabenplaner wurde vor der Offsite-Sicherung intern nicht wieder bereit."
  gp_wait_ready "$public_ready_url" "$health_timeout" || gp_die "Der bisherige Grabenplaner wurde vor der Offsite-Sicherung oeffentlich nicht wieder bereit."
  gp_info "Uebertrage den exakt verifizierten lokalen Sicherungspunkt vor dem App-Update ins Offsite-Repository."
  "$offsite_pre_update_hook" --backup-result "$backup_result_file" --lock-already-held \
    || gp_die "Die Offsite-Sicherung vor dem Update ist fehlgeschlagen; das App-Update wurde nicht begonnen."
  gp_info "Erstelle unmittelbar vor dem App-Tausch einen aktuellen lokalen Rollback-Sicherungspunkt."
  gp_stop_service "$service" 150
  create_exact_local_backup
fi

start_database_lock
mv -- "$app_dir" "$rollback_root"
old_app_moved=1
mv -- "$extract_root" "$app_dir"
gp_apply_app_permissions "$app_dir" "$service_group"
release_database_lock

new_service_started=1
gp_start_service "$service"
gp_wait_ready "$internal_ready_url" "$health_timeout" || gp_die "Die neue App wurde intern nicht rechtzeitig betriebsbereit."
gp_wait_ready "$public_ready_url" "$health_timeout" || gp_die "Der oeffentliche HTTPS-Readinesscheck ist fehlgeschlagen."
receipt="$(write_receipt "success")"
write_commit_marker
update_committed=1

# Nach einem bereits erfolgreich und atomar abgeschlossenen App-Update wird
# zuerst ein signierter, fuer die App sichtbarer Queue-Beleg geschrieben und
# danach der komplette Recovery-Assurance-Lauf asynchron eingeplant. Ein Fehler
# an dieser Stelle darf das gesunde neue Release nicht mehr zurueckrollen.
if [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == "1" ]]; then
  offsite_common="/opt/grabenplaner-offsite/module/lib/offsite-common.sh"
  if ! (
    [[ -f "$offsite_common" && ! -L "$offsite_common" ]] || exit 1
    offsite_common_mode="$(stat --format='%a' -- "$offsite_common")"
    [[ "$(stat --format='%u:%g:%h' -- "$offsite_common")" == "0:0:1" \
      && $((8#$offsite_common_mode & 022)) -eq 0 ]] || exit 1
    # shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
    source "$offsite_common"
    offsite_acquire_assurance_lock
    offsite_assert_runtime_binaries
    offsite_record_assurance_queue update-queued app-updated "$candidate_version"
  ); then
    gp_warn "Das erfolgreiche App-Update konnte nicht im signierten Recovery-Assurance-Verlauf vorgemerkt werden."
  fi
  if ! systemctl start --no-block grabenplaner-offsite-assurance@app-updated.service >/dev/null; then
    gp_warn "Die Recovery-Assurance-Pruefung nach dem App-Update konnte nicht eingeplant werden."
  fi
fi

"$node" - "$old_version" "$candidate_version" "$actual_package_sha256" "$backup_database" "$receipt" "$public_ready_url" <<'NODE'
const [previousVersion, installedVersion, packageSha256, backup, receipt, publicReadiness] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({
  ok: true,
  previousVersion,
  installedVersion,
  packageSha256,
  backup,
  receipt,
  publicReadiness,
})}\n`);
NODE
gp_info "Grabenplaner wurde erfolgreich auf v$candidate_version aktualisiert."

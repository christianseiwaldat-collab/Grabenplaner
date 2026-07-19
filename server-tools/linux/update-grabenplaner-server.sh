#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
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
    -h|--help) usage; exit 0 ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

gp_require_root
for command_name in realpath flock sha256sum unzip zipinfo systemctl curl find sort stat du getent clamscan runuser; do gp_require_command "$command_name"; done
[[ "$(uname -m)" == "x86_64" ]] || gp_die "Das Serverpaket wird derzeit nur auf Linux x86_64 unterstuetzt."
[[ -n "$package_arg" ]] || gp_die "--package ist erforderlich."
[[ "$health_timeout" =~ ^[0-9]+$ ]] && (( health_timeout >= 30 && health_timeout <= 600 )) || gp_die "--health-timeout muss zwischen 30 und 600 liegen."
[[ "$maximum_expanded_bytes" =~ ^[0-9]+$ ]] && (( maximum_expanded_bytes >= 1048576 && maximum_expanded_bytes <= 4294967296 )) \
  || gp_die "--maximum-expanded-bytes liegt ausserhalb des erlaubten Bereichs."
[[ -z "$sha256_arg" || -z "$sha256_file_arg" ]] || gp_die "--sha256 und --sha256-file duerfen nicht gleichzeitig verwendet werden."

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
  if (( exit_code != 0 && services_touched == 1 && update_committed == 0 )); then
    rollback_update "$exit_code"
  fi
  if [[ -d "$maintenance_root" && ! -L "$maintenance_root" ]] && gp_path_is_same_or_child "$maintenance_root" "$app_parent"; then
    if (( update_committed == 1 || (old_app_moved == 0 && rollback_app_ok == 1) )); then rm -rf -- "$maintenance_root"; fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT

install -m 0600 -o root -g root -- "$package" "$staged_package"
actual_package_sha256="$(gp_sha256 "$staged_package")"
[[ "$actual_package_sha256" == "${sha256_arg,,}" ]] \
  || gp_die "Die Paketpruefsumme stimmt nicht; das Update wurde vor dem Entpacken abgebrochen."
chown "root:$build_group" -- "$staged_package"
chmod 0640 -- "$staged_package"
chown "$build_user:$build_group" -- "$extract_root"
chmod 0750 -- "$extract_root"

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
  "$pnpm_program" "${pnpm_arguments[@]}" --dir "$extract_root" install --prod --frozen-lockfile --config.node-linker=hoisted)
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

gp_acquire_maintenance_lock
services_touched=1
gp_stop_service "$service" 150

backup_script="$app_dir/server-tools/linux/backup-grabenplaner.sh"
[[ -x "$backup_script" ]] || gp_die "Installiertes Linux-Backupwerkzeug fehlt: $backup_script"
"$backup_script" --env-file "$env_file" --app-dir "$app_dir" --data-dir "$data_dir" --database "$database" \
  --backup-dir "$backup_dir" --keep "$backup_keep" --service "$service" --node "$node" \
  --service-user "$service_user" --service-group "$service_group" --lock-already-held >"$backup_result_file"
backup_database="$("$node" -e 'const fs=require("node:fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).path))' "$backup_result_file")"
backup_amu="$("$node" -e 'const fs=require("node:fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).amuBackup))' "$backup_result_file")"
[[ -f "$backup_database" && -d "$backup_amu" ]] || gp_die "Das Sicherheitsbackup vor dem Update ist unvollstaendig."

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
update_committed=1

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

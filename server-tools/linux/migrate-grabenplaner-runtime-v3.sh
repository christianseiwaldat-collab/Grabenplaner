#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Einmaliger, expliziter Wartungsweg fuer Deployment-Schema 2 -> 3.
# Das normale App-Update bleibt schema-starr. Diese Migration installiert den
# eng begrenzten root-verwalteten Host-Control-Socket und fuehrt danach den
# bewaehrten, backup- und rollback-faehigen App-Updater aus. Sie fordert oder
# startet selbst niemals einen Host-Neustart.

readonly SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

readonly APP_DIR="/opt/grabenplaner/app"
readonly DATA_DIR="/var/lib/grabenplaner"
readonly ENV_FILE="/etc/grabenplaner/grabenplaner.env"
readonly APP_SERVICE="grabenplaner.service"
readonly BOOTSTRAP_SERVICE="grabenplaner-bootstrap.service"
readonly CADDY_SERVICE="caddy.service"
readonly HOST_CONTROL_GROUP="grabenplaner-host-control"
readonly HOST_CONTROL_ROOT="/opt/grabenplaner-host-control"
readonly HOST_CONTROL_MODULE="$HOST_CONTROL_ROOT/module"
readonly HOST_CONTROL_SOCKET_NAME="grabenplaner-host-control.socket"
readonly HOST_CONTROL_WORKER_NAME="grabenplaner-host-control@.service"
readonly HOST_REBOOT_NAME="grabenplaner-host-reboot.service"
readonly HOST_CONTROL_SOCKET_UNIT="/etc/systemd/system/$HOST_CONTROL_SOCKET_NAME"
readonly HOST_CONTROL_WORKER_UNIT="/etc/systemd/system/$HOST_CONTROL_WORKER_NAME"
readonly HOST_REBOOT_UNIT="/etc/systemd/system/$HOST_REBOOT_NAME"
readonly HOST_CONTROL_SOCKET="/run/grabenplaner-host-control/request.sock"
readonly LIVE_OFFSITE_ROOT="/opt/grabenplaner-offsite"
readonly LIVE_OFFSITE_MODULE_ROOT="$LIVE_OFFSITE_ROOT/module"
readonly LIVE_OFFSITE_CONFIG_ROOT="/etc/grabenplaner/offsite"
readonly LIVE_OFFSITE_INSTALLED_CONTRACT="$LIVE_OFFSITE_CONFIG_ROOT/installed-contract.json"
readonly MAX_EXPANDED_BYTES=4294967296

package_arg=""
sha256_arg=""
sha256_file_arg=""
node_arg=""
pnpm_arg=""
health_timeout=120

usage() {
  cat <<'EOF'
Verwendung:
  sudo ./migrate-grabenplaner-runtime-v3.sh \
    --package /pfad/Grabenplaner-Server-v0.88.4-beta-linux-x64.zip \
    [--sha256 HEX | --sha256-file /pfad/paket.zip.sha256]

Dieser root-only Wartungsvorgang akzeptiert ausschliesslich den freigegebenen
Wechsel des Ubuntu-Deploymentvertrags von Schema 2 auf Schema 3. Er prueft und
sichert den bestehenden Zustand, installiert den lokalen Host-Control-Socket,
aktualisiert die App ueber den normalen Backup-/Rollback-Updater und schreibt
einen root-geschuetzten Beleg. Die Migration loest keinen VPS-Neustart aus.
EOF
}

while (($#)); do
  case "$1" in
    --package) package_arg="${2:?Wert fuer --package fehlt}"; shift 2 ;;
    --sha256) sha256_arg="${2:?Wert fuer --sha256 fehlt}"; shift 2 ;;
    --sha256-file) sha256_file_arg="${2:?Wert fuer --sha256-file fehlt}"; shift 2 ;;
    --node) node_arg="${2:?Wert fuer --node fehlt}"; shift 2 ;;
    --pnpm) pnpm_arg="${2:?Wert fuer --pnpm fehlt}"; shift 2 ;;
    --health-timeout) health_timeout="${2:?Wert fuer --health-timeout fehlt}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

gp_require_root
for command_name in awk bash chown chmod clamscan cmp cp curl date du find flock getent gpasswd grep groupadd groupdel id install mktemp mv paste readlink realpath rm rmdir runuser sed sha256sum sleep sort stat sync systemctl tr uname unzip usermod; do
  gp_require_command "$command_name"
done
[[ -n "$package_arg" ]] || gp_die "--package ist erforderlich."
[[ -z "$sha256_arg" || -z "$sha256_file_arg" ]] \
  || gp_die "--sha256 und --sha256-file duerfen nicht gemeinsam verwendet werden."
[[ "$health_timeout" =~ ^[0-9]+$ ]] && (( health_timeout >= 30 && health_timeout <= 600 )) \
  || gp_die "--health-timeout muss zwischen 30 und 600 liegen."

os_release_source="$(realpath --canonicalize-existing -- /etc/os-release)" \
  || gp_die "Ubuntu konnte nicht sicher erkannt werden."
case "$os_release_source" in
  /etc/os-release|/usr/lib/os-release) ;;
  *) gp_die "Die Betriebssystemkennung verweist auf einen unerwarteten Pfad." ;;
esac
[[ -f "$os_release_source" && ! -L "$os_release_source" ]] \
  || gp_die "Die Betriebssystemkennung ist unzulaessig."
[[ "$(stat --format='%u:%g:%h' -- "$os_release_source")" == "0:0:1" ]] \
  || gp_die "Die Betriebssystemkennung hat unsichere Eigentumsrechte."
os_release_mode="$(stat --format='%a' -- "$os_release_source")"
(( (8#$os_release_mode & 022) == 0 )) \
  || gp_die "Die Betriebssystemkennung hat unsichere Dateirechte."
# shellcheck disable=SC1091
source "$os_release_source"
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" =~ ^(24\.04|26\.04)$ && "$(uname -m)" == "x86_64" ]] \
  || gp_die "Die Runtime-v3-Migration unterstuetzt Ubuntu 24.04/26.04 auf x86_64."

if [[ -n "$node_arg" ]]; then
  node="$(gp_existing_file "$node_arg" "Node.js")"
else
  gp_require_command node
  node="$(readlink -f -- "$(command -v node)")"
fi
"$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13)||process.arch!=="x64")process.exit(1)' \
  || gp_die "Node.js >=22.13.0 fuer Linux x64 wird benoetigt."

package="$(gp_existing_file "$package_arg" "Migrationspaket")"
[[ "$package" == *.zip ]] || gp_die "Die Runtime-Migration erwartet das offizielle Linux-Server-ZIP."
if [[ -n "$sha256_file_arg" ]]; then
  sha256_file="$(gp_existing_file "$sha256_file_arg" "SHA256-Datei")"
  sha256_arg="$(awk 'NR==1 {print $1; exit}' "$sha256_file")"
elif [[ -z "$sha256_arg" ]]; then
  sha256_file="$(gp_existing_file "$package.sha256" "SHA256-Datei")"
  sha256_arg="$(awk 'NR==1 {print $1; exit}' "$sha256_file")"
fi
gp_validate_sha256 "$sha256_arg"
sha256_arg="${sha256_arg,,}"

app_dir="$(gp_existing_directory "$APP_DIR" "Bestehende App")"
gp_load_env_file "$ENV_FILE"
data_dir="$(gp_existing_directory "${GRABENPLANER_DATA_DIR:-$DATA_DIR}" "Datenordner")"
database="$(gp_existing_file "${DB_PATH:-$data_dir/data/dienstplan.db}" "SQLite-Datenbank")"
backup_dir="$(gp_safe_absolute_path "${BACKUP_DIR:-$GP_DEFAULT_BACKUP_DIR}" "Backupordner")"
public_url="${GRABENPLANER_PUBLIC_URL:-}"
port="${PORT:-3000}"
gp_validate_https_url "$node" "$public_url" || gp_die "Die bestehende oeffentliche HTTPS-Adresse ist ungueltig."
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) \
  || gp_die "Der bestehende interne Port ist ungueltig."
[[ "${GRABENPLANER_OPERATION_MODE:-}" == "server" && "${GRABENPLANER_DEPLOYMENT_KIND:-}" == "production" ]] \
  || gp_die "Die Migration ist nur fuer eine bestehende produktive Ubuntu-Serverinstallation freigegeben."
[[ -z "${GRABENPLANER_BOOTSTRAP_TOKEN:-}" ]] \
  || gp_die "Der einmalige Admin-Bootstrap ist noch nicht verbraucht; die Runtime-Migration wird nicht gestartet."
for unit in "$APP_SERVICE" "$BOOTSTRAP_SERVICE" "$CADDY_SERVICE"; do gp_require_systemd_unit "$unit"; done
systemctl is-active --quiet "$APP_SERVICE" || gp_die "$APP_SERVICE muss vor der Migration aktiv sein."
systemctl is-active --quiet "$CADDY_SERVICE" || gp_die "$CADDY_SERVICE muss vor der Migration aktiv sein."
systemctl is-active --quiet "$BOOTSTRAP_SERVICE" \
  && gp_die "Der Admin-Bootstrap darf waehrend der Migration nicht laufen."

"$node" - "$database" <<'NODE' >/dev/null \
  || gp_die "Kein aktiver administrativer Zugang gefunden; der Bootstrap wird nicht automatisch erneut geoeffnet."
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(process.argv[2], { readOnly: true });
  const row = db.prepare("SELECT COUNT(*) AS count FROM portal_users WHERE active=1 AND role IN ('developer','it_admin','admin')").get();
  if (Number(row?.count || 0) < 1) process.exit(1);
} catch { process.exit(1); } finally { try { db?.close(); } catch {} }
NODE

internal_live_url="http://127.0.0.1:$port/api/health/live"
internal_ready_url="http://127.0.0.1:$port/api/health/ready"
public_live_url="${public_url%/}/api/health/live"
public_ready_url="${public_url%/}/api/health/ready"
gp_url_reports_ready "$internal_live_url" 8 || gp_die "Der bestehende interne Livenesscheck ist nicht gruen."
gp_url_reports_ready "$internal_ready_url" 8 || gp_die "Der bestehende interne Readinesscheck ist nicht gruen."
gp_url_reports_ready "$public_live_url" 15 || gp_die "Der bestehende oeffentliche Livenesscheck ist nicht gruen."
gp_url_reports_ready "$public_ready_url" 15 || gp_die "Der bestehende oeffentliche Readinesscheck ist nicht gruen."

app_parent="$(dirname -- "$app_dir")"
work_root="$(mktemp --directory --tmpdir="$app_parent" .runtime-v3-migration.XXXXXXXX)"
chown root:root -- "$work_root"
chmod 0711 -- "$work_root"
staged_package="$work_root/package.zip"
extract_root="$work_root/extract"
rollback_root="$work_root/rollback"
rendered_root="$work_root/rendered"
mkdir -m 0700 -- "$extract_root" "$rollback_root" "$rendered_root"

runtime_swapped=0
host_control_bound=0
host_control_group_created=0
host_control_membership_added=0
host_control_root_created=0
host_control_module_installed=0
host_control_module_stage=""
pending_unit=""
updater_invoked=0
updater_succeeded=0
migration_complete=0
updater_commit_marker="$work_root/updater-commit.json"

write_phase() {
  local phase="$1" temporary="$work_root/.phase.$$"
  printf '%s\n' "$phase" >"$temporary"
  chmod 0600 -- "$temporary"
  chown root:root -- "$temporary"
  mv -T -- "$temporary" "$work_root/phase"
  sync -f "$work_root/phase" 2>/dev/null || true
}

updater_commit_is_valid() {
  [[ -f "$updater_commit_marker" && ! -L "$updater_commit_marker" ]] || return 1
  "$node" - "$updater_commit_marker" "${candidate_version:-}" "${actual_package_sha256:-}" <<'NODE' >/dev/null
const fs=require("node:fs");
const [file,version,sha]=process.argv.slice(2);
const stat=fs.lstatSync(file);const value=JSON.parse(fs.readFileSync(file,"utf8"));
if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o077)!==0
  ||value?.format!=="grabenplaner-update-commit"||value?.schemaVersion!==1||value?.status!=="committed"
  ||value?.installedVersion!==version||value?.packageSha256!==sha
  ||!Number.isFinite(Date.parse(value?.committedAt||"")))process.exit(1);
NODE
}

runtime_tools_are_executable() {
  local linux_root="$1" relative script
  [[ -d "$linux_root" && ! -L "$linux_root" ]] || return 1
  for relative in \
    backup-grabenplaner.sh \
    update-grabenplaner-server.sh \
    monitor/run-grabenplaner-monitor.sh; do
    script="$linux_root/$relative"
    [[ -f "$script" && ! -L "$script" && -x "$script" ]] || return 1
  done
}

rollback_runtime() {
  local rollback_code=0
  trap - ERR
  systemctl disable --now "$HOST_CONTROL_SOCKET_NAME" >/dev/null 2>&1 || true
  systemctl stop 'grabenplaner-host-control@*.service' "$HOST_REBOOT_NAME" >/dev/null 2>&1 || true
  rm -f -- "$HOST_CONTROL_SOCKET_UNIT" "$HOST_CONTROL_WORKER_UNIT" "$HOST_REBOOT_UNIT" "${pending_unit:-}"
  systemctl daemon-reload >/dev/null 2>&1 || rollback_code=1
  if (( host_control_module_installed == 1 )) && [[ -d "$HOST_CONTROL_MODULE" && ! -L "$HOST_CONTROL_MODULE" ]]; then
    rm -rf --one-file-system -- "$HOST_CONTROL_MODULE" || rollback_code=1
  fi
  if [[ -n "$host_control_module_stage" && -d "$host_control_module_stage" && ! -L "$host_control_module_stage" ]]; then
    rm -rf --one-file-system -- "$host_control_module_stage" || rollback_code=1
  fi
  if (( host_control_root_created == 1 )) && [[ -d "$HOST_CONTROL_ROOT" && ! -L "$HOST_CONTROL_ROOT" ]]; then
    rmdir -- "$HOST_CONTROL_ROOT" >/dev/null 2>&1 || rollback_code=1
  fi
  if (( host_control_membership_added == 1 )); then
    gpasswd --delete "$GP_DEFAULT_SERVICE_USER" "$HOST_CONTROL_GROUP" >/dev/null 2>&1 || rollback_code=1
  fi
  if (( host_control_group_created == 1 )); then
    groupdel "$HOST_CONTROL_GROUP" >/dev/null 2>&1 || rollback_code=1
  fi
  if (( runtime_swapped == 1 )) && [[ -d "$rollback_root/linux-schema2" && ! -L "$rollback_root/linux-schema2" ]]; then
    systemctl stop "$APP_SERVICE" >/dev/null 2>&1 || true
    if [[ -d "$app_dir/server-tools/linux" && ! -L "$app_dir/server-tools/linux" ]]; then
      rm -rf --one-file-system -- "$app_dir/server-tools/linux" || rollback_code=1
    fi
    mv -T -- "$rollback_root/linux-schema2" "$app_dir/server-tools/linux" || rollback_code=1
    gp_apply_app_permissions "$app_dir/server-tools/linux" "$GP_DEFAULT_SERVICE_GROUP" || rollback_code=1
    runtime_tools_are_executable "$app_dir/server-tools/linux" || rollback_code=1
    systemctl start "$APP_SERVICE" >/dev/null 2>&1 || rollback_code=1
  fi
  systemctl is-active --quiet "$CADDY_SERVICE" || systemctl start "$CADDY_SERVICE" >/dev/null 2>&1 || rollback_code=1
  return "$rollback_code"
}

cleanup() {
  local code=$?
  trap - EXIT
  if (( code != 0 && migration_complete == 0 && updater_succeeded == 0 \
    && (runtime_swapped == 1 || host_control_bound == 1) )); then
    rollback_runtime || code=2
  fi
  if (( updater_succeeded == 1 && migration_complete == 0 )); then
    printf '%s\n' "Die App ist bereits committed; kein unsicherer Runtime-Teilrollback. Manuelle Pruefung erforderlich." \
      >"$work_root/POST-UPDATE-ACTION-REQUIRED"
    chmod 0600 -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
    chown root:root -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
    gp_warn "Der Diagnoseordner bleibt erhalten: $work_root"
  elif [[ -d "$work_root" && ! -L "$work_root" && "$work_root" == "$app_parent/".runtime-v3-migration.* ]]; then
    rm -rf --one-file-system -- "$work_root"
  fi
  exit "$code"
}
trap cleanup EXIT

install -m 0600 -o root -g root -- "$package" "$staged_package"
actual_package_sha256="$(gp_sha256 "$staged_package")"
[[ "$actual_package_sha256" == "$sha256_arg" ]] \
  || gp_die "Die SHA-256-Pruefsumme des Migrationspakets stimmt nicht."

gp_info "Pruefe ZIP-Struktur und entpackte Maximalgroesse."
zip_summary="$(unzip -Z -t "$staged_package")" || gp_die "Das ZIP-Zentralverzeichnis ist unlesbar."
entry_count="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ {print $1; exit}')"
expanded_bytes="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ {print $3; exit}')"
[[ "$entry_count" =~ ^[0-9]+$ && "$expanded_bytes" =~ ^[0-9]+$ ]] \
  || gp_die "Die ZIP-Groessenangaben sind ungueltig."
(( entry_count > 0 && entry_count <= 100000 && expanded_bytes <= MAX_EXPANDED_BYTES )) \
  || gp_die "Das Migrationspaket ist leer oder zu gross."
zip_listing="$(unzip -Z -l "$staged_package")" || gp_die "Die ZIP-Dateitypen sind unlesbar."
parsed_modes=0
while IFS= read -r mode; do
  ((parsed_modes += 1))
  case "${mode:0:1}" in -|d) ;; *) gp_die "Links und Spezialdateien sind im Migrationspaket nicht erlaubt." ;; esac
done < <(printf '%s\n' "$zip_listing" | awk '$1 ~ /^[-dlbcps]/ && $2 ~ /^[0-9]/ {print $1}')
(( parsed_modes == entry_count )) || gp_die "Nicht alle ZIP-Dateitypen konnten sicher bestimmt werden."
unzip -tq "$staged_package" >/dev/null || gp_die "Das Server-ZIP ist beschaedigt."
declare -A archive_entries=()
while IFS= read -r entry; do
  normalized="${entry#./}"
  normalized="${normalized%/}"
  [[ -n "$normalized" ]] || continue
  [[ ! "$entry" =~ [[:cntrl:]] && "$normalized" != /* && "$normalized" != *\\* \
    && -z "${archive_entries[$normalized]+x}" ]] || gp_die "Ungueltiger oder doppelter ZIP-Pfad."
  archive_entries["$normalized"]=1
  IFS=/ read -ra segments <<<"$normalized"
  for segment in "${segments[@]}"; do
    [[ -n "$segment" && "$segment" != . && "$segment" != .. ]] || gp_die "Nicht kanonischer ZIP-Pfad."
  done
done < <(unzip -Z1 "$staged_package")

build_user="$GP_DEFAULT_BUILD_USER"
build_group="$GP_DEFAULT_BUILD_GROUP"
getent passwd "$build_user" >/dev/null || gp_die "Der bestehende isolierte Build-Benutzer fehlt."
getent group "$build_group" >/dev/null || gp_die "Die bestehende isolierte Build-Gruppe fehlt."
chown "root:$build_group" -- "$staged_package"
chmod 0640 -- "$staged_package"
chown "$build_user:$build_group" -- "$extract_root"
runuser --user "$build_user" -- unzip -qq "$staged_package" -d "$extract_root"
[[ -z "$(find "$extract_root" ! -type f ! -type d -print -quit)" ]] \
  || gp_die "Das entpackte Paket enthaelt unzulaessige Dateitypen."
(( $(du --bytes --summarize "$extract_root" | awk '{print $1}') <= MAX_EXPANDED_BYTES )) \
  || gp_die "Das entpackte Paket ist zu gross."

candidate_verifier="$extract_root/server-tools/linux/lib/verify-package.js"
[[ -f "$candidate_verifier" && ! -L "$candidate_verifier" ]] \
  || gp_die "Die Paketpruefung fuer Runtime v3 fehlt."
manifest_result="$work_root/manifest.json"
"$node" "$candidate_verifier" "$extract_root" >"$manifest_result" \
  || gp_die "Manifest- und Einzeldateipruefung fehlgeschlagen."
candidate_updater_contract_helper="$extract_root/server-tools/linux/lib/extract-updater-contract.js"
[[ -f "$candidate_updater_contract_helper" && ! -L "$candidate_updater_contract_helper" ]] \
  || gp_die "Die Paketpruefung fuer den Updater-Ergebnisvertrag fehlt."
candidate_updater_contract_helper_sha256="$(gp_sha256 "$candidate_updater_contract_helper")"
candidate_backup_verifier_sha256="$(gp_sha256 "$extract_root/server-tools/linux/lib/verify-backup.js")"
candidate_amu_storage_sha256="$(gp_sha256 "$extract_root/lib/amu-storage.js")"
cmp --silent -- "$SCRIPT_PATH" "$extract_root/server-tools/linux/migrate-grabenplaner-runtime-v3.sh" \
  || gp_die "Das gestartete Migrationsskript stammt nicht bytegleich aus dem geprueften Paket."
cmp --silent -- "$SCRIPT_DIR/lib/common.sh" "$extract_root/server-tools/linux/lib/common.sh" \
  || gp_die "Die geladene Sicherheitsbasis stammt nicht bytegleich aus dem geprueften Paket."
clamscan --recursive --infected --no-summary -- "$extract_root" >/dev/null \
  || gp_die "ClamAV hat das Migrationspaket abgelehnt."

env_sha256_prelock="$(gp_sha256 "$ENV_FILE")"
gp_acquire_maintenance_lock
[[ "$(gp_sha256 "$ENV_FILE")" == "$env_sha256_prelock" ]] \
  || gp_die "Die Serverkonfiguration wurde waehrend des Migrations-Preflights veraendert."
systemctl is-active --quiet "$APP_SERVICE" || gp_die "$APP_SERVICE ist nicht mehr aktiv."
systemctl is-active --quiet "$CADDY_SERVICE" || gp_die "$CADDY_SERVICE ist nicht mehr aktiv."
systemctl is-active --quiet "$BOOTSTRAP_SERVICE" \
  && gp_die "Der Admin-Bootstrap wurde waehrend des Migrations-Preflights aktiviert."
gp_url_reports_ready "$internal_ready_url" 8 || gp_die "Der interne Readinesscheck ist unter der Wartungssperre nicht gruen."
gp_url_reports_ready "$public_ready_url" 15 || gp_die "Der oeffentliche Readinesscheck ist unter der Wartungssperre nicht gruen."

installed_runtime="$work_root/installed-runtime.json"
"$node" "$candidate_verifier" --runtime-contract "$app_dir" >"$installed_runtime" \
  || gp_die "Der bestehende Runtimevertrag ist nicht als sichere Schema-2-Installation lesbar."
readarray -t transition < <("$node" - "$installed_runtime" "$manifest_result" "$app_dir/package.json" <<'NODE'
const fs=require("node:fs");
const [oldFile,newFile,packageFile]=process.argv.slice(2);
const old=JSON.parse(fs.readFileSync(oldFile,"utf8"));
const result=JSON.parse(fs.readFileSync(newFile,"utf8"));
const next={
  ...result.runtimeContract,
  offsiteModule:result.offsiteModule,
  hardeningModule:result.hardeningModule,
};
const oldVersion=JSON.parse(fs.readFileSync(packageFile,"utf8")).version;
const v1=["server-tools/linux/Caddyfile.in","server-tools/linux/grabenplaner-bootstrap-admin.sh.in","server-tools/linux/grabenplaner-bootstrap.service.in","server-tools/linux/grabenplaner.env.example","server-tools/linux/grabenplaner.service.in"];
const v2=[...v1,"server-tools/linux/grabenplaner-monitor.service.in","server-tools/linux/grabenplaner-monitor.timer.in"].sort();
const v3=[...v2,
  "server-tools/linux/host-control/lib/host-reboot-broker.js",
  "server-tools/linux/host-control/systemd/grabenplaner-host-control.socket.in",
  "server-tools/linux/host-control/systemd/grabenplaner-host-control@.service.in",
  "server-tools/linux/host-control/systemd/grabenplaner-host-reboot.service.in",
].sort();
const same=(a,b)=>JSON.stringify([...(a||[])].sort())===JSON.stringify(b);
if(old.deploymentSchemaVersion!==2||next?.deploymentSchemaVersion!==3
  ||old.migrationPolicy!=="explicit-maintenance"||next.migrationPolicy!=="explicit-maintenance"
  ||!same(old.managedArtifacts,v2)||!same(next.managedArtifacts,v3))process.exit(1);
const offsiteChanged=old?.offsiteModule?.moduleVersion!==next?.offsiteModule?.moduleVersion
  ||old?.offsiteModule?.fingerprint!==next?.offsiteModule?.fingerprint;
if(old?.hardeningModule?.moduleVersion!==next?.hardeningModule?.moduleVersion
  ||old?.hardeningModule?.fingerprint!==next?.hardeningModule?.fingerprint)process.exit(1);
if(!Number.isSafeInteger(next?.offsiteModule?.moduleVersion)
  ||next.offsiteModule.moduleVersion<1
  ||!/^[a-f0-9]{64}$/.test(String(next?.offsiteModule?.fingerprint||"")))process.exit(1);
process.stdout.write(`${oldVersion}\n${result.appVersion}\n${next.fingerprint}\n${offsiteChanged?"1":"0"}\n${next.offsiteModule.moduleVersion}\n${next.offsiteModule.fingerprint}\n`);
NODE
) || gp_die "Freigegeben ist ausschliesslich der Runtimewechsel Schema 2 -> 3."
old_version="${transition[0]:-}"
candidate_version="${transition[1]:-}"
candidate_runtime_fingerprint="${transition[2]:-}"
offsite_source_changed="${transition[3]:-}"
candidate_offsite_module_version="${transition[4]:-}"
candidate_offsite_fingerprint="${transition[5]:-}"
[[ -n "$old_version" && -n "$candidate_version" && "$candidate_runtime_fingerprint" =~ ^[a-f0-9]{64}$
  && "$offsite_source_changed" =~ ^[01]$ && "$candidate_offsite_module_version" =~ ^[1-9][0-9]*$
  && "$candidate_offsite_fingerprint" =~ ^[a-f0-9]{64}$ ]] \
  || gp_die "Die Runtime-Migrationsdaten sind unvollstaendig."
version_comparison="$(gp_compare_semver "$node" "$old_version" "$candidate_version")"
(( version_comparison <= 0 )) || gp_die "Die Runtime-v3-Migration akzeptiert keine aeltere App-Version."

offsite_migration_first() {
  gp_die "Offsite-Migration zuerst: $*"
}

verify_configured_offsite_candidate_transition() (
  set -Eeuo pipefail

  local candidate_offsite_root="$extract_root/server-tools/linux/offsite"
  local candidate_contract_helper="$candidate_offsite_root/lib/offsite-contract.js"
  local candidate_common="$candidate_offsite_root/lib/offsite-common.sh"
  local candidate_contract="$work_root/candidate-offsite-contract.json"
  local verified_provider=""
  local repository_probe=""
  local credentials=""

  [[ -f "$candidate_contract_helper" && ! -L "$candidate_contract_helper"
    && -f "$candidate_common" && ! -L "$candidate_common" ]] || return 1
  "$node" "$candidate_contract_helper" contract "$candidate_offsite_root" >"$candidate_contract" \
    || return 1
  chmod 0600 -- "$candidate_contract"
  chown root:root -- "$candidate_contract"

  [[ -d "$LIVE_OFFSITE_CONFIG_ROOT" && ! -L "$LIVE_OFFSITE_CONFIG_ROOT"
    && "$(stat --format='%u:%g:%a' -- "$LIVE_OFFSITE_CONFIG_ROOT")" == "0:0:700" ]] || return 1
  [[ -f "$LIVE_OFFSITE_INSTALLED_CONTRACT" && ! -L "$LIVE_OFFSITE_INSTALLED_CONTRACT"
    && "$(stat --format='%u:%g:%a:%h' -- "$LIVE_OFFSITE_INSTALLED_CONTRACT")" == "0:0:600:1" ]] || return 1
  "$node" "$candidate_contract_helper" verify-installed-bound \
    "$LIVE_OFFSITE_MODULE_ROOT" "$LIVE_OFFSITE_INSTALLED_CONTRACT" >/dev/null || return 1
  "$node" - "$candidate_contract" "$LIVE_OFFSITE_INSTALLED_CONTRACT" \
    "$candidate_offsite_module_version" "$candidate_offsite_fingerprint" <<'NODE' >/dev/null || return 1
const fs=require("node:fs");
const [candidateFile,installedFile,expectedVersion,expectedFingerprint]=process.argv.slice(2);
const candidate=JSON.parse(fs.readFileSync(candidateFile,"utf8"));
const installed=JSON.parse(fs.readFileSync(installedFile,"utf8"));
const canonical=(items)=>JSON.stringify([...(items||[])].sort((a,b)=>String(a?.path||"").localeCompare(String(b?.path||""))));
if(candidate?.format!=="grabenplaner-linux-offsite-installed-contract"
  ||candidate?.schemaVersion!==1
  ||candidate?.moduleVersion!==Number(expectedVersion)
  ||candidate?.fingerprint!==expectedFingerprint
  ||installed?.format!==candidate.format
  ||installed?.schemaVersion!==candidate.schemaVersion
  ||installed?.moduleVersion!==candidate.moduleVersion
  ||installed?.fingerprint!==candidate.fingerprint
  ||installed?.schemaSha256!==candidate.schemaSha256
  ||canonical(installed.files)!==canonical(candidate.files)
  ||typeof installed?.providerBinding!=="object"
  ||installed.providerBinding===null)process.exit(1);
NODE

  case "${GRABENPLANER_OFFSITE_PROVIDER:-}" in
    google_drive|hetzner_object_storage|backblaze_b2) ;;
    *) return 1 ;;
  esac

  # Die Kandidaten-Sicherheitsbasis arbeitet ausschliesslich gegen den bereits
  # separat installierten Live-Modulbaum. Dessen Dateiliste, Schema und
  # Fingerprint wurden oben bytegenau an denselben Kandidaten gebunden.
  # shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
  source "$candidate_common"

  cleanup_offsite_transition_probe() {
    if [[ -n "$credentials" ]]; then
      offsite_remove_uploader_credentials "$credentials" >/dev/null 2>&1 || true
    fi
    if [[ -n "$repository_probe" && "$repository_probe" == "$OFFSITE_RUN_ROOT/runtime-v3-repository."* ]]; then
      rm -f -- "$repository_probe"
    fi
  }
  trap cleanup_offsite_transition_probe EXIT

  offsite_require_root
  offsite_assert_group_isolation
  for config_name in repository repository-id installation-id restic-password rclone-config-password; do
    offsite_assert_regular_root_file "$OFFSITE_CONFIG_ROOT/$config_name"
  done
  offsite_assert_runtime_binaries
  offsite_prepare_run_root
  offsite_acquire_repository_lock
  credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")"
  verified_provider="$(offsite_assert_bound_rclone_provider "$credentials")"
  [[ "$verified_provider" == "$GRABENPLANER_OFFSITE_PROVIDER" ]] || return 1
  repository_probe="$(mktemp --tmpdir="$OFFSITE_RUN_ROOT" runtime-v3-repository.XXXXXXXX)"
  chmod 0600 -- "$repository_probe"
  chown root:root -- "$repository_probe"
  offsite_verify_repository_identity "$credentials" "$repository_probe" || return 1
  printf '%s\n' "$verified_provider"
)

case "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" in
  0|1) ;;
  *) gp_die "Der bestehende Offsite-Aktivierungszustand ist ungueltig." ;;
esac
if [[ "$offsite_source_changed" == "1" ]]; then
  if [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == "1" ]]; then
    gp_info "Pruefe die bereits separat migrierte Offsite-Bindung gegen den Kandidaten."
    verified_offsite_provider="$(verify_configured_offsite_candidate_transition)" \
      || offsite_migration_first "Der konfigurierte Live-Vertrag entspricht nicht exakt dem Kandidaten oder seine Provider-/Repository-Bindung ist nicht sicher pruefbar."
    [[ "$verified_offsite_provider" == "$GRABENPLANER_OFFSITE_PROVIDER" ]] \
      || offsite_migration_first "Ein Providerwechsel ist in der Runtime-Migration nicht erlaubt."
  else
    gp_info "Der Offsite-Quellvertrag darf sich aendern, weil die optionale Offsite-Sicherung nicht aktiviert ist."
  fi
fi

for relative in Caddyfile.in grabenplaner-bootstrap-admin.sh.in grabenplaner-bootstrap.service.in \
  grabenplaner.env.example grabenplaner-monitor.service.in grabenplaner-monitor.timer.in grabenplaner.service.in; do
  cmp --silent -- "$app_dir/server-tools/linux/$relative" "$extract_root/server-tools/linux/$relative" \
    || gp_die "Schema 3 enthaelt ausserhalb des freigegebenen Host-Control-Deltas eine Runtime-Aenderung: $relative"
done
for host_path in "$HOST_CONTROL_ROOT" "$HOST_CONTROL_SOCKET_UNIT" "$HOST_CONTROL_WORKER_UNIT" "$HOST_REBOOT_UNIT"; do
  [[ ! -e "$host_path" && ! -L "$host_path" ]] \
    || gp_die "Host-Control-Artefakte sind bereits vorhanden; eine teilweise Migration wird nicht blind fortgesetzt."
done
if getent group "$HOST_CONTROL_GROUP" >/dev/null 2>&1; then
  existing_host_members="$(getent group "$HOST_CONTROL_GROUP" | awk -F: 'NR==1 {print $4}')"
  existing_host_gid="$(getent group "$HOST_CONTROL_GROUP" | awk -F: 'NR==1 {print $3}')"
  [[ "$existing_host_gid" =~ ^[0-9]+$
    && -z "$(getent passwd | awk -F: -v gid="$existing_host_gid" '$4 == gid { print $1 }')" ]] \
    || gp_die "Die bestehende Host-Control-Gruppe ist unerwartet als Hauptgruppe vergeben."
  [[ -z "$existing_host_members" || "$existing_host_members" == "$GP_DEFAULT_SERVICE_USER" ]] \
    || gp_die "Die bestehende Host-Control-Gruppe besitzt unerwartete Mitglieder."
fi
env_sha256_before="$(gp_sha256 "$ENV_FILE")"

gp_info "Binde den exakt geprueften Runtime-v3-Wartungsbaum ein."
write_phase "runtime-swap-intent"
runtime_swapped=1
mv -T -- "$app_dir/server-tools/linux" "$rollback_root/linux-schema2"
write_phase "runtime-schema2-saved"
cp --archive -- "$extract_root/server-tools/linux" "$work_root/linux-schema3"
gp_apply_app_permissions "$work_root/linux-schema3" "$GP_DEFAULT_SERVICE_GROUP"
runtime_tools_are_executable "$work_root/linux-schema3" \
  || gp_die "Die geprueften Runtime-v3-Wartungswerkzeuge sind vor dem Einbinden nicht ausfuehrbar."
mv -T -- "$work_root/linux-schema3" "$app_dir/server-tools/linux"

write_phase "host-control-bind-intent"
host_control_bound=1
if ! getent group "$HOST_CONTROL_GROUP" >/dev/null 2>&1; then
  groupadd --system "$HOST_CONTROL_GROUP"
  host_control_group_created=1
fi
host_control_gid="$(getent group "$HOST_CONTROL_GROUP" | awk -F: 'NR==1 {print $3}')"
[[ "$host_control_gid" =~ ^[0-9]+$
  && -z "$(getent passwd | awk -F: -v gid="$host_control_gid" '$4 == gid { print $1 }')" ]] \
  || gp_die "Die Host-Control-Gruppe darf fuer keinen Benutzer Hauptgruppe sein."
host_control_members="$(getent group "$HOST_CONTROL_GROUP" | awk -F: 'NR==1 {print $4}')"
if [[ -z "$host_control_members" ]]; then
  usermod --append --groups "$HOST_CONTROL_GROUP" "$GP_DEFAULT_SERVICE_USER"
  host_control_membership_added=1
fi
[[ "$(getent group "$HOST_CONTROL_GROUP" | awk -F: 'NR==1 {print $4}')" == "$GP_DEFAULT_SERVICE_USER" ]] \
  || gp_die "Nur der Grabenplaner-Dienstbenutzer darf Mitglied der Host-Control-Gruppe sein."

host_control_root_created=1
install -d -m 0755 -o root -g root -- "$HOST_CONTROL_ROOT"
host_control_module_stage="$(mktemp --directory --tmpdir="$HOST_CONTROL_ROOT" .module.XXXXXXXX)"
cp --archive -- "$app_dir/server-tools/linux/host-control/." "$host_control_module_stage/"
chown -R root:root -- "$host_control_module_stage"
find "$host_control_module_stage" -type d -exec chmod 0755 -- {} +
find "$host_control_module_stage" -type f -exec chmod 0644 -- {} +
mv -T -- "$host_control_module_stage" "$HOST_CONTROL_MODULE"
host_control_module_installed=1
host_control_module_stage=""
[[ -f "$HOST_CONTROL_MODULE/lib/host-reboot-broker.js" && ! -L "$HOST_CONTROL_MODULE/lib/host-reboot-broker.js" \
  && "$(stat --format='%u:%g:%a:%h' -- "$HOST_CONTROL_MODULE/lib/host-reboot-broker.js")" == "0:0:644:1" ]] \
  || gp_die "Der root-geschuetzte Host-Control-Broker wurde nicht sicher installiert."

render_host_unit() {
  local source="$1" target="$2" content
  content="$(<"$source")"
  content="${content//\{\{NODE_EXECUTABLE\}\}/$node}"
  printf '%s\n' "$content" >"$target"
  ! grep -Eq '\{\{[A-Z0-9_]+\}\}' "$target" || gp_die "Nicht ersetzter Host-Control-Platzhalter."
  chmod 0600 -- "$target"
}
render_host_unit "$app_dir/server-tools/linux/host-control/systemd/grabenplaner-host-control.socket.in" \
  "$rendered_root/$HOST_CONTROL_SOCKET_NAME"
render_host_unit "$app_dir/server-tools/linux/host-control/systemd/grabenplaner-host-control@.service.in" \
  "$rendered_root/$HOST_CONTROL_WORKER_NAME"
render_host_unit "$app_dir/server-tools/linux/host-control/systemd/grabenplaner-host-reboot.service.in" \
  "$rendered_root/$HOST_REBOOT_NAME"
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$rendered_root/$HOST_CONTROL_SOCKET_NAME" \
    "$rendered_root/$HOST_CONTROL_WORKER_NAME" "$rendered_root/$HOST_REBOOT_NAME" >/dev/null
fi
install_host_unit() {
  local source="$1" target="$2"
  pending_unit="${target}.install.$$"
  install -m 0644 -o root -g root -- "$source" "$pending_unit"
  [[ ! -e "$target" && ! -L "$target" ]] \
    || gp_die "Ein Host-Control-Unitpfad ist waehrend der Migration unerwartet erschienen."
  mv -T -- "$pending_unit" "$target"
  pending_unit=""
}
install_host_unit "$rendered_root/$HOST_CONTROL_SOCKET_NAME" "$HOST_CONTROL_SOCKET_UNIT"
install_host_unit "$rendered_root/$HOST_CONTROL_WORKER_NAME" "$HOST_CONTROL_WORKER_UNIT"
install_host_unit "$rendered_root/$HOST_REBOOT_NAME" "$HOST_REBOOT_UNIT"
systemctl daemon-reload
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$HOST_CONTROL_SOCKET_UNIT" "$HOST_CONTROL_WORKER_UNIT" "$HOST_REBOOT_UNIT" >/dev/null
fi
systemctl enable --now "$HOST_CONTROL_SOCKET_NAME" >/dev/null
systemctl is-enabled --quiet "$HOST_CONTROL_SOCKET_NAME" \
  || gp_die "Der geschuetzte Host-Control-Socket konnte nicht aktiviert werden."
systemctl is-active --quiet "$HOST_CONTROL_SOCKET_NAME" \
  || gp_die "Der geschuetzte Host-Control-Socket konnte nicht gestartet werden."
[[ -S "$HOST_CONTROL_SOCKET" \
  && "$(stat --format='%U:%G:%a' -- "$HOST_CONTROL_SOCKET")" == "root:${HOST_CONTROL_GROUP}:660" ]] \
  || gp_die "Der Host-Control-Socket besitzt nicht den freigegebenen Zugriffsschutz."
systemctl is-active --quiet "$HOST_REBOOT_NAME" \
  && gp_die "Die Migration darf keinen Host-Neustart ausloesen."

updater_output="$work_root/updater-result.json"
install -m 0600 -o root -g root /dev/null "$updater_output"
runtime_tools_are_executable "$app_dir/server-tools/linux" \
  || gp_die "Die eingebundenen Runtime-v3-Wartungswerkzeuge sind vor dem App-Update nicht ausfuehrbar."
update_args=(
  --package "$staged_package" --sha256 "$actual_package_sha256" --env-file "$ENV_FILE"
  --app-dir "$app_dir" --data-dir "$data_dir" --database "$database" --backup-dir "$backup_dir"
  --public-url "$public_url" --node "$node" --service "$APP_SERVICE" --caddy-service "$CADDY_SERVICE"
  --health-timeout "$health_timeout" --lock-already-held --commit-marker "$updater_commit_marker"
)
if [[ -n "$pnpm_arg" ]]; then update_args+=(--pnpm "$pnpm_arg"); fi
if (( version_comparison == 0 )); then update_args+=(--allow-downgrade-or-reinstall); fi
write_phase "updater-invoked"
updater_invoked=1
set +e
bash "$app_dir/server-tools/linux/update-grabenplaner-server.sh" "${update_args[@]}" >"$updater_output"
updater_status=$?
set -e
if updater_commit_is_valid; then
  updater_succeeded=1
  write_phase "updater-committed"
elif (( updater_status != 0 )); then
  gp_die "Das App-Update innerhalb der Runtime-Migration ist fehlgeschlagen."
else
  gp_die "Der App-Updater meldete Erfolg ohne dauerhaften Commitnachweis."
fi

post_update_fail() {
  local message="$1"
  printf '%s\n' "$message" >"$work_root/POST-UPDATE-ACTION-REQUIRED"
  chmod 0600 -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
  chown root:root -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
  gp_log ERROR "$message Die App ist bereits erfolgreich auf Runtime v3 aktualisiert; kein unsicherer Schema-2-Teilrollback wird versucht. Diagnose: $work_root"
  exit 2
}

updater_contract="$work_root/updater-contract.json"
updater_contract_helper="$app_dir/server-tools/linux/lib/extract-updater-contract.js"
service_group_gid="$(getent group "$GP_DEFAULT_SERVICE_GROUP" | awk -F: 'NR==1 {print $3}')"
if [[ ! "$service_group_gid" =~ ^[0-9]+$ \
    || ! -f "$updater_contract_helper" || -L "$updater_contract_helper" \
    || "$(stat --format='%u:%g:%a:%h' -- "$updater_contract_helper")" != "0:${service_group_gid}:640:1" \
    || "$(gp_sha256 "$updater_contract_helper")" != "$candidate_updater_contract_helper_sha256" ]] \
  || ! "$node" "$updater_contract_helper" \
    "$updater_output" "$updater_contract" "$updater_commit_marker" \
    "$old_version" "$candidate_version" "$actual_package_sha256" "$public_ready_url" \
    "$backup_dir" "$data_dir/maintenance/history"; then
  post_update_fail "Der strukturierte Ergebnisvertrag des bereits festgeschriebenen App-Updates ist ungueltig."
fi
chown root:root -- "$updater_contract" \
  || post_update_fail "Der strukturierte Updater-Vertrag konnte nicht sicher zugeordnet werden."
chmod 0600 -- "$updater_contract" \
  || post_update_fail "Der strukturierte Updater-Vertrag konnte nicht sicher geschuetzt werden."

backup_verifier="$app_dir/server-tools/linux/lib/verify-backup.js"
amu_storage_module="$app_dir/lib/amu-storage.js"
for protected_helper in "$backup_verifier" "$amu_storage_module"; do
  [[ -f "$protected_helper" && ! -L "$protected_helper" \
    && "$(stat --format='%u:%g:%a:%h' -- "$protected_helper")" == "0:${service_group_gid}:640:1" ]] \
    || post_update_fail "Ein paketgebundener Sicherungspruefer besitzt keinen sicheren Installationszustand."
done
[[ "$(gp_sha256 "$backup_verifier")" == "$candidate_backup_verifier_sha256" \
  && "$(gp_sha256 "$amu_storage_module")" == "$candidate_amu_storage_sha256" ]] \
  || post_update_fail "Die installierte Sicherungspruefung weicht vom geprueften Paket ab."
backup_database="$("$node" -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backup||""))' "$updater_contract")"
backup_base="${backup_database%.db}"
[[ "$backup_database" == "$backup_base.db" ]] \
  || post_update_fail "Der kanonische Sicherungspfad ist ungueltig."
backup_amu="$backup_base.amu"
backup_marker="$backup_base.complete.json"
backup_verification="$work_root/post-update-backup-verification.json"
install -m 0600 -o root -g root /dev/null "$backup_verification"
"$node" "$backup_verifier" "$backup_database" "$backup_amu" "$amu_storage_module" "$backup_marker" \
  >"$backup_verification" \
  || post_update_fail "Der Sicherungspunkt des festgeschriebenen App-Updates ist nicht mehr vollstaendig verifizierbar."

[[ "$(gp_sha256 "$ENV_FILE")" == "$env_sha256_before" ]] \
  || post_update_fail "Die geschuetzte Server-Umgebungsdatei wurde unerwartet veraendert."
installed_v3="$work_root/installed-runtime-v3.json"
"$node" "$app_dir/server-tools/linux/lib/verify-package.js" --runtime-contract "$app_dir" >"$installed_v3" \
  || post_update_fail "Der installierte Runtime-v3-Vertrag ist nach dem App-Commit nicht lesbar."
"$node" - "$installed_v3" "$candidate_runtime_fingerprint" "$app_dir/package.json" "$candidate_version" <<'NODE' >/dev/null \
  || post_update_fail "Die installierte App ist nicht exakt an den freigegebenen Runtime-v3-Vertrag gebunden."
const fs=require("node:fs");const [runtimeFile,fingerprint,packageFile,version]=process.argv.slice(2);
const runtime=JSON.parse(fs.readFileSync(runtimeFile,"utf8"));const pkg=JSON.parse(fs.readFileSync(packageFile,"utf8"));
if(runtime.deploymentSchemaVersion!==3||runtime.fingerprint!==fingerprint||pkg.version!==version)process.exit(1);
NODE
cmp --silent -- "$HOST_CONTROL_MODULE/lib/host-reboot-broker.js" \
  "$app_dir/server-tools/linux/host-control/lib/host-reboot-broker.js" \
  || post_update_fail "Der installierte Host-Control-Broker weicht vom Runtimevertrag ab."
for host_unit in "$HOST_CONTROL_SOCKET_NAME" "$HOST_CONTROL_WORKER_NAME" "$HOST_REBOOT_NAME"; do
  cmp --silent -- "/etc/systemd/system/$host_unit" "$rendered_root/$host_unit" \
    || post_update_fail "Eine installierte Host-Control-Unit weicht vom Runtimevertrag ab."
done
[[ "$(getent group "$HOST_CONTROL_GROUP" | awk -F: 'NR==1 {print $4}')" == "$GP_DEFAULT_SERVICE_USER" ]] \
  || post_update_fail "Die Host-Control-Gruppe besitzt nicht mehr den freigegebenen Einzelzugriff."
systemctl is-enabled --quiet "$HOST_CONTROL_SOCKET_NAME" \
  || post_update_fail "Der Host-Control-Socket ist nach dem App-Commit nicht aktiviert."
systemctl is-active --quiet "$HOST_CONTROL_SOCKET_NAME" \
  || post_update_fail "Der Host-Control-Socket ist nach dem App-Commit nicht aktiv."
systemctl is-active --quiet "$HOST_REBOOT_NAME" \
  && post_update_fail "Die Runtime-Migration hat unerwartet einen Host-Neustart ausgeloest."
gp_wait_ready "$internal_live_url" "$health_timeout" \
  || post_update_fail "Die migrierte App beantwortet den internen Livenesscheck nicht."
gp_wait_ready "$internal_ready_url" "$health_timeout" \
  || post_update_fail "Die migrierte App ist intern nicht bereit."
gp_wait_ready "$public_live_url" "$health_timeout" \
  || post_update_fail "Die migrierte App ist oeffentlich nicht erreichbar."
gp_wait_ready "$public_ready_url" "$health_timeout" \
  || post_update_fail "Die migrierte App ist oeffentlich nicht bereit."
systemctl is-active --quiet "$BOOTSTRAP_SERVICE" \
  && post_update_fail "Der einmalige Bootstrap wurde unerwartet aktiviert."

history_dir="$data_dir/maintenance/history"
install -d -m 0750 -o root -g "$GP_DEFAULT_SERVICE_GROUP" -- "$history_dir" \
  || post_update_fail "Der Migrationsverlauf konnte nicht vorbereitet werden."
receipt="$history_dir/runtime-v3-$(date --utc '+%Y-%m-%dT%H-%M-%S-%3N').json"
if ! "$node" - "$receipt" "$old_version" "$candidate_version" "$actual_package_sha256" \
  "$env_sha256_before" "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" "$updater_contract" <<'NODE'
const fs=require("node:fs"),path=require("node:path");
const [file,fromVersion,toVersion,packageSha256,environmentSha256,offsiteConfigured,updateFile]=process.argv.slice(2);
const update=JSON.parse(fs.readFileSync(updateFile,"utf8"));
const backup=String(update.backup||"");
const marker=backup.endsWith(".db")?`${backup.slice(0,-3)}.complete.json`:"";
const commit=JSON.parse(fs.readFileSync(marker,"utf8"));
if(commit?.verification?.status!=="verified"||!(/^[a-f0-9]{64}$/.test(String(commit?.database?.sha256||""))))throw new Error("Backupbeleg fehlt");
const payload={
  format:"grabenplaner-runtime-migration",schemaVersion:1,status:"success",
  completedAt:new Date().toISOString(),deploymentSchema:{from:2,to:3},
  fromVersion,toVersion,packageSha256,environmentSha256,
  offsitePreserved:offsiteConfigured==="1",bootstrapReopened:false,rebootTriggered:false,
  hostControl:{group:"grabenplaner-host-control",socket:"/run/grabenplaner-host-control/request.sock"},
  backup:{fileName:path.basename(backup),sha256:commit.database.sha256,commitFileName:path.basename(marker)},
  updateReceipt:update.receipt?path.basename(update.receipt):null,
};
fs.writeFileSync(file,`${JSON.stringify(payload,null,2)}\n`,{mode:0o640});
NODE
then
  post_update_fail "Der gepruefte Migrationsbeleg konnte nicht erzeugt werden."
fi
chown "root:$GP_DEFAULT_SERVICE_GROUP" -- "$receipt" \
  || post_update_fail "Der Migrationsbeleg konnte nicht sicher zugeordnet werden."
chmod 0640 -- "$receipt" \
  || post_update_fail "Der Migrationsbeleg konnte nicht sicher geschuetzt werden."

migration_complete=1
rm -rf --one-file-system -- "$rollback_root" \
  || gp_warn "Der nicht mehr benoetigte Runtime-v2-Rollbackordner konnte nicht entfernt werden."
printf '%s\n' "{\"ok\":true,\"fromSchema\":2,\"toSchema\":3,\"fromVersion\":\"$old_version\",\"toVersion\":\"$candidate_version\",\"rebootTriggered\":false,\"receipt\":\"$receipt\"}"
gp_info "Runtime-Schema 2 wurde kontrolliert auf Schema 3 migriert; es wurde kein Host-Neustart ausgeloest."

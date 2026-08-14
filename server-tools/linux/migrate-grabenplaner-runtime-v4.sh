#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Einmaliger, expliziter Wartungsweg fuer Deployment-Schema 3 -> 4.
# Das normale App-Update bleibt schema-starr. Diese Migration erweitert nur
# die bereits gehaertete App-Unit um das von PID 1 geladene Boot-ID-Credential
# und fuehrt das App-Update ueber den bestehenden Backup-/Rollback-Updater aus.

readonly SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_PATH="$(readlink -f -- "$SCRIPT_SOURCE" 2>/dev/null || true)"
[[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] \
  || { printf '%s\n' "Das Runtime-v4-Migrationsskript konnte nicht sicher aufgeloest werden." >&2; exit 1; }
readonly SCRIPT_PATH
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

readonly APP_DIR="/opt/grabenplaner/app"
readonly DATA_DIR="/var/lib/grabenplaner"
readonly ENV_FILE="/etc/grabenplaner/grabenplaner.env"
readonly APP_SERVICE="grabenplaner.service"
readonly APP_UNIT="/etc/systemd/system/$APP_SERVICE"
readonly BOOTSTRAP_SERVICE="grabenplaner-bootstrap.service"
readonly CADDY_SERVICE="caddy.service"
readonly HOST_REBOOT_SERVICE="grabenplaner-host-reboot.service"
readonly CREDENTIAL_LINE="LoadCredential=host-boot-id:/proc/sys/kernel/random/boot_id"
readonly MAX_EXPANDED_BYTES=4294967296

package_arg=""
sha256_arg=""
sha256_file_arg=""
node_arg=""
pnpm_arg=""
health_timeout=1500

usage() {
  cat <<'EOF'
Verwendung:
  sudo ./migrate-grabenplaner-runtime-v4.sh \
    --package /pfad/Grabenplaner-Server-...-linux-x64.zip \
    [--sha256 HEX | --sha256-file /pfad/paket.zip.sha256]

Dieser root-only Wartungsvorgang akzeptiert ausschliesslich den freigegebenen
Wechsel des Ubuntu-Deploymentvertrags von Schema 3 auf Schema 4. Er bindet die
Host-Boot-ID als systemd-Credential in den weiterhin gehaerteten App-Dienst ein,
aktualisiert die App ueber den normalen Backup-/Rollback-Updater und bestaetigt
die Bootgeneration live. Die Migration loest keinen VPS-Neustart aus.
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
for command_name in awk bash chown chmod clamscan cmp cp curl date du find flock getent grep install mkdir mktemp mv readlink realpath rm runuser sha256sum sleep stat sync systemctl uname unzip; do
  gp_require_command "$command_name"
done
[[ -n "$package_arg" ]] || gp_die "--package ist erforderlich."
[[ -z "$sha256_arg" || -z "$sha256_file_arg" ]] \
  || gp_die "--sha256 und --sha256-file duerfen nicht gemeinsam verwendet werden."
[[ "$health_timeout" =~ ^[0-9]+$ ]] && (( health_timeout >= 30 && health_timeout <= 1500 )) \
  || gp_die "--health-timeout muss zwischen 30 und 1500 liegen."

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
  || gp_die "Die Runtime-v4-Migration unterstuetzt Ubuntu 24.04/26.04 auf x86_64."

if [[ -n "$node_arg" ]]; then
  node="$(gp_existing_file "$node_arg" "Node.js")"
else
  gp_require_command node
  node="$(readlink -f -- "$(command -v node)")"
fi
"$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13)||process.arch!=="x64")process.exit(1)' \
  || gp_die "Node.js >=22.13.0 fuer Linux x64 wird benoetigt."
clamscan="$(readlink -f -- "$(command -v clamscan)")"
[[ -x "$clamscan" && ! -L "$clamscan" ]] || gp_die "ClamAV konnte nicht sicher aufgeloest werden."

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
  || gp_die "Die Migration ist nur fuer eine produktive Ubuntu-Serverinstallation freigegeben."
[[ -z "${GRABENPLANER_BOOTSTRAP_TOKEN:-}" ]] \
  || gp_die "Der einmalige Admin-Bootstrap ist noch nicht verbraucht."
for unit in "$APP_SERVICE" "$BOOTSTRAP_SERVICE" "$CADDY_SERVICE"; do gp_require_systemd_unit "$unit"; done
systemctl is-active --quiet "$APP_SERVICE" || gp_die "$APP_SERVICE muss vor der Migration aktiv sein."
systemctl is-active --quiet "$CADDY_SERVICE" || gp_die "$CADDY_SERVICE muss vor der Migration aktiv sein."
systemctl is-active --quiet "$BOOTSTRAP_SERVICE" \
  && gp_die "Der Admin-Bootstrap darf waehrend der Migration nicht laufen."
[[ -f "$APP_UNIT" && ! -L "$APP_UNIT" \
  && "$(stat --format='%u:%g:%a:%h' -- "$APP_UNIT")" == "0:0:644:1" ]] \
  || gp_die "Die installierte Grabenplaner-Unit ist ungueltig."

internal_live_url="http://127.0.0.1:$port/api/health/live"
internal_ready_url="http://127.0.0.1:$port/api/health/ready"
public_live_url="${public_url%/}/api/health/live"
public_ready_url="${public_url%/}/api/health/ready"
gp_url_reports_ready "$internal_live_url" 8 || gp_die "Der bestehende interne Livenesscheck ist nicht gruen."
gp_url_reports_ready "$internal_ready_url" 8 || gp_die "Der bestehende interne Readinesscheck ist nicht gruen."
gp_url_reports_ready "$public_live_url" 15 || gp_die "Der bestehende oeffentliche Livenesscheck ist nicht gruen."
gp_url_reports_ready "$public_ready_url" 15 || gp_die "Der bestehende oeffentliche Readinesscheck ist nicht gruen."

app_parent="$(dirname -- "$app_dir")"
work_root="$(mktemp --directory --tmpdir="$app_parent" .runtime-v4-migration.XXXXXXXX)"
chown root:root -- "$work_root"
chmod 0711 -- "$work_root"
staged_package="$work_root/package.zip"
extract_root="$work_root/extract"
rollback_root="$work_root/rollback"
rendered_root="$work_root/rendered"
mkdir -m 0700 -- "$extract_root" "$rollback_root" "$rendered_root"
runtime_swapped=0
unit_swapped=0
updater_succeeded=0
migration_complete=0
rollback_failed=0
updater_commit_marker="$work_root/updater-commit.json"
unit_pending=""

runtime_tools_are_executable() {
  local linux_root="$1" relative
  [[ -d "$linux_root" && ! -L "$linux_root" ]] || return 1
  for relative in backup-grabenplaner.sh update-grabenplaner-server.sh monitor/run-grabenplaner-monitor.sh; do
    [[ -f "$linux_root/$relative" && ! -L "$linux_root/$relative" && -x "$linux_root/$relative" ]] || return 1
  done
}

render_app_unit() {
  local source="$1" target="$2" content
  content="$(<"$source")"
  content="${content//\{\{NODE_EXECUTABLE\}\}/$node}"
  content="${content//\{\{CLAMSCAN_EXECUTABLE\}\}/$clamscan}"
  printf '%s\n' "$content" >"$target"
  ! grep -Eq '\{\{[A-Z0-9_]+\}\}' "$target" || gp_die "Nicht ersetzter Platzhalter in der App-Unit."
  chmod 0600 -- "$target"
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

rollback_runtime() {
  local rollback_code=0 rollback_runtime_result="$work_root/rollback-runtime.json"
  trap - ERR
  systemctl stop "$APP_SERVICE" >/dev/null 2>&1 || true
  if (( unit_swapped == 1 )) && [[ -f "$rollback_root/grabenplaner.service" && ! -L "$rollback_root/grabenplaner.service" ]]; then
    install -m 0644 -o root -g root -- "$rollback_root/grabenplaner.service" "$APP_UNIT" || rollback_code=1
    systemctl daemon-reload >/dev/null 2>&1 || rollback_code=1
    cmp --silent -- "$APP_UNIT" "$old_rendered_unit" || rollback_code=1
  fi
  if (( runtime_swapped == 1 )) && [[ -d "$rollback_root/linux-schema3" && ! -L "$rollback_root/linux-schema3" ]]; then
    if [[ -d "$app_dir/server-tools/linux" && ! -L "$app_dir/server-tools/linux" ]]; then
      rm -rf --one-file-system -- "$app_dir/server-tools/linux" || rollback_code=1
    fi
    mv -T -- "$rollback_root/linux-schema3" "$app_dir/server-tools/linux" || rollback_code=1
    gp_apply_app_permissions "$app_dir/server-tools/linux" "$GP_DEFAULT_SERVICE_GROUP" || rollback_code=1
    runtime_tools_are_executable "$app_dir/server-tools/linux" || rollback_code=1
    if ! install -m 0600 -o root -g root /dev/null "$rollback_runtime_result"; then
      rollback_code=1
    elif ! "$node" "$candidate_verifier" --runtime-contract "$app_dir" >"$rollback_runtime_result"; then
      rollback_code=1
    elif ! "$node" - "$installed_runtime" "$rollback_runtime_result" <<'NODE' >/dev/null; then
const fs=require("node:fs");const [expectedFile,actualFile]=process.argv.slice(2);
const expected=JSON.parse(fs.readFileSync(expectedFile,"utf8"));
const actual=JSON.parse(fs.readFileSync(actualFile,"utf8"));
if(expected.deploymentSchemaVersion!==3||actual.deploymentSchemaVersion!==3
  ||actual.fingerprint!==expected.fingerprint
  ||JSON.stringify(actual.managedArtifacts)!==JSON.stringify(expected.managedArtifacts))process.exit(1);
NODE
      rollback_code=1
    fi
  fi
  systemctl start "$APP_SERVICE" >/dev/null 2>&1 || rollback_code=1
  systemctl is-active --quiet "$CADDY_SERVICE" || systemctl start "$CADDY_SERVICE" >/dev/null 2>&1 || rollback_code=1
  gp_wait_ready "$internal_ready_url" "$health_timeout" >/dev/null 2>&1 || rollback_code=1
  gp_wait_ready "$public_ready_url" "$health_timeout" >/dev/null 2>&1 || rollback_code=1
  return "$rollback_code"
}

cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$unit_pending" && "$unit_pending" == "${APP_UNIT}.runtime-v4.$$" \
    && -f "$unit_pending" && ! -L "$unit_pending" ]]; then
    rm -f -- "$unit_pending" || code=2
  fi
  if (( code != 0 && migration_complete == 0 && updater_succeeded == 0 \
    && (runtime_swapped == 1 || unit_swapped == 1) )); then
    if ! rollback_runtime; then
      rollback_failed=1
      code=2
      printf '%s\n' "Runtime-/Unit-Rollback unvollstaendig; manuelle Pruefung erforderlich." \
        >"$work_root/ROLLBACK-ACTION-REQUIRED"
      chmod 0600 -- "$work_root/ROLLBACK-ACTION-REQUIRED" || true
      chown root:root -- "$work_root/ROLLBACK-ACTION-REQUIRED" || true
    fi
  fi
  if (( rollback_failed == 1 )); then
    gp_warn "Der Diagnoseordner eines unvollstaendigen Rollbacks bleibt erhalten: $work_root"
  elif (( updater_succeeded == 1 && migration_complete == 0 )); then
    printf '%s\n' "Die App ist committed; kein unsicherer Teilrollback. Manuelle Pruefung erforderlich." \
      >"$work_root/POST-UPDATE-ACTION-REQUIRED"
    chmod 0600 -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
    chown root:root -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
    gp_warn "Der Diagnoseordner bleibt erhalten: $work_root"
  elif [[ -d "$work_root" && ! -L "$work_root" && "$work_root" == "$app_parent/".runtime-v4-migration.* ]]; then
    rm -rf --one-file-system -- "$work_root"
  fi
  exit "$code"
}
trap cleanup EXIT

install -m 0600 -o root -g root -- "$package" "$staged_package"
actual_package_sha256="$(gp_sha256 "$staged_package")"
[[ "$actual_package_sha256" == "$sha256_arg" ]] \
  || gp_die "Die SHA-256-Pruefsumme des Migrationspakets stimmt nicht."

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
getent passwd "$build_user" >/dev/null || gp_die "Der isolierte Build-Benutzer fehlt."
getent group "$build_group" >/dev/null || gp_die "Die isolierte Build-Gruppe fehlt."
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
  || gp_die "Die Paketpruefung fuer Runtime v4 fehlt."
manifest_result="$work_root/manifest.json"
"$node" "$candidate_verifier" "$extract_root" >"$manifest_result" \
  || gp_die "Manifest- und Einzeldateipruefung fehlgeschlagen."
cmp --silent -- "$SCRIPT_PATH" "$extract_root/server-tools/linux/migrate-grabenplaner-runtime-v4.sh" \
  || gp_die "Das gestartete Migrationsskript stammt nicht bytegleich aus dem geprueften Paket."
cmp --silent -- "$SCRIPT_DIR/lib/common.sh" "$extract_root/server-tools/linux/lib/common.sh" \
  || gp_die "Die geladene Sicherheitsbasis stammt nicht bytegleich aus dem geprueften Paket."
clamscan --recursive --infected --no-summary -- "$extract_root" >/dev/null \
  || gp_die "ClamAV hat das Migrationspaket abgelehnt."

env_sha256_before="$(gp_sha256 "$ENV_FILE")"
gp_acquire_maintenance_lock
[[ "$(gp_sha256 "$ENV_FILE")" == "$env_sha256_before" ]] \
  || gp_die "Die Serverkonfiguration wurde waehrend des Preflights veraendert."
systemctl is-active --quiet "$APP_SERVICE" || gp_die "$APP_SERVICE ist nicht mehr aktiv."
systemctl is-active --quiet "$CADDY_SERVICE" || gp_die "$CADDY_SERVICE ist nicht mehr aktiv."
gp_url_reports_ready "$internal_ready_url" 8 || gp_die "Der interne Readinesscheck ist unter der Wartungssperre nicht gruen."
gp_url_reports_ready "$public_ready_url" 15 || gp_die "Der oeffentliche Readinesscheck ist unter der Wartungssperre nicht gruen."

installed_runtime="$work_root/installed-runtime.json"
"$node" "$candidate_verifier" --runtime-contract "$app_dir" >"$installed_runtime" \
  || gp_die "Der bestehende Runtimevertrag ist nicht als sichere Schema-3-Installation lesbar."
readarray -t transition < <("$node" - "$installed_runtime" "$manifest_result" "$app_dir/package.json" <<'NODE'
const fs=require("node:fs");
const [oldFile,newFile,packageFile]=process.argv.slice(2);
const old=JSON.parse(fs.readFileSync(oldFile,"utf8"));
const result=JSON.parse(fs.readFileSync(newFile,"utf8"));
const next=result.runtimeContract;
const oldVersion=JSON.parse(fs.readFileSync(packageFile,"utf8")).version;
const same=(a,b)=>JSON.stringify([...(a||[])].sort())===JSON.stringify([...(b||[])].sort());
if(old.deploymentSchemaVersion!==3||next?.deploymentSchemaVersion!==4
  ||old.migrationPolicy!=="explicit-maintenance"||next.migrationPolicy!=="explicit-maintenance"
  ||!same(old.managedArtifacts,next.managedArtifacts)
  ||old.managedArtifacts.length!==11||!/^[a-f0-9]{64}$/.test(String(next.fingerprint||"")))process.exit(1);
process.stdout.write(`${oldVersion}\n${result.appVersion}\n${next.fingerprint}\n`);
NODE
) || gp_die "Freigegeben ist ausschliesslich der Runtimewechsel Schema 3 -> 4."
old_version="${transition[0]:-}"
candidate_version="${transition[1]:-}"
candidate_runtime_fingerprint="${transition[2]:-}"
[[ -n "$old_version" && -n "$candidate_version" && "$candidate_runtime_fingerprint" =~ ^[a-f0-9]{64}$ ]] \
  || gp_die "Die Runtime-Migrationsdaten sind unvollstaendig."
version_comparison="$(gp_compare_semver "$node" "$old_version" "$candidate_version")"
(( version_comparison <= 0 )) || gp_die "Die Runtime-v4-Migration akzeptiert keine aeltere App-Version."

for relative in Caddyfile.in grabenplaner-bootstrap-admin.sh.in grabenplaner-bootstrap.service.in \
  grabenplaner-monitor.service.in grabenplaner-monitor.timer.in \
  host-control/lib/host-reboot-broker.js \
  host-control/systemd/grabenplaner-host-control.socket.in \
  host-control/systemd/grabenplaner-host-control@.service.in \
  host-control/systemd/grabenplaner-host-reboot.service.in; do
  cmp --silent -- "$app_dir/server-tools/linux/$relative" "$extract_root/server-tools/linux/$relative" \
    || gp_die "Schema 4 erlaubt keine weitere Runtime-Aenderung: $relative"
done
"$node" - "$app_dir/server-tools/linux/grabenplaner.service.in" \
  "$extract_root/server-tools/linux/grabenplaner.service.in" <<'NODE' >/dev/null \
  || gp_die "Die App-Unit enthaelt nicht exakt den freigegebenen Boot-ID-Credential-Delta."
const fs=require("node:fs");
const [oldFile,nextFile]=process.argv.slice(2);
const oldText=fs.readFileSync(oldFile,"utf8");
const nextText=fs.readFileSync(nextFile,"utf8");
const block="# PID 1 reads the host boot ID before the hardened /proc namespace is applied.\nLoadCredential=host-boot-id:/proc/sys/kernel/random/boot_id\n";
if(oldText.includes("LoadCredential=host-boot-id:")
  ||nextText.split("LoadCredential=host-boot-id:").length!==2
  ||nextText.replace(block,"")!==oldText
  ||!nextText.includes("ProtectProc=invisible\n")
  ||!nextText.includes("ProcSubset=pid\n")
  ||!nextText.includes("ProtectKernelTunables=yes\n"))process.exit(1);
NODE

"$node" - "$app_dir/server-tools/linux/grabenplaner.env.example" \
  "$extract_root/server-tools/linux/grabenplaner.env.example" <<'NODE' >/dev/null \
  || gp_die "Das Env-Beispiel enthaelt nicht exakt den freigegebenen Benachrichtigungs-Kommentarblock."
const fs=require("node:fs");
const [oldFile,nextFile]=process.argv.slice(2);
const oldText=fs.readFileSync(oldFile,"utf8");
const nextText=fs.readFileSync(nextFile,"utf8");
const notificationBlock=`
# Optionaler Scaleway-TEM-Versand. Ohne ausdrueckliche Aktivierung und
# Ereignis-Positivliste wird keine E-Mail versendet. Zugangsdaten duerfen
# nur in der root-only Dienstkonfiguration stehen.
# GRABENPLANER_EMAIL_PROVIDER=scaleway-tem
# GRABENPLANER_EMAIL_FROM=Grabenplaner <benachrichtigung@grabenplaner.eu>
# GRABENPLANER_SCALEWAY_TEM_PROJECT_ID=<Scaleway-Projekt-ID>
# GRABENPLANER_SCALEWAY_TEM_SECRET_KEY=<eingeschraenkter TEM-API-Schluessel>
# GRABENPLANER_EMAIL_SENDER_APPROVED=0
# GRABENPLANER_EMAIL_DISPATCH_ENABLED=0
# GRABENPLANER_EMAIL_ALLOWED_EVENTS=

# Optionaler providerneutraler E-Mail-HTTPS-Adapter. Er verwendet denselben
# freigegebenen Absender, Versand-Schalter und dieselbe Ereignis-Positivliste
# wie SMTP. URL und Token allein schalten keinen Versand frei.
# GRABENPLANER_EMAIL_WEBHOOK_URL=https://notify.example.invalid/email
# GRABENPLANER_EMAIL_WEBHOOK_TOKEN=<eingeschraenktes-Webhook-Token>

# Providerneutrale SMS- und WhatsApp-HTTPS-Adapter. Jeder Kanal bleibt ohne
# vollstaendige Zugangsdaten, freigegebenen Absender, expliziten Versand-
# Schalter und mindestens ein freigegebenes Ereignis fail-closed.
# GRABENPLANER_SMS_WEBHOOK_URL=https://notify.example.invalid/sms
# GRABENPLANER_SMS_WEBHOOK_TOKEN=<eingeschraenktes-Webhook-Token>
# GRABENPLANER_SMS_SENDER=<freigegebener-SMS-Absender>
# GRABENPLANER_SMS_SENDER_APPROVED=0
# GRABENPLANER_SMS_DISPATCH_ENABLED=0
# GRABENPLANER_SMS_ALLOWED_EVENTS=
# GRABENPLANER_WHATSAPP_WEBHOOK_URL=https://notify.example.invalid/whatsapp
# GRABENPLANER_WHATSAPP_WEBHOOK_TOKEN=<eingeschraenktes-Webhook-Token>
# GRABENPLANER_WHATSAPP_SENDER=<freigegebener-WhatsApp-Absender>
# GRABENPLANER_WHATSAPP_SENDER_APPROVED=0
# GRABENPLANER_WHATSAPP_DISPATCH_ENABLED=0
# GRABENPLANER_WHATSAPP_ALLOWED_EVENTS=

`;
if(nextText!==oldText
  && (nextText.split("# Optionaler Scaleway-TEM-Versand.").length!==2
    ||nextText.split("# GRABENPLANER_WHATSAPP_ALLOWED_EVENTS=").length!==2
    ||nextText.replace(notificationBlock,"")!==oldText))process.exit(1);
NODE

install -d -m 0700 -- "$rendered_root/v3" "$rendered_root/v4"
old_rendered_unit="$rendered_root/v3/grabenplaner.service"
candidate_rendered_unit="$rendered_root/v4/grabenplaner.service"
render_app_unit "$app_dir/server-tools/linux/grabenplaner.service.in" "$old_rendered_unit"
render_app_unit "$extract_root/server-tools/linux/grabenplaner.service.in" "$candidate_rendered_unit"
cmp --silent -- "$APP_UNIT" "$old_rendered_unit" \
  || gp_die "Die installierte App-Unit weicht vom bestehenden Schema-3-Vertrag ab."
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$candidate_rendered_unit" >/dev/null \
    || gp_die "Die Schema-4-App-Unit ist fuer systemd ungueltig."
fi

gp_info "Binde den exakt geprueften Runtime-v4-Wartungsbaum und die Credential-Unit ein."
mv -T -- "$app_dir/server-tools/linux" "$rollback_root/linux-schema3"
runtime_swapped=1
cp --archive -- "$extract_root/server-tools/linux" "$work_root/linux-schema4"
gp_apply_app_permissions "$work_root/linux-schema4" "$GP_DEFAULT_SERVICE_GROUP"
runtime_tools_are_executable "$work_root/linux-schema4" \
  || gp_die "Die Runtime-v4-Wartungswerkzeuge sind nicht ausfuehrbar."
[[ -x "$work_root/linux-schema4/migrate-grabenplaner-runtime-v4.sh" \
  && ! -L "$work_root/linux-schema4/migrate-grabenplaner-runtime-v4.sh" ]] \
  || gp_die "Das Runtime-v4-Migrationswerkzeug ist nicht sicher ausfuehrbar."
mv -T -- "$work_root/linux-schema4" "$app_dir/server-tools/linux"
install -m 0644 -o root -g root -- "$APP_UNIT" "$rollback_root/grabenplaner.service"
unit_pending="${APP_UNIT}.runtime-v4.$$"
install -m 0644 -o root -g root -- "$candidate_rendered_unit" "$unit_pending"
mv -T -- "$unit_pending" "$APP_UNIT"
unit_pending=""
unit_swapped=1
systemctl daemon-reload
cmp --silent -- "$APP_UNIT" "$candidate_rendered_unit" \
  || gp_die "Die installierte Schema-4-App-Unit ist nicht bytegleich gebunden."

updater_output="$work_root/updater-result.json"
install -m 0600 -o root -g root /dev/null "$updater_output"
update_args=(
  --package "$staged_package" --sha256 "$actual_package_sha256" --env-file "$ENV_FILE"
  --app-dir "$app_dir" --data-dir "$data_dir" --database "$database" --backup-dir "$backup_dir"
  --public-url "$public_url" --node "$node" --service "$APP_SERVICE" --caddy-service "$CADDY_SERVICE"
  --health-timeout "$health_timeout" --lock-already-held --commit-marker "$updater_commit_marker"
)
if [[ -n "$pnpm_arg" ]]; then update_args+=(--pnpm "$pnpm_arg"); fi
if (( version_comparison == 0 )); then update_args+=(--allow-downgrade-or-reinstall); fi
set +e
bash "$app_dir/server-tools/linux/update-grabenplaner-server.sh" "${update_args[@]}" >"$updater_output"
updater_status=$?
set -e
if updater_commit_is_valid; then
  updater_succeeded=1
elif (( updater_status != 0 )); then
  gp_die "Das App-Update innerhalb der Runtime-v4-Migration ist fehlgeschlagen."
else
  gp_die "Der App-Updater meldete Erfolg ohne dauerhaften Commitnachweis."
fi

post_update_fail() {
  local message="$1"
  printf '%s\n' "$message" >"$work_root/POST-UPDATE-ACTION-REQUIRED"
  chmod 0600 -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
  chown root:root -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
  gp_log ERROR "$message Die App ist bereits committed; Diagnose: $work_root"
  exit 2
}

[[ "$(gp_sha256 "$ENV_FILE")" == "$env_sha256_before" ]] \
  || post_update_fail "Die geschuetzte Server-Umgebungsdatei wurde unerwartet veraendert."
installed_v4="$work_root/installed-runtime-v4.json"
"$node" "$app_dir/server-tools/linux/lib/verify-package.js" --runtime-contract "$app_dir" >"$installed_v4" \
  || post_update_fail "Der installierte Runtime-v4-Vertrag ist nach dem App-Commit nicht lesbar."
"$node" - "$installed_v4" "$candidate_runtime_fingerprint" "$app_dir/package.json" "$candidate_version" <<'NODE' >/dev/null \
  || post_update_fail "Die installierte App ist nicht exakt an den Runtime-v4-Vertrag gebunden."
const fs=require("node:fs");const [runtimeFile,fingerprint,packageFile,version]=process.argv.slice(2);
const runtime=JSON.parse(fs.readFileSync(runtimeFile,"utf8"));const pkg=JSON.parse(fs.readFileSync(packageFile,"utf8"));
if(runtime.deploymentSchemaVersion!==4||runtime.fingerprint!==fingerprint||pkg.version!==version)process.exit(1);
NODE
cmp --silent -- "$APP_UNIT" "$candidate_rendered_unit" \
  || post_update_fail "Die installierte App-Unit weicht vom Runtime-v4-Vertrag ab."
grep -Fxq -- "$CREDENTIAL_LINE" "$APP_UNIT" \
  || post_update_fail "Das Boot-ID-Credential fehlt in der installierten App-Unit."
systemctl is-active --quiet "$HOST_REBOOT_SERVICE" \
  && post_update_fail "Die Runtime-Migration hat unerwartet einen Host-Neustart ausgeloest."
gp_wait_ready "$internal_live_url" "$health_timeout" \
  || post_update_fail "Die migrierte App beantwortet den internen Livenesscheck nicht."
gp_wait_ready "$internal_ready_url" "$health_timeout" \
  || post_update_fail "Die migrierte App ist intern nicht bereit."
gp_wait_ready "$public_live_url" "$health_timeout" \
  || post_update_fail "Die migrierte App ist oeffentlich nicht erreichbar."
gp_wait_ready "$public_ready_url" "$health_timeout" \
  || post_update_fail "Die migrierte App ist oeffentlich nicht bereit."
host_boot_generation="$(curl --fail --silent --show-error --max-time 15 "$internal_ready_url" \
  | "$node" -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const v=JSON.parse(s);if(v.ok!==true||!/^[a-f0-9]{32}$/.test(String(v.hostBootGeneration||"")))process.exit(1);process.stdout.write(v.hostBootGeneration)}catch{process.exit(1)}})')" \
  || post_update_fail "Die App bestaetigt keine gueltige Host-Bootgeneration aus dem Credential."
systemctl is-active --quiet "$BOOTSTRAP_SERVICE" \
  && post_update_fail "Der einmalige Bootstrap wurde unerwartet aktiviert."

history_dir="$data_dir/maintenance/history"
install -d -m 0750 -o root -g "$GP_DEFAULT_SERVICE_GROUP" -- "$history_dir" \
  || post_update_fail "Der Migrationsverlauf konnte nicht vorbereitet werden."
receipt="$history_dir/runtime-v4-$(date --utc '+%Y-%m-%dT%H-%M-%S-%3N').json"
if ! "$node" - "$receipt" "$old_version" "$candidate_version" "$actual_package_sha256" \
  "$candidate_runtime_fingerprint" "$env_sha256_before" "$host_boot_generation" "$updater_commit_marker" <<'NODE'
const fs=require("node:fs");
const [file,fromVersion,toVersion,packageSha256,runtimeFingerprint,environmentSha256,hostBootGeneration,commitFile]=process.argv.slice(2);
const commit=JSON.parse(fs.readFileSync(commitFile,"utf8"));
const payload={
  format:"grabenplaner-runtime-migration",schemaVersion:1,status:"success",
  completedAt:new Date().toISOString(),deploymentSchema:{from:3,to:4},
  fromVersion,toVersion,packageSha256,runtimeFingerprint,environmentSha256,
  systemdCredential:{name:"host-boot-id",source:"/proc/sys/kernel/random/boot_id",hostBootGeneration},
  bootstrapReopened:false,rebootTriggered:false,
  updateCommittedAt:commit.committedAt,
};
fs.writeFileSync(file,`${JSON.stringify(payload,null,2)}\n`,{mode:0o640});
NODE
then
  post_update_fail "Der gepruefte Runtime-v4-Migrationsbeleg konnte nicht erzeugt werden."
fi
chown "root:$GP_DEFAULT_SERVICE_GROUP" -- "$receipt" \
  || post_update_fail "Der Migrationsbeleg konnte nicht sicher zugeordnet werden."
chmod 0640 -- "$receipt" \
  || post_update_fail "Der Migrationsbeleg konnte nicht sicher geschuetzt werden."

migration_complete=1
rm -rf --one-file-system -- "$rollback_root" \
  || gp_warn "Der nicht mehr benoetigte Runtime-v3-Rollbackordner konnte nicht entfernt werden."
printf '%s\n' "{\"ok\":true,\"fromSchema\":3,\"toSchema\":4,\"fromVersion\":\"$old_version\",\"toVersion\":\"$candidate_version\",\"hostBootGeneration\":\"$host_boot_generation\",\"rebootTriggered\":false,\"receipt\":\"$receipt\"}"
gp_info "Runtime-Schema 3 wurde kontrolliert auf Schema 4 migriert; die Bootgeneration ist verfuegbar und es wurde kein Host-Neustart ausgeloest."

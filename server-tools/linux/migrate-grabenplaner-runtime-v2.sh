#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Einmaliger, expliziter Wartungsweg fuer Deployment-Schema 1 -> 2.
# Das normale Update bleibt absichtlich schema-starr. Diese Migration bindet
# zuerst die neuen root-verwalteten Monitor-Artefakte und erst danach den
# bewaehrten, backup- und rollback-faehigen App-Updater ein.

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
readonly BOOTSTRAP_COMMAND="/usr/local/sbin/grabenplaner-bootstrap-admin"
readonly MONITOR_UNIT="/etc/systemd/system/grabenplaner-monitor.service"
readonly MONITOR_TIMER="/etc/systemd/system/grabenplaner-monitor.timer"
readonly MONITOR_COMMAND="/usr/local/sbin/grabenplaner-monitor"
readonly MONITOR_STATUS_ROOT="/var/lib/grabenplaner-monitor"
readonly MONITOR_STATUS_FILE="$MONITOR_STATUS_ROOT/status.json"
readonly MONITOR_STATUS_GROUP="grabenplaner-monitor-status"
readonly OFFSITE_MODULE_ROOT="/opt/grabenplaner-offsite/module"
readonly OFFSITE_CONFIG_ROOT="/etc/grabenplaner/offsite"
readonly OFFSITE_RECEIPT="$OFFSITE_CONFIG_ROOT/installed-contract.json"
readonly OFFSITE_CREDENTIAL_FILE="/var/lib/grabenplaner-offsite/credentials/rclone.conf"
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
  sudo ./migrate-grabenplaner-runtime-v2.sh \
    --package /pfad/Grabenplaner-Server-v0.74.0-beta-linux-x64.zip \
    [--sha256 HEX | --sha256-file /pfad/paket.zip.sha256]

Dieser root-only Wartungsvorgang akzeptiert ausschliesslich den freigegebenen
Wechsel des Ubuntu-Deploymentvertrags von Schema 1 auf Schema 2. Daten,
Umgebungsdatei, Admin-Zugang und Offsite-Geheimnisse werden nicht neu erzeugt.
Der einmalige Admin-Bootstrap wird niemals erneut geoeffnet.
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
for command_name in awk bash basename caddy chown chmod clamscan cmp cp curl date du find flock getent gpasswd grep groupadd groupdel id install mktemp mv readlink realpath rm runuser sha256sum sleep sort stat sync systemctl tr uname unzip usermod; do
  gp_require_command "$command_name"
done
[[ -n "$package_arg" ]] || gp_die "--package ist erforderlich."
[[ -z "$sha256_arg" || -z "$sha256_file_arg" ]] || gp_die "--sha256 und --sha256-file duerfen nicht gemeinsam verwendet werden."
[[ "$health_timeout" =~ ^[0-9]+$ ]] && (( health_timeout >= 30 && health_timeout <= 600 )) \
  || gp_die "--health-timeout muss zwischen 30 und 600 liegen."
[[ -r /etc/os-release && ! -L /etc/os-release ]] || gp_die "Ubuntu konnte nicht sicher erkannt werden."
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" =~ ^(24\.04|26\.04)$ && "$(uname -m)" == "x86_64" ]] \
  || gp_die "Die Runtime-v2-Migration unterstuetzt Ubuntu 24.04/26.04 auf x86_64."

if [[ -n "$node_arg" ]]; then node="$(gp_existing_file "$node_arg" "Node.js")"; else gp_require_command node; node="$(command -v node)"; fi
node="$(readlink -f -- "$node")"
"$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13)||process.arch!=="x64")process.exit(1)' \
  || gp_die "Node.js >=22.13.0 fuer Linux x64 wird benoetigt."
if [[ -n "$pnpm_arg" ]]; then
  pnpm_program="$(gp_existing_file "$pnpm_arg" "pnpm")"
  pnpm_options=()
elif command -v pnpm >/dev/null 2>&1; then
  pnpm_program="$(command -v pnpm)"
  pnpm_options=()
elif command -v corepack >/dev/null 2>&1; then
  pnpm_program="$(command -v corepack)"
  pnpm_options=(pnpm)
else
  gp_die "Weder pnpm noch Corepack/pnpm ist installiert."
fi

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
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || gp_die "Der bestehende interne Port ist ungueltig."
[[ "${GRABENPLANER_OPERATION_MODE:-}" == "server" && "${GRABENPLANER_DEPLOYMENT_KIND:-}" == "production" ]] \
  || gp_die "Die Migration ist nur fuer eine bestehende produktive Ubuntu-Serverinstallation freigegeben."
[[ -z "${GRABENPLANER_BOOTSTRAP_TOKEN:-}" ]] \
  || gp_die "Der einmalige Admin-Bootstrap ist noch nicht verbraucht; die Runtime-Migration wird nicht gestartet."
for unit in "$APP_SERVICE" "$BOOTSTRAP_SERVICE" "$CADDY_SERVICE"; do gp_require_systemd_unit "$unit"; done
systemctl is-active --quiet "$APP_SERVICE" || gp_die "$APP_SERVICE muss vor der Migration aktiv sein."
systemctl is-active --quiet "$CADDY_SERVICE" || gp_die "$CADDY_SERVICE muss vor der Migration aktiv sein."
systemctl is-active --quiet "$BOOTSTRAP_SERVICE" && gp_die "Der Admin-Bootstrap darf waehrend der Migration nicht laufen."

"$node" - "$database" <<'NODE' >/dev/null || gp_die "Kein aktiver administrativer Zugang gefunden; der Bootstrap wird nicht automatisch erneut geoeffnet."
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
work_root="$(mktemp --directory --tmpdir="$app_parent" .runtime-v2-migration.XXXXXXXX)"
early_cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "${work_root:-}" && -d "$work_root" && ! -L "$work_root" && "$work_root" == "$app_parent/".runtime-v2-migration.* ]]; then
    rm -rf --one-file-system -- "$work_root"
  fi
  exit "$code"
}
trap early_cleanup EXIT
chown root:root -- "$work_root"
# Der isolierte Build-Benutzer braucht ausschliesslich Traverse-Recht bis zu
# seinem eigenen Extract-Ordner. Listen, Lesen und Schreiben am Parent bleiben
# verboten; das Paket selbst wird spaeter nur seiner Build-Gruppe lesbar.
chmod 0711 -- "$work_root"
staged_package="$work_root/package.zip"
extract_root="$work_root/extract"
rollback_root="$work_root/rollback"
mkdir -m 0700 -- "$extract_root" "$rollback_root"
runtime_swapped=0
runtime_bound=0
offsite_swapped=0
updater_succeeded=0
updater_invoked=0
migration_complete=0
offsite_configured=0
offsite_timers_paused=0
offsite_timer_names=(grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer)
offsite_timer_was_active=(0 0 0)
recovery_link_created=0
monitor_group_created=0
monitor_membership_added=0
monitor_status_root_created=0
updater_commit_marker="$work_root/updater-commit.json"

write_phase() {
  local phase="$1" temporary="$work_root/.phase.$$"
  printf '%s\n' "$phase" >"$temporary"
  chmod 0600 -- "$temporary"
  chown root:root -- "$temporary"
  mv -f -- "$temporary" "$work_root/phase"
  sync -f "$work_root/phase"
  sync -f "$work_root"
}

updater_commit_is_valid() {
  [[ -f "$updater_commit_marker" && ! -L "$updater_commit_marker" ]] || return 1
  "$node" - "$updater_commit_marker" "${candidate_version:-}" "$actual_package_sha256" <<'NODE' >/dev/null
const fs=require("node:fs");const [file,version,sha]=process.argv.slice(2);const stat=fs.lstatSync(file);const value=JSON.parse(fs.readFileSync(file,"utf8"));
if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o077)!==0||value?.format!=="grabenplaner-update-commit"||value?.schemaVersion!==1||value?.status!=="committed"||value?.installedVersion!==version||value?.packageSha256!==sha||!Number.isFinite(Date.parse(value?.committedAt||"")))process.exit(1);
NODE
}

restore_optional_file() {
  local backup="$1" target="$2"
  if [[ -f "$backup" && ! -L "$backup" ]]; then
    cp --archive -- "$backup" "$target"
  else
    rm -f -- "$target"
  fi
}

rollback_runtime() {
  set +e
  gp_warn "Die Runtime-v2-Migration ist fehlgeschlagen; Schema 1 wird wiederhergestellt."
  systemctl disable --now grabenplaner-monitor.timer >/dev/null 2>&1 || true
  systemctl stop grabenplaner-monitor.service "$APP_SERVICE" >/dev/null 2>&1 || true
  if (( offsite_swapped == 1 )); then
    for unit in grabenplaner-offsite-prepare.service grabenplaner-offsite-upload.service grabenplaner-offsite-upload.timer \
      grabenplaner-offsite-check.service grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.service grabenplaner-offsite-restore-test.timer; do
      restore_optional_file "$rollback_root/offsite-units/$unit" "/etc/systemd/system/$unit"
    done
    if [[ -d "$rollback_root/offsite-module" && ! -L "$rollback_root/offsite-module" ]]; then
      [[ ! -e "$OFFSITE_MODULE_ROOT" && ! -L "$OFFSITE_MODULE_ROOT" ]] || rm -rf --one-file-system -- "$OFFSITE_MODULE_ROOT"
      mv -T -- "$rollback_root/offsite-module" "$OFFSITE_MODULE_ROOT"
      restore_optional_file "$rollback_root/offsite-installed-contract.json" "$OFFSITE_RECEIPT"
    fi
    if (( recovery_link_created == 1 )) && [[ -L /usr/local/sbin/grabenplaner-recovery \
      && "$(readlink -- /usr/local/sbin/grabenplaner-recovery)" == "$app_dir/server-tools/linux/recovery/grabenplaner-recovery.sh" ]]; then
      rm -f -- /usr/local/sbin/grabenplaner-recovery
    fi
  fi
  if (( runtime_bound == 1 )); then
    restore_optional_file "$rollback_root/bootstrap-command" "$BOOTSTRAP_COMMAND"
    rm -f -- "$MONITOR_UNIT" "$MONITOR_TIMER" "$MONITOR_COMMAND"
  fi
  if (( runtime_swapped == 1 )) && [[ -d "$rollback_root/linux-schema1" ]]; then
    if [[ -e "$app_dir/server-tools/linux" || -L "$app_dir/server-tools/linux" ]]; then
      [[ -d "$app_dir/server-tools/linux" && ! -L "$app_dir/server-tools/linux" ]] \
        && rm -rf --one-file-system -- "$app_dir/server-tools/linux"
    fi
    mv -T -- "$rollback_root/linux-schema1" "$app_dir/server-tools/linux"
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  if (( monitor_status_root_created == 1 )) && [[ -d "$MONITOR_STATUS_ROOT" && ! -L "$MONITOR_STATUS_ROOT" ]]; then
    rm -rf --one-file-system -- "$MONITOR_STATUS_ROOT"
  fi
  if (( monitor_membership_added == 1 )); then
    gpasswd --delete "$GP_DEFAULT_SERVICE_USER" "$MONITOR_STATUS_GROUP" >/dev/null 2>&1 || true
  fi
  if (( monitor_group_created == 1 )); then
    groupdel "$MONITOR_STATUS_GROUP" >/dev/null 2>&1 || true
  fi
  systemctl start "$APP_SERVICE" >/dev/null 2>&1 || true
  if (( offsite_configured == 1 )); then
    for index in "${!offsite_timer_names[@]}"; do
      (( offsite_timer_was_active[index] == 0 )) || systemctl start "${offsite_timer_names[index]}" >/dev/null 2>&1 || true
    done
  fi
  if ! gp_wait_ready "$internal_ready_url" "$health_timeout" || ! gp_wait_ready "$public_ready_url" "$health_timeout"; then
    gp_log ERROR "Schema 1 konnte nach dem Rollback nicht vollstaendig bestaetigt werden; das Wartungsverzeichnis bleibt unter $work_root erhalten."
    return 1
  fi
  return 0
}

cleanup() {
  local code=$?
  trap - EXIT
  [[ ! -d "$rollback_root/linux-schema1" ]] || runtime_swapped=1
  [[ ! -d "$rollback_root/offsite-module" ]] || offsite_swapped=1
  if (( updater_invoked == 1 )) && updater_commit_is_valid; then updater_succeeded=1; fi
  if (( code != 0 && migration_complete == 0 && updater_succeeded == 0 && (runtime_swapped == 1 || runtime_bound == 1 || offsite_swapped == 1) )); then
    rollback_runtime || code=2
  fi
  # Timer werden bei jedem Exit exakt auf ihren vorherigen Aktivzustand
  # zurueckgebracht. Das gilt insbesondere fuer TERM oder einen Belegfehler
  # nach einem bereits dauerhaft committed inneren App-Update.
  if (( offsite_timers_paused == 1 && offsite_configured == 1 )); then
    for index in "${!offsite_timer_names[@]}"; do
      (( offsite_timer_was_active[index] == 0 )) || systemctl start "${offsite_timer_names[index]}" >/dev/null 2>&1 || true
    done
    offsite_timers_paused=0
  fi
  if (( migration_complete == 1 || (runtime_swapped == 0 && runtime_bound == 0 && offsite_swapped == 0) )); then
    rm -rf --one-file-system -- "$work_root"
  fi
  exit "$code"
}
trap cleanup EXIT

install -m 0600 -o root -g root -- "$package" "$staged_package"
actual_package_sha256="$(gp_sha256 "$staged_package")"
[[ "$actual_package_sha256" == "$sha256_arg" ]] || gp_die "Die SHA-256-Pruefsumme des Migrationspakets stimmt nicht."

gp_info "Pruefe ZIP-Struktur und entpackte Maximalgroesse."
zip_summary="$(unzip -Z -t "$staged_package")" || gp_die "Das ZIP-Zentralverzeichnis ist unlesbar."
entry_count="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ {print $1; exit}')"
expanded_bytes="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ {print $3; exit}')"
[[ "$entry_count" =~ ^[0-9]+$ && "$expanded_bytes" =~ ^[0-9]+$ ]] || gp_die "Die ZIP-Groessenangaben sind ungueltig."
(( entry_count > 0 && entry_count <= 100000 && expanded_bytes <= MAX_EXPANDED_BYTES )) || gp_die "Das Migrationspaket ist leer oder zu gross."
zip_listing="$(unzip -Z -l "$staged_package")" || gp_die "Die ZIP-Dateitypen sind unlesbar."
parsed_modes=0
while IFS= read -r mode; do
  ((parsed_modes += 1))
  case "${mode:0:1}" in -|d) ;; *) gp_die "Links und Spezialdateien sind im Migrationspaket nicht erlaubt." ;; esac
done < <(printf '%s\n' "$zip_listing" | awk '$1 ~ /^[-dlbcps]/ && $2 ~ /^[0-9]/ {print $1}')
(( parsed_modes == entry_count )) || gp_die "Nicht alle ZIP-Dateitypen konnten sicher bestimmt werden."
unzip -tq "$staged_package" >/dev/null || gp_die "Das Server-ZIP ist beschaedigt."
while IFS= read -r entry; do
  normalized="${entry#./}"; normalized="${normalized%/}"
  [[ -n "$normalized" ]] || continue
  [[ ! "$entry" =~ [[:cntrl:]] && "$normalized" != /* && "$normalized" != *\\* ]] || gp_die "Ungueltiger ZIP-Pfad."
  IFS=/ read -ra segments <<<"$normalized"
  for segment in "${segments[@]}"; do [[ -n "$segment" && "$segment" != . && "$segment" != .. ]] || gp_die "Nicht kanonischer ZIP-Pfad."; done
done < <(unzip -Z1 "$staged_package")

build_user="${GP_DEFAULT_BUILD_USER}"
build_group="${GP_DEFAULT_BUILD_GROUP}"
getent passwd "$build_user" >/dev/null || gp_die "Der bestehende isolierte Build-Benutzer fehlt."
getent group "$build_group" >/dev/null || gp_die "Die bestehende isolierte Build-Gruppe fehlt."
chown "root:$build_group" -- "$staged_package"
chmod 0640 -- "$staged_package"
chown "$build_user:$build_group" -- "$extract_root"
runuser --user "$build_user" -- unzip -qq "$staged_package" -d "$extract_root"
[[ -z "$(find "$extract_root" ! -type f ! -type d -print -quit)" ]] || gp_die "Das entpackte Paket enthaelt unzulaessige Dateitypen."
(( $(du --bytes --summarize "$extract_root" | awk '{print $1}') <= MAX_EXPANDED_BYTES )) || gp_die "Das entpackte Paket ist zu gross."

candidate_verifier="$extract_root/server-tools/linux/lib/verify-package.js"
[[ -f "$candidate_verifier" && ! -L "$candidate_verifier" ]] || gp_die "Die Paketpruefung fuer Runtime v2 fehlt."
manifest_result="$work_root/manifest.json"
"$node" "$candidate_verifier" "$extract_root" >"$manifest_result" || gp_die "Manifest- und Einzeldateipruefung fehlgeschlagen."
cmp --silent -- "$SCRIPT_PATH" "$extract_root/server-tools/linux/migrate-grabenplaner-runtime-v2.sh" \
  || gp_die "Das gestartete Migrationsskript stammt nicht bytegleich aus dem geprueften Paket."
cmp --silent -- "$SCRIPT_DIR/lib/common.sh" "$extract_root/server-tools/linux/lib/common.sh" \
  || gp_die "Die geladene Sicherheitsbasis stammt nicht bytegleich aus dem geprueften Paket."
clamscan --recursive --infected --no-summary -- "$extract_root" >/dev/null || gp_die "ClamAV hat das Migrationspaket abgelehnt."

env_sha256_prelock="$(gp_sha256 "$ENV_FILE")"
gp_acquire_maintenance_lock
[[ "$(gp_sha256 "$ENV_FILE")" == "$env_sha256_prelock" ]] || gp_die "Die Serverkonfiguration wurde waehrend des Migrations-Preflights veraendert."
systemctl is-active --quiet "$APP_SERVICE" || gp_die "$APP_SERVICE ist nach Erwerb der Wartungssperre nicht mehr aktiv."
systemctl is-active --quiet "$CADDY_SERVICE" || gp_die "$CADDY_SERVICE ist nach Erwerb der Wartungssperre nicht mehr aktiv."
systemctl is-active --quiet "$BOOTSTRAP_SERVICE" && gp_die "Der Admin-Bootstrap wurde waehrend des Migrations-Preflights aktiviert."
gp_url_reports_ready "$internal_ready_url" 8 || gp_die "Der interne Readinesscheck ist unter der Wartungssperre nicht mehr gruen."
gp_url_reports_ready "$public_ready_url" 15 || gp_die "Der oeffentliche Readinesscheck ist unter der Wartungssperre nicht mehr gruen."
"$node" - "$database" <<'NODE' >/dev/null || gp_die "Der administrative Zugang ist unter der Wartungssperre nicht mehr bestaetigt."
const {DatabaseSync}=require("node:sqlite");let db;try{db=new DatabaseSync(process.argv[2],{readOnly:true});const row=db.prepare("SELECT COUNT(*) AS count FROM portal_users WHERE active=1 AND role IN ('developer','it_admin','admin')").get();if(Number(row?.count||0)<1)process.exit(1)}catch{process.exit(1)}finally{try{db?.close()}catch{}}
NODE

installed_runtime="$work_root/installed-runtime.json"
"$node" "$candidate_verifier" --runtime-contract "$app_dir" >"$installed_runtime" \
  || gp_die "Der bestehende Runtimevertrag ist nicht als sichere Schema-1-Installation lesbar."
readarray -t transition < <("$node" - "$installed_runtime" "$manifest_result" "$app_dir/package.json" <<'NODE'
const fs=require("node:fs");
const [oldFile,newFile,packageFile]=process.argv.slice(2);
const old=JSON.parse(fs.readFileSync(oldFile,"utf8"));
const result=JSON.parse(fs.readFileSync(newFile,"utf8"));
const next=result.runtimeContract;
const oldVersion=JSON.parse(fs.readFileSync(packageFile,"utf8")).version;
const candidateVersion=result.appVersion;
const v1=["server-tools/linux/Caddyfile.in","server-tools/linux/grabenplaner-bootstrap-admin.sh.in","server-tools/linux/grabenplaner-bootstrap.service.in","server-tools/linux/grabenplaner.env.example","server-tools/linux/grabenplaner.service.in"].sort();
const v2=[...v1,"server-tools/linux/grabenplaner-monitor.service.in","server-tools/linux/grabenplaner-monitor.timer.in"].sort();
const same=(a,b)=>JSON.stringify([...(a||[])].sort())===JSON.stringify(b);
if(old.deploymentSchemaVersion!==1||next?.deploymentSchemaVersion!==2||old.migrationPolicy!=="explicit-maintenance"||next.migrationPolicy!=="explicit-maintenance"||!same(old.managedArtifacts,v1)||!same(next.managedArtifacts,v2))process.exit(1);
if(next?.offsiteModule?.moduleVersion!==1||old?.offsiteModule?.moduleVersion!==1)process.exit(1);
process.stdout.write(`${oldVersion}\n${candidateVersion}\n${next.fingerprint}\n`);
NODE
) || gp_die "Freigegeben ist ausschliesslich der Runtimewechsel Schema 1 -> 2."
old_version="${transition[0]:-}"
candidate_version="${transition[1]:-}"
candidate_runtime_fingerprint="${transition[2]:-}"
[[ -n "$old_version" && -n "$candidate_version" && "$candidate_runtime_fingerprint" =~ ^[a-f0-9]{64}$ ]] || gp_die "Die Runtime-Migrationsdaten sind unvollstaendig."
(( $(gp_compare_semver "$node" "$old_version" "$candidate_version") < 0 )) || gp_die "Die Runtime-v2-Migration erfordert eine neuere App-Version."

for relative in Caddyfile.in grabenplaner-bootstrap.service.in grabenplaner.env.example grabenplaner.service.in; do
  cmp --silent -- "$app_dir/server-tools/linux/$relative" "$extract_root/server-tools/linux/$relative" \
    || gp_die "Schema 2 enthaelt ausserhalb des freigegebenen Monitor-/Bootstrap-Deltas eine Runtime-Aenderung: $relative"
done
[[ ! -e "$MONITOR_UNIT" && ! -L "$MONITOR_UNIT" && ! -e "$MONITOR_TIMER" && ! -L "$MONITOR_TIMER" \
  && ! -e "$MONITOR_COMMAND" && ! -L "$MONITOR_COMMAND" \
  && ! -e "$MONITOR_STATUS_ROOT" && ! -L "$MONITOR_STATUS_ROOT" ]] \
  || gp_die "Monitor-Artefakte sind bereits vorhanden; eine teilweise Migration wird nicht blind fortgesetzt."
[[ -f "$BOOTSTRAP_COMMAND" && ! -L "$BOOTSTRAP_COMMAND" ]] || gp_die "Der bestehende root-verwaltete Bootstrap-Helfer fehlt."

env_sha256_before="$(gp_sha256 "$ENV_FILE")"
offsite_secret_digest() {
  local files=(
    "$OFFSITE_CONFIG_ROOT/repository" "$OFFSITE_CONFIG_ROOT/repository-id" "$OFFSITE_CONFIG_ROOT/installation-id"
    "$OFFSITE_CONFIG_ROOT/restic-password" "$OFFSITE_CONFIG_ROOT/rclone-config-password" "$OFFSITE_CONFIG_ROOT/binary-pins.json"
    "$OFFSITE_CREDENTIAL_FILE"
  )
  local file
  for file in "${files[@]}"; do [[ -f "$file" && ! -L "$file" ]] || return 1; done
  for file in "${files[@]}"; do printf '%s\0%s\0' "${file##*/}" "$(gp_sha256 "$file")"; done | sha256sum --binary | awk '{print tolower($1)}'
}

if [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == "1" ]]; then
  offsite_configured=1
  [[ "${GRABENPLANER_OFFSITE_STATUS_FILE:-}" == "/var/lib/grabenplaner-offsite/status.json" ]] || gp_die "Die Offsite-Konfiguration ist unvollstaendig."
  [[ -d "$OFFSITE_MODULE_ROOT" && ! -L "$OFFSITE_MODULE_ROOT" && -f "$OFFSITE_RECEIPT" && ! -L "$OFFSITE_RECEIPT" ]] || gp_die "Das konfigurierte Offsite-Modul ist unvollstaendig."
  "$node" "$OFFSITE_MODULE_ROOT/lib/offsite-contract.js" verify-installed "$OFFSITE_MODULE_ROOT" "$OFFSITE_RECEIPT" >/dev/null \
    || gp_die "Das bestehende Offsite-Modul stimmt nicht mit seinem Installationsbeleg ueberein."
  offsite_secrets_before="$(offsite_secret_digest)" || gp_die "Die geschuetzten Offsite-Dateien sind unvollstaendig."
  [[ ! -e /usr/local/sbin/grabenplaner-recovery && ! -L /usr/local/sbin/grabenplaner-recovery ]] \
    || gp_die "Ein vorhandener grabenplaner-recovery-Befehl wird von der Migration nicht ueberschrieben."
elif [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" != "0" && -n "${GRABENPLANER_OFFSITE_CONFIGURED:-}" ]]; then
  gp_die "GRABENPLANER_OFFSITE_CONFIGURED ist ungueltig."
else
  offsite_secrets_before=""
fi

if (( offsite_configured == 1 )); then
  offsite_timers_paused=1
  for index in "${!offsite_timer_names[@]}"; do
    timer="${offsite_timer_names[index]}"
    if systemctl is-active --quiet "$timer"; then offsite_timer_was_active[index]=1; fi
    systemctl stop "$timer" >/dev/null
  done
  for service_name in grabenplaner-offsite-prepare.service grabenplaner-offsite-upload.service grabenplaner-offsite-check.service grabenplaner-offsite-restore-test.service; do
    deadline=$((SECONDS + 14400))
    while systemctl is-active --quiet "$service_name"; do (( SECONDS < deadline )) || gp_die "Ein Offsite-Vorgang wurde nicht rechtzeitig beendet."; sleep 2; done
  done
fi

gp_info "Binde den exakt geprueften Runtime-v2-Wartungsbaum ein."
write_phase "runtime-swap-intent"
runtime_swapped=1
mv -T -- "$app_dir/server-tools/linux" "$rollback_root/linux-schema1"
write_phase "runtime-schema1-saved"
cp --archive -- "$extract_root/server-tools/linux" "$work_root/linux-schema2"
gp_apply_app_permissions "$work_root/linux-schema2" "$GP_DEFAULT_SERVICE_GROUP"
mv -T -- "$work_root/linux-schema2" "$app_dir/server-tools/linux"

cp --archive -- "$BOOTSTRAP_COMMAND" "$rollback_root/bootstrap-command"
write_phase "runtime-bind-intent"
runtime_bound=1
if ! getent group "$MONITOR_STATUS_GROUP" >/dev/null; then
  groupadd --system "$MONITOR_STATUS_GROUP"
  monitor_group_created=1
fi
if ! id -nG "$GP_DEFAULT_SERVICE_USER" | tr ' ' '\n' | grep -Fxq "$MONITOR_STATUS_GROUP"; then
  usermod --append --groups "$MONITOR_STATUS_GROUP" "$GP_DEFAULT_SERVICE_USER"
  monitor_membership_added=1
fi
status_gid="$(getent group "$MONITOR_STATUS_GROUP" | awk -F: '{print $3}')"
[[ "$status_gid" =~ ^[0-9]+$ ]] || gp_die "Die Monitor-Statusgruppe ist nicht aufloesbar."
if [[ ! -e "$MONITOR_STATUS_ROOT" && ! -L "$MONITOR_STATUS_ROOT" ]]; then monitor_status_root_created=1; fi
install -d -m 0750 -o root -g "$MONITOR_STATUS_GROUP" -- "$MONITOR_STATUS_ROOT"

public_host="$("$node" -e 'const u=new URL(process.argv[1]);process.stdout.write(u.hostname)' "$public_url")"
clam="$(readlink -f -- "$(command -v clamscan)")"
render_runtime_template() {
  local source="$1" target="$2" content
  content="$(<"$source")"
  content="${content//\{\{PUBLIC_URL\}\}/$public_url}"
  content="${content//\{\{PUBLIC_HOST\}\}/$public_host}"
  content="${content//\{\{UPSTREAM\}\}/127.0.0.1:$port}"
  content="${content//\{\{PORT\}\}/$port}"
  content="${content//\{\{NODE_EXECUTABLE\}\}/$node}"
  content="${content//\{\{CLAMSCAN_EXECUTABLE\}\}/$clam}"
  content="${content//\{\{CADDY_LOG_PATH\}\}/\/var\/log\/grabenplaner\/caddy\/access.log}"
  printf '%s\n' "$content" >"$target"
  ! grep -Eq '\{\{[A-Z0-9_]+\}\}' "$target" || gp_die "Nicht ersetzter Runtime-Platzhalter."
}
rendered="$work_root/rendered"
mkdir -m 0700 -- "$rendered"
render_runtime_template "$app_dir/server-tools/linux/grabenplaner-bootstrap-admin.sh.in" "$rendered/bootstrap"
render_runtime_template "$app_dir/server-tools/linux/grabenplaner-monitor.service.in" "$rendered/monitor.service"
render_runtime_template "$app_dir/server-tools/linux/grabenplaner-monitor.timer.in" "$rendered/monitor.timer"
install -m 0750 -o root -g root -- "$rendered/bootstrap" "$BOOTSTRAP_COMMAND"
install -m 0644 -o root -g root -- "$rendered/monitor.service" "$MONITOR_UNIT"
install -m 0644 -o root -g root -- "$rendered/monitor.timer" "$MONITOR_TIMER"
ln -s -- "$app_dir/server-tools/linux/monitor/run-grabenplaner-monitor.sh" "$MONITOR_COMMAND"
"$node" "$app_dir/server-tools/linux/monitor/lib/monitor-status.js" --status-file "$MONITOR_STATUS_FILE" --status-gid "$status_gid" initialize >/dev/null
if (( offsite_configured == 1 )); then
  mkdir -m 0700 -- "$rollback_root/offsite-units"
  for unit in grabenplaner-offsite-prepare.service grabenplaner-offsite-upload.service grabenplaner-offsite-upload.timer \
    grabenplaner-offsite-check.service grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.service grabenplaner-offsite-restore-test.timer; do
    unit_target="/etc/systemd/system/$unit"
    if [[ -e "$unit_target" || -L "$unit_target" ]]; then
      [[ -f "$unit_target" && ! -L "$unit_target" ]] || gp_die "Eine vorhandene Offsite-Unit ist unzulaessig: $unit"
      cp --archive -- "$unit_target" "$rollback_root/offsite-units/$unit"
    fi
  done
  cp --archive -- "$OFFSITE_RECEIPT" "$rollback_root/offsite-installed-contract.json"
  write_phase "offsite-swap-intent"
  offsite_swapped=1
  mv -T -- "$OFFSITE_MODULE_ROOT" "$rollback_root/offsite-module"
  write_phase "offsite-schema1-saved"
  cp --archive -- "$app_dir/server-tools/linux/offsite" "$work_root/offsite-module-v2"
  chown -R root:root -- "$work_root/offsite-module-v2"
  find "$work_root/offsite-module-v2" -type d -exec chmod 0755 -- {} +
  find "$work_root/offsite-module-v2" -type f -name '*.sh' -exec chmod 0755 -- {} +
  find "$work_root/offsite-module-v2" -type f ! -name '*.sh' -exec chmod 0644 -- {} +
  mv -T -- "$work_root/offsite-module-v2" "$OFFSITE_MODULE_ROOT"
  receipt_temp="$work_root/offsite-installed-contract.v2.json"
  "$node" "$OFFSITE_MODULE_ROOT/lib/offsite-contract.js" contract "$OFFSITE_MODULE_ROOT" >"$receipt_temp"
  install -m 0600 -o root -g root -- "$receipt_temp" "$OFFSITE_RECEIPT"
  for template in "$OFFSITE_MODULE_ROOT"/systemd/*.in; do
    install -m 0644 -o root -g root -- "$template" "/etc/systemd/system/$(basename -- "$template" .in)"
  done
  write_phase "recovery-link-intent"
  recovery_link_created=1
  ln -s -- "$app_dir/server-tools/linux/recovery/grabenplaner-recovery.sh" /usr/local/sbin/grabenplaner-recovery
  "$node" "$OFFSITE_MODULE_ROOT/lib/offsite-contract.js" verify-installed "$OFFSITE_MODULE_ROOT" "$OFFSITE_RECEIPT" >/dev/null \
    || gp_die "Das neu gebundene Offsite-Modul ist ungueltig."
fi

systemctl daemon-reload
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$MONITOR_UNIT" "$MONITOR_TIMER" >/dev/null
fi
systemctl enable --now grabenplaner-monitor.timer >/dev/null
systemctl is-enabled --quiet grabenplaner-monitor.timer || gp_die "Der Monitor-Timer konnte nicht aktiviert werden."
systemctl is-active --quiet grabenplaner-monitor.timer || gp_die "Der Monitor-Timer konnte nicht gestartet werden."

# Der Kandidaten-Updater arbeitet unter derselben geerbten FD-9-Sperre. Er
# erstellt/verifiziert das lokale Backup, erzwingt bei aktivem Offsite eine
# externe Kopie, tauscht App+Abhaengigkeiten und prueft Live/Ready. Bei Fehlern
# rollt er App und ggf. bereits migrierte Daten selbst zurueck.
updater_output="$work_root/updater-result.json"
update_args=(
  --package "$staged_package" --sha256 "$actual_package_sha256" --env-file "$ENV_FILE"
  --app-dir "$app_dir" --data-dir "$data_dir" --database "$database" --backup-dir "$backup_dir"
  --public-url "$public_url" --node "$node" --service "$APP_SERVICE" --caddy-service "$CADDY_SERVICE"
  --health-timeout "$health_timeout" --lock-already-held --commit-marker "$updater_commit_marker"
)
if [[ -n "$pnpm_arg" ]]; then update_args+=(--pnpm "$pnpm_arg"); fi
write_phase "updater-invoked"
updater_invoked=1
set +e
bash "$extract_root/server-tools/linux/update-grabenplaner-server.sh" "${update_args[@]}" >"$updater_output"
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
  # Der innere Updater hat App, Datenbackup und Live/Ready bereits verbindlich
  # committed und seinen vorherigen App-Baum entfernt. Ab hier waere ein
  # Schema-1-Teilrollback gefaehrlicher als der konsistente Schema-2-Stand.
  # Deshalb bleibt die vollstaendige root-only Arbeitskopie zur Diagnose
  # erhalten und es wird ausdruecklich kein Bootstrap geoeffnet.
  printf '%s\n' "$message" >"$work_root/POST-UPDATE-ACTION-REQUIRED"
  chmod 0600 -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
  chown root:root -- "$work_root/POST-UPDATE-ACTION-REQUIRED"
  gp_log ERROR "$message Die App wurde bereits erfolgreich auf Runtime v2 aktualisiert; kein unsicherer Schema-1-Teilrollback wird versucht. Diagnose: $work_root"
  exit 2
}

env_sha256_after="$(gp_sha256 "$ENV_FILE")" || post_update_fail "Die Server-Umgebungsdatei konnte nach dem App-Commit nicht geprueft werden."
[[ "$env_sha256_after" == "$env_sha256_before" ]] || post_update_fail "Die geschuetzte Server-Umgebungsdatei wurde unerwartet veraendert."
if (( offsite_configured == 1 )); then
  offsite_secrets_after="$(offsite_secret_digest)" || post_update_fail "Die Offsite-Geheimnisse sind nach der Migration unvollstaendig."
  [[ "$offsite_secrets_after" == "$offsite_secrets_before" ]] || post_update_fail "Ein Offsite-Geheimnis wurde waehrend der Migration veraendert."
fi
installed_v2="$work_root/installed-runtime-v2.json"
"$node" "$app_dir/server-tools/linux/lib/verify-package.js" --runtime-contract "$app_dir" >"$installed_v2" \
  || post_update_fail "Der installierte Runtime-v2-Vertrag ist nach dem App-Commit nicht lesbar."
"$node" - "$installed_v2" "$candidate_runtime_fingerprint" "$app_dir/package.json" "$candidate_version" <<'NODE' >/dev/null \
  || post_update_fail "Die installierte App ist nicht exakt an den freigegebenen Runtime-v2-Vertrag gebunden."
const fs=require("node:fs");const [runtimeFile,fingerprint,packageFile,version]=process.argv.slice(2);
const runtime=JSON.parse(fs.readFileSync(runtimeFile,"utf8"));const pkg=JSON.parse(fs.readFileSync(packageFile,"utf8"));
if(runtime.deploymentSchemaVersion!==2||runtime.fingerprint!==fingerprint||pkg.version!==version)process.exit(1);
NODE
gp_wait_ready "$internal_live_url" "$health_timeout" || post_update_fail "Die migrierte App beantwortet den internen Livenesscheck nicht."
gp_wait_ready "$internal_ready_url" "$health_timeout" || post_update_fail "Die migrierte App ist intern nicht bereit."
gp_wait_ready "$public_live_url" "$health_timeout" || post_update_fail "Die migrierte App ist oeffentlich nicht erreichbar."
gp_wait_ready "$public_ready_url" "$health_timeout" || post_update_fail "Die migrierte App ist oeffentlich nicht bereit."
if systemctl is-active --quiet "$BOOTSTRAP_SERVICE"; then post_update_fail "Der einmalige Bootstrap wurde unerwartet aktiviert."; fi
[[ -z "$(awk -F= '$1=="GRABENPLANER_BOOTSTRAP_TOKEN"{print substr($0,index($0,"=")+1);exit}' "$ENV_FILE")" ]] \
  || post_update_fail "Der verbrauchte Bootstrap-Schluessel wurde unerwartet wiederhergestellt."

if (( offsite_configured == 1 )); then
  for index in "${!offsite_timer_names[@]}"; do
    if (( offsite_timer_was_active[index] == 1 )); then
      systemctl start "${offsite_timer_names[index]}" >/dev/null \
        || post_update_fail "Ein zuvor aktiver Offsite-Timer konnte nach dem App-Commit nicht erneut gestartet werden."
    fi
  done
  offsite_timers_paused=0
fi

history_dir="$data_dir/maintenance/history"
install -d -m 0750 -o root -g "$GP_DEFAULT_SERVICE_GROUP" -- "$history_dir" \
  || post_update_fail "Der Migrationsverlauf konnte nach dem App-Commit nicht vorbereitet werden."
receipt="$history_dir/runtime-v2-$(date --utc '+%Y-%m-%dT%H-%M-%S-%3N').json"
if ! "$node" - "$receipt" "$old_version" "$candidate_version" "$actual_package_sha256" "$env_sha256_before" "$offsite_configured" "$updater_output" <<'NODE'
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const [file,fromVersion,toVersion,packageSha256,environmentSha256,offsiteConfigured,updateFile]=process.argv.slice(2);
const update=JSON.parse(fs.readFileSync(updateFile,"utf8"));
const backup=String(update.backup||"");
const marker=backup.endsWith(".db")?`${backup.slice(0,-3)}.complete.json`:"";
const commit=JSON.parse(fs.readFileSync(marker,"utf8"));
if(commit?.verification?.status!=="verified"||!(/^[a-f0-9]{64}$/.test(String(commit?.database?.sha256||""))))throw new Error("Backupbeleg fehlt");
const payload={format:"grabenplaner-runtime-migration",schemaVersion:1,status:"success",completedAt:new Date().toISOString(),deploymentSchema:{from:1,to:2},fromVersion,toVersion,packageSha256,environmentSha256,offsitePreserved:offsiteConfigured==="1",bootstrapReopened:false,backup:{fileName:path.basename(backup),sha256:commit.database.sha256,commitFileName:path.basename(marker)},updateReceipt:update.receipt?path.basename(update.receipt):null};
fs.writeFileSync(file,`${JSON.stringify(payload,null,2)}\n`,{mode:0o640});
NODE
then
  post_update_fail "Der gepruefte Migrationsbeleg konnte nach dem App-Commit nicht erzeugt werden."
fi
chown "root:$GP_DEFAULT_SERVICE_GROUP" -- "$receipt" || post_update_fail "Der Migrationsbeleg konnte nicht sicher zugeordnet werden."
chmod 0640 -- "$receipt" || post_update_fail "Der Migrationsbeleg konnte nicht sicher geschuetzt werden."

migration_complete=1
rm -rf --one-file-system -- "$rollback_root" || gp_warn "Der nicht mehr benoetigte Runtime-v1-Rollbackordner konnte nicht entfernt werden."
printf '%s\n' "{\"ok\":true,\"fromSchema\":1,\"toSchema\":2,\"fromVersion\":\"$old_version\",\"toVersion\":\"$candidate_version\",\"receipt\":\"$receipt\"}"
gp_info "Runtime-Schema 1 wurde kontrolliert auf Schema 2 migriert; der Admin-Bootstrap blieb geschlossen."

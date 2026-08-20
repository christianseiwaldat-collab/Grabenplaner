#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Eng begrenzter Recovery-Weg fuer den Sonderfall, dass die Schema-2->3-
# Migration App und Runtime bereits erfolgreich committed hat, aber ihr
# aeusserer Beleg wegen einer verrauschten Updater-Ausgabe noch fehlt.
# Das Werkzeug veraendert weder App, Env, systemd noch Offsite-Bindungen.

readonly FINALIZER_VERSION="0.88.4-beta"
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
readonly HOST_CONTROL_MODULE="/opt/grabenplaner-host-control/module"
readonly HOST_CONTROL_SOCKET_NAME="grabenplaner-host-control.socket"
readonly HOST_REBOOT_NAME="grabenplaner-host-reboot.service"
readonly HOST_CONTROL_SOCKET="/run/grabenplaner-host-control/request.sock"
readonly OFFSITE_MODULE_ROOT="/opt/grabenplaner-offsite/module"
readonly OFFSITE_INSTALLED_CONTRACT="/etc/grabenplaner/offsite/installed-contract.json"
readonly MAX_EXPANDED_BYTES=4294967296

package_arg=""
sha256_arg=""
sha256_file_arg=""
diagnostic_arg=""
from_version=""
to_version=""
original_package_sha256=""
node_arg=""
health_timeout=1500

usage() {
  cat <<'EOF'
Verwendung:
  sudo ./finalize-grabenplaner-runtime-v3.sh \
    --package /pfad/Grabenplaner-Server-v0.88.4-beta-linux-x64.zip \
    [--sha256 HEX | --sha256-file /pfad/paket.zip.sha256] \
    --diagnostic-dir /opt/grabenplaner/.runtime-v3-migration.XXXXXXXX \
    --from-version 0.87.0-beta \
    --to-version 0.88.3-beta \
    --original-package-sha256 HEX

Das Werkzeug finalisiert ausschliesslich einen bereits committed, gesunden
Schema-3-Stand. Es startet weder Migration, Update, Dienst, Reboot noch
Offsite-Neubindung und behaelt den Diagnose- und Rollbackordner bei.
EOF
}

while (($#)); do
  case "$1" in
    --package) package_arg="${2:?Wert fuer --package fehlt}"; shift 2 ;;
    --sha256) sha256_arg="${2:?Wert fuer --sha256 fehlt}"; shift 2 ;;
    --sha256-file) sha256_file_arg="${2:?Wert fuer --sha256-file fehlt}"; shift 2 ;;
    --diagnostic-dir) diagnostic_arg="${2:?Wert fuer --diagnostic-dir fehlt}"; shift 2 ;;
    --from-version) from_version="${2:?Wert fuer --from-version fehlt}"; shift 2 ;;
    --to-version) to_version="${2:?Wert fuer --to-version fehlt}"; shift 2 ;;
    --original-package-sha256) original_package_sha256="${2:?Wert fuer --original-package-sha256 fehlt}"; shift 2 ;;
    --node) node_arg="${2:?Wert fuer --node fehlt}"; shift 2 ;;
    --health-timeout) health_timeout="${2:?Wert fuer --health-timeout fehlt}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

gp_require_root
for command_name in awk bash basename chown chmod clamscan cmp curl date dirname du find flock getent grep id install mkdir mktemp readlink realpath rm sha256sum stat systemctl tr uname unzip; do
  gp_require_command "$command_name"
done
[[ -n "$package_arg" && -n "$diagnostic_arg" && -n "$from_version" && -n "$to_version" \
  && -n "$original_package_sha256" ]] || gp_die "Paket, Diagnoseordner, Versionen und Original-Paket-SHA sind erforderlich."
[[ -z "$sha256_arg" || -z "$sha256_file_arg" ]] \
  || gp_die "--sha256 und --sha256-file duerfen nicht gemeinsam verwendet werden."
gp_validate_sha256 "$original_package_sha256"
original_package_sha256="${original_package_sha256,,}"
[[ "$from_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.-]+$ \
  && "$to_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.-]+$ ]] \
  || gp_die "Die erwarteten Versionen sind ungueltig."
[[ "$health_timeout" =~ ^[0-9]+$ ]] && (( health_timeout >= 30 && health_timeout <= 1500 )) \
  || gp_die "--health-timeout muss zwischen 30 und 1500 liegen."

os_release_source="$(realpath --canonicalize-existing -- /etc/os-release)" \
  || gp_die "Ubuntu konnte nicht sicher erkannt werden."
case "$os_release_source" in /etc/os-release|/usr/lib/os-release) ;; *) gp_die "Unerwartete Betriebssystemkennung." ;; esac
[[ -f "$os_release_source" && ! -L "$os_release_source" \
  && "$(stat --format='%u:%g:%h' -- "$os_release_source")" == "0:0:1" ]] \
  || gp_die "Die Betriebssystemkennung ist unsicher."
os_release_mode="$(stat --format='%a' -- "$os_release_source")"
(( (8#$os_release_mode & 022) == 0 )) || gp_die "Die Betriebssystemkennung ist schreibbar."
# shellcheck disable=SC1091
source "$os_release_source"
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" =~ ^(24\.04|26\.04)$ && "$(uname -m)" == "x86_64" ]] \
  || gp_die "Der Runtime-v3-Finalizer unterstuetzt Ubuntu 24.04/26.04 auf x86_64."

if [[ -n "$node_arg" ]]; then
  node="$(gp_existing_file "$node_arg" "Node.js")"
else
  gp_require_command node
  node="$(readlink -f -- "$(command -v node)")"
fi
"$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13)||process.arch!=="x64")process.exit(1)' \
  || gp_die "Node.js >=22.13.0 fuer Linux x64 wird benoetigt."

package="$(gp_existing_file "$package_arg" "Finalizer-Paket")"
[[ "$package" == *.zip ]] || gp_die "Der Finalizer erwartet das offizielle Linux-Server-ZIP."
if [[ -n "$sha256_file_arg" ]]; then
  sha256_file="$(gp_existing_file "$sha256_file_arg" "SHA256-Datei")"
  sha256_arg="$(awk 'NR==1 {print $1; exit}' "$sha256_file")"
elif [[ -z "$sha256_arg" ]]; then
  sha256_file="$(gp_existing_file "$package.sha256" "SHA256-Datei")"
  sha256_arg="$(awk 'NR==1 {print $1; exit}' "$sha256_file")"
fi
gp_validate_sha256 "$sha256_arg"
sha256_arg="${sha256_arg,,}"
[[ "$(gp_sha256 "$package")" == "$sha256_arg" ]] || gp_die "Die Finalizer-Paket-SHA stimmt nicht."

app_dir="$(gp_existing_directory "$APP_DIR" "Bestehende App")"
gp_load_env_file "$ENV_FILE"
data_dir="$(gp_existing_directory "${GRABENPLANER_DATA_DIR:-$DATA_DIR}" "Datenordner")"
backup_dir="$(gp_safe_absolute_path "${BACKUP_DIR:-$GP_DEFAULT_BACKUP_DIR}" "Backupordner")"
public_url="${GRABENPLANER_PUBLIC_URL:-}"
port="${PORT:-3000}"
gp_validate_https_url "$node" "$public_url" || gp_die "Die bestehende HTTPS-Adresse ist ungueltig."
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || gp_die "Der bestehende Port ist ungueltig."
[[ "${GRABENPLANER_OPERATION_MODE:-}" == "server" && "${GRABENPLANER_DEPLOYMENT_KIND:-}" == "production" ]] \
  || gp_die "Der Finalizer ist nur fuer die produktive Serverinstallation freigegeben."
[[ -z "${GRABENPLANER_BOOTSTRAP_TOKEN:-}" ]] || gp_die "Der Admin-Bootstrap ist nicht geschlossen."
service_user_uid="$(id -u "$GP_DEFAULT_SERVICE_USER")"
service_group_gid="$(getent group "$GP_DEFAULT_SERVICE_GROUP" | awk -F: 'NR==1 {print $3}')"
[[ "$service_user_uid" =~ ^[0-9]+$ && "$service_group_gid" =~ ^[0-9]+$ ]] \
  || gp_die "Dienstbenutzer oder Dienstgruppe sind nicht aufloesbar."
[[ -d "$backup_dir" && ! -L "$backup_dir" \
  && "$(stat --format='%u:%g:%a' -- "$backup_dir")" == "${service_user_uid}:${service_group_gid}:750" ]] \
  || gp_die "Der konfigurierte Backupordner besitzt nicht den erwarteten Schutz."

diagnostic_dir="$(realpath --canonicalize-existing -- "$diagnostic_arg")" \
  || gp_die "Der Diagnoseordner fehlt."
[[ "$diagnostic_dir" == /opt/grabenplaner/.runtime-v3-migration.* \
  && "$(dirname -- "$diagnostic_dir")" == "/opt/grabenplaner" \
  && "$(basename -- "$diagnostic_dir")" =~ ^\.runtime-v3-migration\.[A-Za-z0-9]{8}$ \
  && -d "$diagnostic_dir" && ! -L "$diagnostic_dir" \
  && "$(stat --format='%u:%g:%a' -- "$diagnostic_dir")" == "0:0:711" ]] \
  || gp_die "Der Diagnoseordner ist nicht der erwartete root-geschuetzte Runtime-v3-Pfad."

work_root="$(mktemp --directory --tmpdir="/opt/grabenplaner" .runtime-v3-finalizer.XXXXXXXX)"
chown root:root -- "$work_root"
chmod 0700 -- "$work_root"
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -d "$work_root" && ! -L "$work_root" && "$work_root" == /opt/grabenplaner/.runtime-v3-finalizer.* ]]; then
    rm -rf --one-file-system -- "$work_root"
  fi
  exit "$code"
}
trap cleanup EXIT

candidate_root="$work_root/candidate"
mkdir -m 0700 -- "$candidate_root"
zip_summary="$(unzip -Z -t "$package")" || gp_die "Das ZIP-Zentralverzeichnis ist unlesbar."
entry_count="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ {print $1; exit}')"
expanded_bytes="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ {print $3; exit}')"
[[ "$entry_count" =~ ^[0-9]+$ && "$expanded_bytes" =~ ^[0-9]+$ ]] \
  || gp_die "Die ZIP-Groessenangaben sind ungueltig."
(( entry_count > 0 && entry_count <= 100000 && expanded_bytes <= MAX_EXPANDED_BYTES )) \
  || gp_die "Das Finalizer-Paket ist leer oder zu gross."
zip_listing="$(unzip -Z -l "$package")" || gp_die "Die ZIP-Dateitypen sind unlesbar."
parsed_modes=0
while IFS= read -r mode; do
  ((parsed_modes += 1))
  case "${mode:0:1}" in -|d) ;; *) gp_die "Links und Spezialdateien sind im Finalizer-Paket nicht erlaubt." ;; esac
done < <(printf '%s\n' "$zip_listing" | awk '$1 ~ /^[-dlbcps]/ && $2 ~ /^[0-9]/ {print $1}')
(( parsed_modes == entry_count )) || gp_die "Nicht alle ZIP-Dateitypen konnten sicher bestimmt werden."
unzip -tq "$package" >/dev/null || gp_die "Das Finalizer-Paket ist beschaedigt."
declare -A archive_entries=()
while IFS= read -r entry; do
  normalized="${entry#./}"; normalized="${normalized%/}"
  [[ -n "$normalized" ]] || continue
  [[ ! "$entry" =~ [[:cntrl:]] && "$normalized" != /* && "$normalized" != *\\* \
    && -z "${archive_entries[$normalized]+x}" ]] || gp_die "Ungueltiger oder doppelter ZIP-Pfad."
  archive_entries["$normalized"]=1
  IFS=/ read -ra segments <<<"$normalized"
  for segment in "${segments[@]}"; do
    [[ -n "$segment" && "$segment" != . && "$segment" != .. ]] || gp_die "Nicht kanonischer ZIP-Pfad."
  done
done < <(unzip -Z1 "$package")
unzip -qq "$package" -d "$candidate_root"
[[ -z "$(find "$candidate_root" ! -type f ! -type d -print -quit)" \
  && $(du --bytes --summarize "$candidate_root" | awk '{print $1}') -le $MAX_EXPANDED_BYTES ]] \
  || gp_die "Der entpackte Finalizer-Kandidat ist unzulaessig."

candidate_verifier="$candidate_root/server-tools/linux/lib/verify-package.js"
candidate_common="$candidate_root/server-tools/linux/lib/common.sh"
candidate_contract_helper="$candidate_root/server-tools/linux/lib/extract-updater-contract.js"
candidate_backup_verifier="$candidate_root/server-tools/linux/lib/verify-backup.js"
candidate_finalizer="$candidate_root/server-tools/linux/finalize-grabenplaner-runtime-v3.sh"
for required_file in "$candidate_verifier" "$candidate_common" "$candidate_contract_helper" \
  "$candidate_backup_verifier" "$candidate_finalizer"; do
  [[ -f "$required_file" && ! -L "$required_file" ]] || gp_die "Eine Finalizer-Pflichtdatei fehlt."
done
"$node" "$candidate_verifier" "$candidate_root" >"$work_root/candidate-manifest.json" \
  || gp_die "Manifest- und Einzeldateipruefung des Finalizer-Pakets fehlgeschlagen."
cmp --silent -- "$SCRIPT_PATH" "$candidate_finalizer" \
  || gp_die "Der gestartete Finalizer stammt nicht bytegleich aus dem geprueften Paket."
cmp --silent -- "$SCRIPT_DIR/lib/common.sh" "$candidate_common" \
  || gp_die "Die geladene Sicherheitsbasis stammt nicht bytegleich aus dem geprueften Paket."
clamscan --recursive --infected --no-summary -- "$candidate_root" >/dev/null \
  || gp_die "ClamAV hat das Finalizer-Paket abgelehnt."

gp_acquire_maintenance_lock
for unit in "$APP_SERVICE" "$BOOTSTRAP_SERVICE" "$CADDY_SERVICE" "$HOST_CONTROL_SOCKET_NAME" "$HOST_REBOOT_NAME"; do
  gp_require_systemd_unit "$unit"
done
systemctl is-active --quiet "$APP_SERVICE" || gp_die "Die App ist nicht aktiv."
systemctl is-active --quiet "$CADDY_SERVICE" || gp_die "Caddy ist nicht aktiv."
systemctl is-active --quiet "$BOOTSTRAP_SERVICE" && gp_die "Der Bootstrap ist aktiv."
systemctl is-active --quiet "$HOST_REBOOT_NAME" && gp_die "Ein Host-Neustart ist aktiv."
systemctl is-active --quiet "$HOST_CONTROL_SOCKET_NAME" || gp_die "Der Host-Control-Socket ist nicht aktiv."
systemctl is-enabled --quiet "$HOST_CONTROL_SOCKET_NAME" || gp_die "Der Host-Control-Socket ist nicht aktiviert."
[[ -S "$HOST_CONTROL_SOCKET" \
  && "$(stat --format='%U:%G:%a' -- "$HOST_CONTROL_SOCKET")" == "root:${HOST_CONTROL_GROUP}:660" ]] \
  || gp_die "Der Host-Control-Socket besitzt nicht den freigegebenen Schutz."
[[ "$(getent group "$HOST_CONTROL_GROUP" | awk -F: 'NR==1 {print $4}')" == "$GP_DEFAULT_SERVICE_USER" ]] \
  || gp_die "Die Host-Control-Gruppe besitzt nicht den freigegebenen Einzelzugriff."

assert_root_file() {
  local file="$1" private="${2:-0}" mode size
  [[ -f "$file" && ! -L "$file" ]] || return 1
  mode="$(stat --format='%a' -- "$file")"
  size="$(stat --format='%s' -- "$file")"
  [[ "$(stat --format='%u:%h' -- "$file")" == "0:1" ]] || return 1
  [[ "$size" =~ ^[0-9]+$ ]] && (( size > 0 && size <= MAX_EXPANDED_BYTES )) || return 1
  if [[ "$private" == "1" ]]; then
    (( (8#$mode & 077) == 0 )) || return 1
  else
    (( (8#$mode & 022) == 0 )) || return 1
  fi
}

phase_file="$diagnostic_dir/phase"
action_file="$diagnostic_dir/POST-UPDATE-ACTION-REQUIRED"
transcript_source="$diagnostic_dir/updater-result.json"
commit_marker="$diagnostic_dir/updater-commit.json"
runtime_checkpoint="$diagnostic_dir/installed-runtime-v3.json"
manifest_checkpoint="$diagnostic_dir/manifest.json"
original_package="$diagnostic_dir/package.zip"
assert_root_file "$phase_file" 1 \
  && assert_root_file "$action_file" 1 \
  && assert_root_file "$transcript_source" 0 \
  && assert_root_file "$commit_marker" 1 \
  && assert_root_file "$runtime_checkpoint" 0 \
  && assert_root_file "$manifest_checkpoint" 0 \
  && assert_root_file "$original_package" 0 \
  || gp_die "Ein retained Post-Commit-Nachweis ist unsicher."
[[ "$(tr -d '\r\n' <"$phase_file")" == "updater-committed" ]] \
  || gp_die "Der Diagnoseordner steht nicht in der committed Abschlussphase."
[[ "$(tr -d '\r\n' <"$action_file")" == "Die App ist bereits committed; kein unsicherer Runtime-Teilrollback. Manuelle Pruefung erforderlich." ]] \
  || gp_die "Der retained Fehler ist nicht der eng freigegebene Post-Commit-Sonderfall."
commit_marker_mtime="$(stat --format='%Y' -- "$commit_marker")"
transcript_mtime="$(stat --format='%Y' -- "$transcript_source")"
runtime_checkpoint_mtime="$(stat --format='%Y' -- "$runtime_checkpoint")"
action_mtime="$(stat --format='%Y' -- "$action_file")"
(( commit_marker_mtime <= transcript_mtime \
  && transcript_mtime <= runtime_checkpoint_mtime \
  && runtime_checkpoint_mtime <= action_mtime )) \
  || gp_die "Die retained Post-Commit-Nachweise besitzen keine plausible Abschlussreihenfolge."
[[ ! -e "$diagnostic_dir/FINALIZED.json" && ! -L "$diagnostic_dir/FINALIZED.json" ]] \
  || gp_die "Der Diagnoseordner wurde bereits finalisiert; ein zweiter Lauf wird nicht blind ausgefuehrt."
[[ "$(gp_sha256 "$original_package")" == "$original_package_sha256" ]] \
  || gp_die "Das retained Originalpaket stimmt nicht mit der freigegebenen SHA ueberein."

transcript_copy="$work_root/updater-result.json"
transcript_sha256="$(gp_sha256 "$transcript_source")"
install -m 0600 -o root -g root -- "$transcript_source" "$transcript_copy"
[[ "$(gp_sha256 "$transcript_source")" == "$transcript_sha256" \
  && "$(gp_sha256 "$transcript_copy")" == "$transcript_sha256" ]] \
  || gp_die "Das Updater-Transcript wurde waehrend der Uebernahme veraendert."

public_ready_url="${public_url%/}/api/health/ready"
history_dir="$data_dir/maintenance/history"
[[ -d "$history_dir" && ! -L "$history_dir" \
  && "$(stat --format='%u:%g:%a' -- "$history_dir")" == "0:${service_group_gid}:750" ]] \
  || gp_die "Der Wartungsverlauf besitzt nicht den erwarteten Schutz."
canonical_contract="$work_root/updater-contract.json"
"$node" "$candidate_contract_helper" \
  "$transcript_copy" "$canonical_contract" "$commit_marker" \
  "$from_version" "$to_version" "$original_package_sha256" "$public_ready_url" \
  "$backup_dir" "$history_dir" \
  || gp_die "Der retained Updater-Vertrag ist nicht vollstaendig an Commit und Updatebeleg gebunden."

backup_database="$("$node" -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backup||""))' "$canonical_contract")"
backup_base="${backup_database%.db}"
[[ "$backup_database" == "$backup_base.db" ]] || gp_die "Der retained Backup-Pfad ist ungueltig."
backup_amu="$backup_base.amu"
backup_marker="$backup_base.complete.json"
cmp --silent -- "$candidate_root/lib/amu-storage.js" "$app_dir/lib/amu-storage.js" \
  || gp_die "Das installierte Dokumentpruefmodul weicht vom geprueften Finalizer-Paket ab."
"$node" "$candidate_backup_verifier" \
  "$backup_database" "$backup_amu" "$app_dir/lib/amu-storage.js" "$backup_marker" \
  >"$work_root/backup-verification.json" \
  || gp_die "Der Update-Sicherungspunkt ist nicht mehr vollstaendig verifizierbar."

current_version="$("$node" -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version||""))' "$app_dir/package.json")"
[[ "$current_version" == "$to_version" ]] || gp_die "Die installierte App entspricht nicht mehr der zu finalisierenden Zielversion."
"$node" "$candidate_verifier" --runtime-contract "$app_dir" >"$work_root/current-runtime.json" \
  || gp_die "Der installierte Runtimevertrag ist nicht reproduzierbar."
"$node" - "$runtime_checkpoint" "$manifest_checkpoint" "$work_root/current-runtime.json" \
  "$work_root/candidate-manifest.json" "$to_version" <<'NODE' >/dev/null \
  || gp_die "Retained Checkpoint, installierte Runtime und Paketvertrag stimmen nicht ueberein."
const fs=require("node:fs");
const [checkpointFile,manifestFile,currentFile,candidateFile,toVersion]=process.argv.slice(2);
const checkpoint=JSON.parse(fs.readFileSync(checkpointFile,"utf8"));
const manifest=JSON.parse(fs.readFileSync(manifestFile,"utf8"));
const current=JSON.parse(fs.readFileSync(currentFile,"utf8"));
const candidate=JSON.parse(fs.readFileSync(candidateFile,"utf8"));
const fingerprint=String(current?.fingerprint||"");
if(current?.deploymentSchemaVersion!==3||checkpoint?.deploymentSchemaVersion!==3
  ||manifest?.runtimeContract?.deploymentSchemaVersion!==3
  ||candidate?.runtimeContract?.deploymentSchemaVersion!==3
  ||![checkpoint?.fingerprint,manifest?.runtimeContract?.fingerprint,candidate?.runtimeContract?.fingerprint]
    .every((value)=>value===fingerprint)
  ||manifest?.appVersion!==toVersion
  ||checkpoint?.offsiteModule?.fingerprint!==current?.offsiteModule?.fingerprint
  ||checkpoint?.hardeningModule?.fingerprint!==current?.hardeningModule?.fingerprint)process.exit(1);
NODE

env_mode="$(stat --format='%u:%g:%a:%h' -- "$ENV_FILE")"
[[ "$env_mode" == "0:0:600:1" ]] || gp_die "Die Server-Env besitzt nicht den erwarteten root-only Schutz."
checkpoint_mtime="$(stat --format='%Y' -- "$runtime_checkpoint")"
env_mtime="$(stat --format='%Y' -- "$ENV_FILE")"
env_ctime="$(stat --format='%Z' -- "$ENV_FILE")"
(( env_mtime <= checkpoint_mtime && env_ctime <= checkpoint_mtime )) \
  || gp_die "Die Server-Env wurde nach dem retained Vorher-/Nachher-Checkpoint veraendert."
environment_sha256="$(gp_sha256 "$ENV_FILE")"

[[ -f "$HOST_CONTROL_MODULE/lib/host-reboot-broker.js" \
  && ! -L "$HOST_CONTROL_MODULE/lib/host-reboot-broker.js" \
  && "$(stat --format='%u:%g:%a:%h' -- "$HOST_CONTROL_MODULE/lib/host-reboot-broker.js")" == "0:0:644:1" ]] \
  || gp_die "Der root-geschuetzte Host-Control-Broker ist ungueltig."
cmp --silent -- "$HOST_CONTROL_MODULE/lib/host-reboot-broker.js" \
  "$app_dir/server-tools/linux/host-control/lib/host-reboot-broker.js" \
  || gp_die "Der Host-Control-Broker weicht vom Runtimevertrag ab."

resolved_node="$(readlink -f -- "$node")"
rendered_root="$work_root/rendered"
mkdir -m 0700 -- "$rendered_root"
"$node" - "$app_dir" "$rendered_root" "$resolved_node" <<'NODE'
const fs=require("node:fs"),path=require("node:path");
const [appRoot,outputRoot,nodeExecutable]=process.argv.slice(2);
const templates=new Map([
  ["grabenplaner-host-control.socket","grabenplaner-host-control.socket.in"],
  ["grabenplaner-host-control@.service","grabenplaner-host-control@.service.in"],
  ["grabenplaner-host-reboot.service","grabenplaner-host-reboot.service.in"],
]);
for(const [target,source] of templates){
  let content=fs.readFileSync(path.join(appRoot,"server-tools/linux/host-control/systemd",source),"utf8");
  content=content.replaceAll("{{NODE_EXECUTABLE}}",nodeExecutable);
  if(/\{\{[A-Z0-9_]+\}\}/.test(content))process.exit(1);
  fs.writeFileSync(path.join(outputRoot,target),content,{mode:0o600});
}
NODE
for host_unit in grabenplaner-host-control.socket grabenplaner-host-control@.service grabenplaner-host-reboot.service; do
  installed_unit="/etc/systemd/system/$host_unit"
  [[ -f "$installed_unit" && ! -L "$installed_unit" \
    && "$(stat --format='%u:%g:%a:%h' -- "$installed_unit")" == "0:0:644:1" ]] \
    || gp_die "Eine installierte Host-Control-Unit ist unsicher."
  cmp --silent -- "$installed_unit" "$rendered_root/$host_unit" \
    || gp_die "Eine installierte Host-Control-Unit weicht vom Runtimevertrag ab."
done

internal_live_url="http://127.0.0.1:$port/api/health/live"
internal_ready_url="http://127.0.0.1:$port/api/health/ready"
public_live_url="${public_url%/}/api/health/live"
gp_wait_ready "$internal_live_url" "$health_timeout" || gp_die "Der interne Livenesscheck ist nicht gruen."
gp_wait_ready "$internal_ready_url" "$health_timeout" || gp_die "Der interne Readinesscheck ist nicht gruen."
gp_wait_ready "$public_live_url" "$health_timeout" || gp_die "Der oeffentliche Livenesscheck ist nicht gruen."
gp_wait_ready "$public_ready_url" "$health_timeout" || gp_die "Der oeffentliche Readinesscheck ist nicht gruen."
systemctl is-active --quiet "$APP_SERVICE" || gp_die "Die App ist nach den Nachweisen nicht aktiv."
systemctl is-active --quiet "$CADDY_SERVICE" || gp_die "Caddy ist nach den Nachweisen nicht aktiv."
systemctl is-active --quiet "$BOOTSTRAP_SERVICE" && gp_die "Der Bootstrap wurde unerwartet aktiviert."
systemctl is-active --quiet "$HOST_REBOOT_NAME" && gp_die "Ein Host-Neustart wurde unerwartet aktiviert."

offsite_preserved=false
if [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == "1" ]]; then
  offsite_preserved=true
  candidate_offsite_contract="$candidate_root/server-tools/linux/offsite/lib/offsite-contract.js"
  "$node" "$candidate_offsite_contract" verify-installed-bound \
    "$OFFSITE_MODULE_ROOT" "$OFFSITE_INSTALLED_CONTRACT" >/dev/null \
    || gp_die "Der installierte Offsite-Modulvertrag ist nicht mehr gueltig."
  installed_provider="$("$node" "$candidate_offsite_contract" provider-id "$OFFSITE_INSTALLED_CONTRACT")" \
    || gp_die "Die installierte Offsite-Provider-Bindung ist nicht lesbar."
  [[ "$installed_provider" == "${GRABENPLANER_OFFSITE_PROVIDER:-}" ]] \
    || gp_die "Der Offsite-Provider weicht vom retained Betriebszustand ab."
  if [[ "$installed_provider" == "google_drive" ]]; then
    "$node" - "$OFFSITE_INSTALLED_CONTRACT" <<'NODE' >/dev/null \
      || gp_die "Die Google-Drive-Bindung besitzt nicht den engen drive.file-Umfang."
const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(value?.providerBinding?.providerId!=="google_drive"
  ||value?.providerBinding?.authentication!=="dedicated_oauth"
  ||value?.providerBinding?.scope!=="drive.file"
  ||value?.providerBinding?.repositoryLayout!=="google-drive-direct-safe-path-v1")process.exit(1);
NODE
  fi
  [[ "$(systemctl show -p Result --value grabenplaner-offsite-assurance@app-updated.service)" == "success" \
    && "$(systemctl show -p ExecMainStatus --value grabenplaner-offsite-assurance@app-updated.service)" == "0" ]] \
    || gp_die "Die Post-Update-Recovery-Assurance ist nicht erfolgreich abgeschlossen."
elif [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" != "0" ]]; then
  gp_die "Der Offsite-Aktivierungszustand ist ungueltig."
fi

timestamp="$(date --utc '+%Y-%m-%dT%H-%M-%S-%3N')"
receipt="$history_dir/runtime-v3-$timestamp.json"
sidecar="$history_dir/runtime-v3-$timestamp.recovery.json"
finalized_marker="$diagnostic_dir/FINALIZED.json"
update_receipt="$("$node" -e 'const fs=require("node:fs"),path=require("node:path");process.stdout.write(path.basename(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).receipt||""))' "$canonical_contract")"

"$node" - "$receipt" "$sidecar" "$finalized_marker" "$service_group_gid" \
  "$from_version" "$to_version" "$original_package_sha256" "$environment_sha256" \
  "$offsite_preserved" "$backup_database" "$backup_marker" "$update_receipt" \
  "$diagnostic_dir" "$transcript_source" "$commit_marker" "$runtime_checkpoint" <<'NODE' \
  || gp_die "Der atomare Runtime-v3-Abschlussbeleg konnte nicht geschrieben werden."
const crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const [receipt,sidecar,marker,gidRaw,fromVersion,toVersion,packageSha256,environmentSha256,
  offsitePreserved,backup,backupMarker,updateReceipt,diagnosticDir,transcript,commit,runtimeCheckpoint]=process.argv.slice(2);
const gid=Number(gidRaw);
const hash=(file)=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const backupCommit=JSON.parse(fs.readFileSync(backupMarker,"utf8"));
if(!Number.isSafeInteger(gid)||gid<1||backupCommit?.verification?.status!=="verified"
  ||!(/^[a-f0-9]{64}$/.test(String(backupCommit?.database?.sha256||""))))process.exit(1);
const completedAt=new Date().toISOString();
const receiptPayload={
  format:"grabenplaner-runtime-migration",schemaVersion:1,status:"success",completedAt,
  deploymentSchema:{from:2,to:3},fromVersion,toVersion,packageSha256,environmentSha256,
  offsitePreserved:offsitePreserved==="true",bootstrapReopened:false,rebootTriggered:false,
  hostControl:{group:"grabenplaner-host-control",socket:"/run/grabenplaner-host-control/request.sock"},
  backup:{fileName:path.basename(backup),sha256:backupCommit.database.sha256,commitFileName:path.basename(backupMarker)},
  updateReceipt,
};
function atomic(file,value,mode,gidValue){
  const parent=path.dirname(file),temporary=path.join(parent,`.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
  let fd,dir;
  try{
    fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);
    fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.chownSync(temporary,0,gidValue);fs.chmodSync(temporary,mode);fs.renameSync(temporary,file);
    dir=fs.openSync(parent,fs.constants.O_RDONLY);fs.fsyncSync(dir);
  }finally{
    if(fd!==undefined)try{fs.closeSync(fd)}catch{}
    if(dir!==undefined)try{fs.closeSync(dir)}catch{}
    try{fs.unlinkSync(temporary)}catch{}
  }
}
atomic(receipt,receiptPayload,0o640,gid);
const sidecarPayload={
  format:"grabenplaner-runtime-v3-postcommit-recovery",schemaVersion:1,status:"success",
  completedAt,finalizerVersion:"0.88.4-beta",diagnosticDirectory:path.basename(diagnosticDir),
  evidence:{
    updaterTranscriptSha256:hash(transcript),updaterCommitSha256:hash(commit),
    updateReceiptSha256:hash(path.join(path.dirname(receipt),updateReceipt)),
    runtimeCheckpointSha256:hash(runtimeCheckpoint),migrationReceiptSha256:hash(receipt),
  },
};
atomic(sidecar,sidecarPayload,0o640,gid);
const markerPayload={
  format:"grabenplaner-runtime-v3-postcommit-finalized",schemaVersion:1,status:"success",
  completedAt,finalizerVersion:"0.88.4-beta",migrationReceipt:path.basename(receipt),
  migrationReceiptSha256:hash(receipt),recoverySidecar:path.basename(sidecar),
  recoverySidecarSha256:hash(sidecar),
};
atomic(marker,markerPayload,0o600,0);
for(const [file,mode] of [[receipt,0o640],[sidecar,0o640],[marker,0o600]]){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||stat.nlink!==1||(stat.mode&0o777)!==mode)process.exit(1);
  JSON.parse(fs.readFileSync(file,"utf8"));
}
NODE

printf '%s\n' "{\"ok\":true,\"fromSchema\":2,\"toSchema\":3,\"fromVersion\":\"$from_version\",\"toVersion\":\"$to_version\",\"rebootTriggered\":false,\"receipt\":\"$receipt\",\"recoverySidecar\":\"$sidecar\",\"diagnosticRetained\":true}"
gp_info "Der fehlende Runtime-v3-Migrationsbeleg wurde kontrolliert finalisiert; App, Runtime, Offsite und Hostzustand blieben unveraendert."

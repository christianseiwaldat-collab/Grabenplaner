#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null || true)"
[[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] \
  || { printf '%s\n' "Der Deploy-Vorabcheck konnte nicht sicher aufgeloest werden." >&2; exit 1; }
readonly SCRIPT_PATH
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Verwendung: sudo ./preflight-grabenplaner-deploy.sh [Optionen]

Prueft vor Paketbau und Upload, ob der Server einen Deploy sicher beginnen kann.
Der Check reserviert die Wartungssperre nur fuer seine kurze Laufzeit, veraendert
keine Timer und installiert nichts.

  --env-file PFAD             geschuetzte Server-Umgebung
  --app-dir PFAD              installierter App-Ordner
  --data-dir PFAD             geschuetzter Datenordner
  --database PFAD             SQLite-Datei oder PostgreSQL-Paarbezug
  --backup-dir PFAD           Ziel fuer lokale Sicherungen
  --public-url HTTPS-URL      oeffentliche Grabenplaner-Ursprungsadresse
  --node PFAD                 Node.js-Laufzeit
  --pnpm PFAD                 pnpm-Laufzeit; sonst pnpm oder Corepack aus PATH
  --service NAME              App-systemd-Unit
  --caddy-service NAME        Caddy-systemd-Unit
  --build-cache PFAD          isolierter Build-Cache
  --minimum-free-bytes ZAHL   Mindestfreiraum je benoetigtem Dateisystem
EOF
}

env_file="$GP_DEFAULT_ENV_FILE"
app_arg=""
data_arg=""
database_arg=""
backup_arg=""
public_url_arg=""
node_arg=""
pnpm_arg=""
build_cache_arg=""
service="$GP_DEFAULT_SERVICE"
caddy_service="$GP_DEFAULT_CADDY_SERVICE"
minimum_free_bytes=5368709120

while (($#)); do
  case "$1" in
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
    --build-cache) build_cache_arg="${2:?Wert fuer --build-cache fehlt}"; shift 2 ;;
    --minimum-free-bytes) minimum_free_bytes="${2:?Wert fuer --minimum-free-bytes fehlt}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

gp_require_root
for command_name in awk clamscan curl date dirname flock getent grep id install readlink realpath runuser stat systemctl uname unzip; do
  gp_require_command "$command_name"
done
[[ "$(uname -m)" == x86_64 ]] || gp_die "Der Server verwendet nicht die freigegebene Linux-x64-Architektur."
[[ "$minimum_free_bytes" =~ ^[0-9]+$ ]] && (( minimum_free_bytes >= 1073741824 && minimum_free_bytes <= 1099511627776 )) \
  || gp_die "--minimum-free-bytes muss zwischen 1 GiB und 1 TiB liegen."

gp_load_env_file "$env_file"
app_dir="$(gp_existing_directory "${app_arg:-$GP_DEFAULT_APP_DIR}" "App-Ordner")"
data_dir="$(gp_existing_directory "${data_arg:-${GRABENPLANER_DATA_DIR:-$GP_DEFAULT_DATA_DIR}}" "Datenordner")"
backup_dir="$(gp_safe_absolute_path "${backup_arg:-${BACKUP_DIR:-$GP_DEFAULT_BACKUP_DIR}}" "Backupordner")"
backup_probe="$backup_dir"
while [[ ! -d "$backup_probe" ]]; do
  parent="$(dirname -- "$backup_probe")"
  [[ "$parent" != "$backup_probe" ]] || gp_die "Der Backupordner besitzt keinen vorhandenen Elternordner."
  backup_probe="$parent"
done
build_cache="$(gp_existing_directory "${build_cache_arg:-$GP_DEFAULT_BUILD_CACHE}" "Build-Cache")"
public_url="${public_url_arg:-${GRABENPLANER_PUBLIC_URL:-}}"
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
"$node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<13))process.exit(1)' \
  || gp_die "Node.js >=22.13.0 wird benoetigt."
gp_validate_https_url "$node" "$public_url" || gp_die "GRABENPLANER_PUBLIC_URL muss eine reine HTTPS-Ursprungsadresse sein."
getent passwd "$GP_DEFAULT_SERVICE_USER" >/dev/null || gp_die "Dienstbenutzer fehlt: $GP_DEFAULT_SERVICE_USER"
getent group "$GP_DEFAULT_SERVICE_GROUP" >/dev/null || gp_die "Dienstgruppe fehlt: $GP_DEFAULT_SERVICE_GROUP"
getent passwd "$GP_DEFAULT_BUILD_USER" >/dev/null || gp_die "Isolierter Build-Benutzer fehlt: $GP_DEFAULT_BUILD_USER"
getent group "$GP_DEFAULT_BUILD_GROUP" >/dev/null || gp_die "Isolierte Build-Gruppe fehlt: $GP_DEFAULT_BUILD_GROUP"
[[ "$(id -gn "$GP_DEFAULT_BUILD_USER")" == "$GP_DEFAULT_BUILD_GROUP" ]] \
  || gp_die "Der Build-Benutzer verwendet eine unerwartete Hauptgruppe."
for cache_access in -r -w -x; do
  runuser --user "$GP_DEFAULT_BUILD_USER" -- test "$cache_access" "$build_cache" \
    || gp_die "Der isolierte Build-Benutzer kann den Build-Cache nicht verwenden."
done
required_pnpm="$("$node" -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.packageManager||"").split("@").pop())' "$app_dir/package.json")"
[[ "$required_pnpm" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || gp_die "Die installierte pnpm-Vorgabe ist ungueltig."
actual_pnpm="$(cd -- "$build_cache" && runuser --user "$GP_DEFAULT_BUILD_USER" -- env -i \
  HOME="$build_cache" XDG_CACHE_HOME="$build_cache" PNPM_HOME="$build_cache/pnpm" COREPACK_HOME="$build_cache/corepack" \
  PATH="$(dirname -- "$node"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$pnpm_program" "${pnpm_arguments[@]}" --version)"
[[ "$actual_pnpm" == "$required_pnpm" ]] \
  || gp_die "Der installierte App-Stand erfordert pnpm $required_pnpm; einsatzbereit ist $actual_pnpm."
clamscan --no-summary -- "$SCRIPT_PATH" >/dev/null \
  || gp_die "ClamAV konnte den sauberen Vorabtest nicht erfolgreich pruefen."

database_provider="${DB_PROVIDER:-sqlite}"
if [[ "$database_provider" == postgresql ]]; then
  [[ -z "$database_arg" || "$database_arg" == "$data_dir/data/postgresql-pair.json" ]] \
    || gp_die "Der PostgreSQL-Paarbezug ist ungueltig."
  database="$(gp_existing_file "$data_dir/data/postgresql-pair.json" "PostgreSQL-Paarbezug")"
elif [[ "$database_provider" == sqlite ]]; then
  database="$(gp_existing_file "${database_arg:-${DB_PATH:-$data_dir/data/dienstplan.db}}" "SQLite-Datenbank")"
else
  gp_die "Der Datenbankprovider wird nicht unterstuetzt."
fi
gp_path_is_same_or_child "$database" "$data_dir" || gp_die "Die Datenbankbindung liegt nicht im geschuetzten Datenordner."
gp_assert_separate_trees "$app_dir" "$data_dir" "App- und Datenordner"
gp_assert_separate_trees "$backup_dir" "$data_dir" "Backup- und Datenordner"
gp_assert_separate_trees "$backup_dir" "$app_dir" "Backup- und App-Ordner"

gp_require_systemd_unit "$service"
gp_require_systemd_unit "$caddy_service"
systemctl is-active --quiet "$service" || gp_die "$service ist nicht aktiv."
systemctl is-active --quiet "$caddy_service" || gp_die "$caddy_service ist nicht aktiv."

port="${PORT:-3000}"
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || gp_die "PORT ist ungueltig."
internal_live_url="http://127.0.0.1:$port/api/health/live"
internal_ready_url="http://127.0.0.1:$port/api/health/ready"
public_live_url="${public_url%/}/api/health/live"
public_ready_url="${public_url%/}/api/health/ready"
gp_url_reports_ready "$internal_live_url" 8 || gp_die "Der interne Livenesscheck ist nicht gruen."
gp_url_reports_ready "$internal_ready_url" 8 || gp_die "Der interne Readinesscheck ist nicht gruen."
gp_url_reports_ready "$public_live_url" 15 || gp_die "Der oeffentliche Livenesscheck ist nicht gruen."
gp_url_reports_ready "$public_ready_url" 15 || gp_die "Der oeffentliche Readinesscheck ist nicht gruen."

gp_acquire_maintenance_lock
readonly -a maintenance_units=(
  apt-daily.service
  apt-daily-upgrade.service
  grabenplaner-monitor.service
  'grabenplaner-offsite-assurance@scheduled-nightly.service'
  'grabenplaner-offsite-assurance@manual-admin-ui.service'
  'grabenplaner-offsite-assurance@app-updated.service'
  'grabenplaner-offsite-assurance@offsite-config-changed.service'
  'grabenplaner-offsite-assurance@offsite-module-changed.service'
  grabenplaner-offsite-application-smoke.service
  grabenplaner-offsite-prepare.service
  grabenplaner-offsite-upload.service
  grabenplaner-offsite-check.service
  grabenplaner-offsite-restore-test.service
  grabenplaner-host-security-audit.service
  grabenplaner-host-security-rollback.service
  grabenplaner-host-reboot.service
  grabenplaner-postgresql-maintenance-recover.service
)
for unit in "${maintenance_units[@]}"; do
  gp_systemd_unit_exists "$unit" || continue
  active_state="$(systemctl show --property=ActiveState --value "$unit" 2>/dev/null || true)"
  case "$active_state" in
    inactive|failed) ;;
    *) gp_die "Wartung $unit laeuft oder wechselt gerade den Zustand ($active_state)." ;;
  esac
done

if gp_systemd_unit_exists grabenplaner-host-security-rollback.timer \
  && systemctl is-active --quiet grabenplaner-host-security-rollback.timer; then
  rollback_at="$(systemctl show --property=NextElapseUSecRealtime --value grabenplaner-host-security-rollback.timer 2>/dev/null || true)"
  gp_die "Ein Sicherheits-Rollback ist aktiv${rollback_at:+ und fuer $rollback_at geplant}. Vor seinem Abschluss ist kein Deploy erlaubt."
fi

readonly -a maintenance_timers=(
  apt-daily.timer
  apt-daily-upgrade.timer
  grabenplaner-monitor.timer
  grabenplaner-offsite-assurance.timer
  grabenplaner-offsite-upload.timer
  grabenplaner-offsite-check.timer
  grabenplaner-offsite-restore-test.timer
  grabenplaner-host-security-audit.timer
)
for timer in "${maintenance_timers[@]}"; do
  gp_systemd_unit_exists "$timer" || continue
  timer_state="inaktiv"
  systemctl is-active --quiet "$timer" && timer_state="aktiv"
  next_elapse="$(systemctl show --property=NextElapseUSecRealtime --value "$timer" 2>/dev/null || true)"
  gp_info "Deploy-Vorabcheck: $timer ist $timer_state${next_elapse:+; naechster Lauf $next_elapse}."
done

installed_runtime_verifier="$app_dir/server-tools/linux/lib/verify-package.js"
installed_tree_verifier="$app_dir/server-tools/linux/lib/verify-install-tree.js"
[[ -f "$installed_runtime_verifier" && ! -L "$installed_runtime_verifier" \
  && -f "$installed_tree_verifier" && ! -L "$installed_tree_verifier" ]] \
  || gp_die "Die installierten Runtime-Pruefer fehlen."
"$node" "$installed_runtime_verifier" --runtime-contract "$app_dir" >/dev/null \
  || gp_die "Der installierte Runtimevertrag ist nicht deployfaehig."
"$node" "$installed_tree_verifier" "$app_dir" >/dev/null \
  || gp_die "Der installierte App-Baum ist nicht deployfaehig."
if [[ "$database_provider" == postgresql ]]; then
  # The installed version may predate recovery-files-preflight. Use the
  # candidate beside this script, with the already verified installed modules.
  postgresql_preflight="$SCRIPT_DIR/lib/postgresql-operations.js"
  [[ -f "$postgresql_preflight" && ! -L "$postgresql_preflight" ]] \
    || gp_die "Die PostgreSQL-Vorabpruefung fehlt."
  NODE_PATH="$app_dir/node_modules" "$node" - "$postgresql_preflight" "$data_dir" "$backup_dir" <<'NODE' >/dev/null \
    || gp_die "Die PostgreSQL-Pfade oder Rueckkehrdateien verletzen bereits vor dem Deploy den Pfad- oder Dateitypvertrag."
const fs = require('node:fs'), path = require('node:path');
try {
  const helper = process.argv[2], root = path.resolve(path.dirname(helper), '../../..');
  function trusted(target, recursive = false) {
    const s = fs.lstatSync(target);
    if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)
      || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))
      || fs.realpathSync(target) !== target) throw Error('unsafe');
    if (recursive && s.isDirectory()) for (const name of fs.readdirSync(target)) trusted(path.join(target, name), true);
  }
  for (let directory = root;; directory = path.dirname(directory)) {
    trusted(directory);
    if (directory === path.dirname(directory)) break;
  }
  trusted(path.join(root, 'package.json'));
  trusted(path.join(root, 'lib'), true);
  trusted(path.join(root, 'server-tools'));
  trusted(path.join(root, 'server-tools/linux'));
  trusted(path.join(root, 'server-tools/linux/lib'), true);
  const runtime = require(path.join(root, 'lib/persistence/postgresql/operations/runtime.js'));
  const config = runtime.loadConfiguration('/etc/grabenplaner/postgresql-operations.json');
  if (config.sourceFiles !== process.argv[3] || config.backupDirectory !== process.argv[4]) {
    throw Error('PG_OPERATIONS_PATH_BINDING');
  }
  // This action only walks recovery files. It opens no database connection.
  const result = runtime.recoveryFilesPreflight(config.sourceFiles);
  if (result?.verified !== true) throw Error('unverified');
} catch (error) {
  process.stderr.write(error.message === 'PG_OPERATIONS_PATH_BINDING'
    ? 'PG_OPERATIONS_PATH_BINDING: Daten- und Backupordner muessen der geschuetzten PostgreSQL-Konfiguration entsprechen.\n'
    : 'PostgreSQL recovery-files-preflight ist nicht sicher ausfuehrbar oder fehlgeschlagen.\n');
  process.exitCode = 1;
}
NODE
fi

# The optional module's self-test checks structure, not successful recovery.
# Inspect only its protected, redacted status; never read provider credentials.
"$node" - "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" <<'NODE' \
  || gp_die "Die Offsite-Wiederherstellbarkeit ist nicht bestaetigt. Zuerst Recovery Assurance abschliessen."
const fs = require('node:fs');
try {
  const contractFile = '/etc/grabenplaner/offsite/installed-contract.json';
  const statusFile = '/var/lib/grabenplaner-offsite/status.json';
  function protectedJson(file, status = false) {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.nlink !== 1
      || (before.mode & 0o022) || (status && (before.mode & 0o7777) !== 0o640)
      || before.size < 2 || before.size > 131072 || fs.realpathSync(file) !== file) throw Error('unsafe');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const after = fs.fstatSync(fd);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw Error('changed');
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  }
  let installed = true;
  try { fs.lstatSync(contractFile); } catch (error) { if (error.code !== 'ENOENT') throw error; installed = false; }
  if (!installed) {
    if (process.argv[2] === '1') throw Error('missing');
    process.exit(0);
  }
  const contract = protectedJson(contractFile), status = protectedJson(statusFile, true);
  if (contract.format !== 'grabenplaner-linux-offsite-installed-contract' || contract.schemaVersion !== 1
    || !Number.isSafeInteger(contract.moduleVersion) || contract.moduleVersion < 1
    || status.format !== 'grabenplaner-offsite-backup-status' || status.schemaVersion !== 2
    || status.configured !== true || status.state !== 'ok'
    || !status.unresolvedFailures || Object.keys(status.unresolvedFailures).sort().join(',') !== 'backup,fullCheck,restoreTest'
    || Object.values(status.unresolvedFailures).some(value => value !== false)) throw Error('failed');
  for (const name of ['lastSuccessAt', 'lastFullCheckAt', 'lastRestoreTestAt']) {
    if (typeof status[name] !== 'string' || !Number.isFinite(Date.parse(status[name]))
      || Date.parse(status[name]) > Date.now() + 300000) throw Error('missing-proof');
  }
} catch {
  process.stderr.write('Offsite-Vorabcheck: erfolgreicher Backup-, Vollpruefungs- und Restore-Nachweis fehlt oder ein Fehler ist noch offen.\n');
  process.exitCode = 1;
}
NODE

free_bytes_for() {
  local target="$1" blocks block_size filesystem_stats
  filesystem_stats="$(stat --file-system --format='%a %S' -- "$target")" \
    || gp_die "Freier Speicher fuer $target ist nicht pruefbar."
  IFS=' ' read -r blocks block_size <<< "$filesystem_stats"
  [[ "$filesystem_stats" != *$'\n'* && "$blocks" =~ ^[0-9]+$ && "$block_size" =~ ^[0-9]+$ ]] \
    || gp_die "Freier Speicher fuer $target ist nicht pruefbar."
  printf '%s\n' "$((blocks * block_size))"
}
declare -A checked_devices=()
for storage_path in "$(dirname -- "$app_dir")" "$data_dir" "$backup_probe" "$build_cache"; do
  device="$(stat --file-system --format='%i' -- "$storage_path")"
  [[ -n "$device" ]] || gp_die "Das Dateisystem fuer $storage_path ist nicht identifizierbar."
  [[ -z "${checked_devices[$device]+x}" ]] || continue
  checked_devices[$device]=1
  available="$(free_bytes_for "$storage_path")"
  (( available >= minimum_free_bytes )) \
    || gp_die "Das Dateisystem fuer $storage_path hat weniger als $minimum_free_bytes Byte frei."
  gp_info "Deploy-Vorabcheck: $available Byte frei auf dem Dateisystem fuer $storage_path."
done

checked_at="$(date --utc '+%Y-%m-%dT%H:%M:%S.%3NZ')"
printf '{"ok":true,"format":"grabenplaner-deploy-preflight","schemaVersion":1,"checkedAt":"%s","databaseProvider":"%s","minimumFreeBytes":%s}\n' \
  "$checked_at" "$database_provider" "$minimum_free_bytes"

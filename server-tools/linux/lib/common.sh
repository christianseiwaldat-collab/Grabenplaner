#!/usr/bin/env bash

# Gemeinsame, absichtlich kleine Sicherheitsbasis fuer die Ubuntu-Wartungswerkzeuge.
# Die aufrufenden Skripte aktivieren selbst `set -Eeuo pipefail`, damit dieses
# Modul auch gefahrlos aus einer interaktiven Shell geladen werden kann.

GP_DEFAULT_APP_DIR="/opt/grabenplaner/app"
GP_DEFAULT_DATA_DIR="/var/lib/grabenplaner"
GP_DEFAULT_BACKUP_DIR="/var/backups/grabenplaner"
GP_DEFAULT_ENV_FILE="/etc/grabenplaner/grabenplaner.env"
GP_DEFAULT_SERVICE="grabenplaner.service"
GP_DEFAULT_CADDY_SERVICE="caddy.service"
GP_DEFAULT_SERVICE_USER="grabenplaner"
GP_DEFAULT_SERVICE_GROUP="grabenplaner"
GP_DEFAULT_BUILD_USER="grabenplaner-build"
GP_DEFAULT_BUILD_GROUP="grabenplaner-build"
GP_DEFAULT_BUILD_CACHE="/var/cache/grabenplaner"
GP_DEFAULT_RUNTIME_DIR="/run/grabenplaner"
GP_DEFAULT_MAINTENANCE_LOCK="/run/grabenplaner/maintenance.lock"

gp_log() {
  local level="$1"
  shift
  printf '%s [%s] %s\n' "$(date --utc '+%Y-%m-%dT%H:%M:%SZ')" "$level" "$*" >&2
}

gp_info() { gp_log INFO "$@"; }
gp_warn() { gp_log WARN "$@"; }
gp_die() {
  gp_log ERROR "$*"
  exit 1
}

gp_require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || gp_die "Dieser Vorgang muss als root ausgefuehrt werden (z. B. mit sudo)."
}

gp_require_command() {
  command -v "$1" >/dev/null 2>&1 || gp_die "Erforderliches Programm fehlt: $1"
}

gp_resolve_path() {
  local value="${1:-}"
  [[ -n "$value" && "$value" == /* ]] || return 1
  realpath --canonicalize-missing -- "$value"
}

gp_safe_absolute_path() {
  local value="${1:-}"
  local label="${2:-Pfad}"
  local resolved
  resolved="$(gp_resolve_path "$value")" || gp_die "$label muss ein absoluter lokaler Linux-Pfad sein."
  [[ "$resolved" != "/" ]] || gp_die "$label darf nicht das Dateisystem-Stammverzeichnis sein."
  [[ "$resolved" != *$'\n'* && "$resolved" != *$'\r'* ]] || gp_die "$label enthaelt unzulaessige Steuerzeichen."
  printf '%s\n' "$resolved"
}

gp_existing_file() {
  local resolved
  resolved="$(gp_safe_absolute_path "$1" "$2")"
  [[ -f "$resolved" && ! -L "$resolved" ]] || gp_die "$2 wurde nicht als regulaere Datei gefunden: $resolved"
  printf '%s\n' "$resolved"
}

gp_existing_directory() {
  local resolved
  resolved="$(gp_safe_absolute_path "$1" "$2")"
  [[ -d "$resolved" && ! -L "$resolved" ]] || gp_die "$2 wurde nicht als regulaerer Ordner gefunden: $resolved"
  printf '%s\n' "$resolved"
}

gp_path_is_same_or_child() {
  local candidate parent
  candidate="$(gp_resolve_path "$1")" || return 1
  parent="$(gp_resolve_path "$2")" || return 1
  [[ "$candidate" == "$parent" || "$candidate" == "$parent/"* ]]
}

gp_assert_separate_trees() {
  local first second label
  first="$(gp_safe_absolute_path "$1" "Erster Pfad")"
  second="$(gp_safe_absolute_path "$2" "Zweiter Pfad")"
  label="$3"
  if gp_path_is_same_or_child "$first" "$second" || gp_path_is_same_or_child "$second" "$first"; then
    gp_die "$label muessen vollstaendig getrennte Ordnerbaeume sein."
  fi
}

gp_assert_secure_env_file() {
  local file owner group mode
  file="$(gp_existing_file "$1" "Umgebungsdatei")"
  owner="$(stat --format='%u' -- "$file")"
  group="$(stat --format='%g' -- "$file")"
  mode="$(stat --format='%a' -- "$file")"
  [[ "$owner" == "0" && "$group" == "0" ]] || gp_die "Die Umgebungsdatei muss root:root gehoeren: $file"
  [[ "$mode" == "600" ]] || gp_die "Die geheime Umgebungsdatei muss exakt Modus 0600 verwenden: $file"
}

gp_load_env_file() {
  local file="${1:-$GP_DEFAULT_ENV_FILE}"
  gp_assert_secure_env_file "$file"
  # Die Datei wird durch den root-only Installer erzeugt und darf deshalb die
  # von systemd unterstuetzten einfachen KEY=VALUE-Zeilen enthalten.
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

gp_prepare_runtime_directory() {
  local runtime_directory owner group mode
  runtime_directory="$(gp_safe_absolute_path "${1:-$GP_DEFAULT_RUNTIME_DIR}" "Laufzeitverzeichnis")"
  if [[ -e "$runtime_directory" || -L "$runtime_directory" ]]; then
    [[ -d "$runtime_directory" && ! -L "$runtime_directory" ]] || gp_die "Das Laufzeitverzeichnis ist unzulaessig."
  else
    install -d -m 0755 -o root -g root -- "$runtime_directory"
  fi
  owner="$(stat --format='%u' -- "$runtime_directory")"
  group="$(stat --format='%g' -- "$runtime_directory")"
  mode="$(stat --format='%a' -- "$runtime_directory")"
  [[ "$owner" == "0" && "$group" == "0" ]] || gp_die "Das Laufzeitverzeichnis muss root:root gehoeren."
  (( (8#$mode & 022) == 0 )) || gp_die "Das Laufzeitverzeichnis darf fuer Gruppe oder andere Benutzer nicht beschreibbar sein."
  printf '%s\n' "$runtime_directory"
}

gp_acquire_maintenance_lock() {
  local lock_path lock_directory lock_owner lock_group
  gp_require_command flock
  lock_path="$(gp_safe_absolute_path "${1:-$GP_DEFAULT_MAINTENANCE_LOCK}" "Wartungssperre")"
  lock_directory="$(gp_prepare_runtime_directory "$(dirname -- "$lock_path")")"
  if [[ -e "$lock_path" || -L "$lock_path" ]]; then
    [[ -f "$lock_path" && ! -L "$lock_path" ]] || gp_die "Die Wartungssperre ist keine regulaere Datei."
    lock_owner="$(stat --format='%u' -- "$lock_path")"
    lock_group="$(stat --format='%g' -- "$lock_path")"
    [[ "$lock_owner" == "0" && "$lock_group" == "0" ]] || gp_die "Die Wartungssperre muss root:root gehoeren."
    chmod 0600 -- "$lock_path"
  else
    install -m 0600 -o root -g root /dev/null "$lock_path"
  fi
  exec 9<>"$lock_path"
  flock --nonblock 9 || gp_die "Eine andere Grabenplaner-Wartung (Backup, Restore oder Update) ist bereits aktiv."
}

gp_systemd_unit_exists() {
  systemctl show --property=LoadState --value "$1" 2>/dev/null | grep -qxv 'not-found'
}

gp_require_systemd_unit() {
  gp_systemd_unit_exists "$1" || gp_die "systemd-Unit nicht gefunden: $1"
}

gp_stop_service() {
  local service="$1"
  local timeout_seconds="${2:-120}"
  gp_require_systemd_unit "$service"
  if systemctl is-active --quiet "$service"; then
    gp_info "Beende $service kontrolliert ueber systemd (SIGTERM)."
    systemctl stop "$service"
  fi
  local deadline=$((SECONDS + timeout_seconds))
  while systemctl is-active --quiet "$service"; do
    (( SECONDS < deadline )) || gp_die "$service wurde nicht innerhalb von ${timeout_seconds}s beendet."
    sleep 1
  done
  local state
  state="$(systemctl is-active "$service" 2>/dev/null || true)"
  [[ "$state" == "inactive" || "$state" == "failed" ]] || gp_die "$service meldet nach dem Stopp den unerwarteten Zustand: $state"
}

gp_start_service() {
  local service="$1"
  gp_require_systemd_unit "$service"
  systemctl start "$service"
  systemctl is-active --quiet "$service" || gp_die "$service konnte nicht gestartet werden."
}

gp_url_reports_ready() {
  local url="$1"
  local timeout_seconds="${2:-8}"
  local response
  response="$(curl --fail --silent --show-error --max-time "$timeout_seconds" -- "$url" 2>/dev/null)" || return 1
  grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$response"
}

gp_wait_ready() {
  local url="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))
  while (( SECONDS < deadline )); do
    if gp_url_reports_ready "$url" 8; then return 0; fi
    sleep 2
  done
  return 1
}

gp_sha256() {
  sha256sum --binary -- "$1" | awk '{print tolower($1)}'
}

gp_validate_sha256() {
  [[ "$1" =~ ^[0-9A-Fa-f]{64}$ ]] || gp_die "Die freigegebene SHA256-Pruefsumme ist ungueltig."
}

gp_validate_https_url() {
  "$1" - "$2" <<'NODE'
const value = process.argv[2];
let url;
try { url = new URL(value); } catch { process.exit(1); }
if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname) process.exit(1);
NODE
}

gp_compare_semver() {
  "$1" - "$2" "$3" <<'NODE'
const [current, candidate] = process.argv.slice(2);
const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
function parse(value) {
  const match = String(value || "").match(pattern);
  if (!match) throw new Error(`Nicht vergleichbare Version: ${value}`);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4] ? match[4].split(".") : null };
}
function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const result = compareIdentifier(left.pre[index], right.pre[index]);
    if (result) return result;
  }
  return 0;
}
process.stdout.write(String(compare(parse(current), parse(candidate))));
NODE
}

gp_apply_app_permissions() {
  local path="$1"
  local group="${2:-$GP_DEFAULT_SERVICE_GROUP}"
  chown -R "root:$group" -- "$path"
  find "$path" -type d -exec chmod 0750 -- {} +
  find "$path" -type f ! -perm /111 -exec chmod 0640 -- {} +
  find "$path" -type f -perm /111 -exec chmod 0750 -- {} +
  find "$path/server-tools/linux" -type f -name '*.sh' -exec chmod 0750 -- {} + 2>/dev/null || true
}

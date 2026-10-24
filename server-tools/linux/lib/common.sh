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

gp_assert_shared_tmp() {
  local app_user="${1:-$GP_DEFAULT_SERVICE_USER}" build_user="${2:-$GP_DEFAULT_BUILD_USER}" account access
  local -a accounts=("$app_user" "$build_user")
  [[ -d "/tmp" && ! -L "/tmp" ]] \
    || gp_die "/tmp muss ein echtes Verzeichnis sein und darf kein Link sein."
  [[ "$(stat --format='%u:%g:%a' -- "/tmp")" == "0:0:1777" ]] \
    || gp_die "/tmp muss root:root gehoeren und exakt Modus 1777 mit Stickybit verwenden."
  if [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == 1 \
    || -e "/etc/grabenplaner/offsite/installed-contract.json" \
    || -L "/etc/grabenplaner/offsite/installed-contract.json" ]]; then
    accounts+=(grabenplaner-offsite)
  fi
  for account in "${accounts[@]}"; do
    getent passwd "$account" >/dev/null || gp_die "Ein fuer /tmp benoetigtes Konto fehlt: $account"
    for access in -w -x; do
      runuser --user "$account" -- test "$access" "/tmp" \
        || gp_die "Das Konto $account kann /tmp nicht schreiben oder durchsuchen."
    done
  done
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
  local requested file owner group mode links
  requested="${1:-}"
  [[ -n "$requested" && "$requested" == /* ]] || gp_die "Die Umgebungsdatei muss ein absoluter lokaler Linux-Pfad sein."
  [[ -f "$requested" && ! -L "$requested" ]] || gp_die "Die Umgebungsdatei muss eine regulaere Datei sein und darf kein Link sein: $requested"
  file="$(gp_existing_file "$requested" "Umgebungsdatei")"
  owner="$(stat --format='%u' -- "$file")"
  group="$(stat --format='%g' -- "$file")"
  mode="$(stat --format='%a' -- "$file")"
  links="$(stat --format='%h' -- "$file")"
  [[ "$owner" == "0" && "$group" == "0" ]] || gp_die "Die Umgebungsdatei muss root:root gehoeren: $file"
  [[ "$mode" == "600" ]] || gp_die "Die geheime Umgebungsdatei muss exakt Modus 0600 verwenden: $file"
  [[ "$links" == "1" ]] || gp_die "Die geheime Umgebungsdatei darf keine zusaetzlichen Hardlinks besitzen: $file"
}

gp_load_env_file() {
  local file="${1:-$GP_DEFAULT_ENV_FILE}" line key value line_number=0
  local -A seen_keys=()
  gp_assert_secure_env_file "$file"

  # Die root-only Datei wird absichtlich nicht als Shellcode ausgewertet.
  # Erlaubt sind nur Kommentare, Leerzeilen und einfache KEY=VALUE-Zeilen;
  # der komplette Teil hinter dem ersten Gleichheitszeichen bleibt literal.
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] \
      || gp_die "Ungueltige Zeile ${line_number} in der Umgebungsdatei; erwartet wird KEY=VALUE."
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ ! ${seen_keys[$key]+vorhanden} ]] \
      || gp_die "Der Schluessel $key ist in der Umgebungsdatei doppelt vorhanden."
    seen_keys["$key"]=1
    # -g schreibt bewusst in die aufrufende Shell-Umgebung, ohne gleichnamige
    # lokale Parservariablen (z. B. line_number) zu ueberschreiben.
    declare -gx -- "$key=$value" \
      || gp_die "Der Schluessel $key konnte nicht sicher uebernommen werden."
  done < "$file"
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

gp_acquire_backup_workspace_lock() {
  local database="$1" node="$2" helper="$3" workspace_file opened named
  [[ -f "$helper" && ! -L "$helper" ]] || gp_die "Das Modul fuer den gemeinsamen Backup-Arbeitsbereich fehlt."
  workspace_file="$("$node" "$helper" prepare-linux-file "$database")" \
    || gp_die "Der gemeinsame Backup-Arbeitsbereich konnte nicht vorbereitet werden."
  [[ "$workspace_file" == "$database.backup-workspace.lock" && -f "$workspace_file" && ! -L "$workspace_file" ]] \
    || gp_die "Die Backup-Arbeitsbereichssperre ist ungueltig."
  exec 5<"$workspace_file"
  flock --exclusive --timeout 1400 5 || gp_die "Ein laufender Backup- oder Wiederherstellungsvorgang wurde nicht rechtzeitig abgeschlossen."
  opened="$(stat -L --format='%d:%i:%h' -- "/proc/${BASHPID:-$$}/fd/5")"
  named="$(stat --format='%d:%i:%h' -- "$workspace_file")"
  [[ "$opened" == "$named" && "$named" == *:1 && ! -L "$workspace_file" ]] \
    || gp_die "Die Backup-Arbeitsbereichssperre wurde waehrend des Wartens veraendert."
}

gp_release_backup_workspace_lock() {
  exec 5<&-
}

gp_begin_update_backup_ownership() {
  gp_begin_backup_ownership "$1" "$2" "$3" 9 8
}

gp_begin_backup_ownership() {
  local database="$1" node="$2" helper="$3" maintenance_fd="$4" owner_fd="$5" owner_file
  gp_require_root
  [[ "$maintenance_fd" == 6 || "$maintenance_fd" == 9 ]] && [[ "$owner_fd" == 4 || "$owner_fd" == 8 ]] \
    || gp_die "Die Sicherungsverantwortung hat ungueltige Sperrdeskriptoren."
  [[ -f "$helper" && ! -L "$helper" ]] || gp_die "Das Modul fuer die Sicherungsverantwortung fehlt."
  owner_file="$("$node" "$helper" prepare "$maintenance_fd")" || gp_die "Die Sicherungsverantwortung konnte nicht vorbereitet werden."
  [[ "$owner_file" == "/run/grabenplaner/update-backup-owner.json" && ! -L "$owner_file" ]] \
    || gp_die "Die Sicherungsverantwortung hat keinen gueltigen Pfad."
  if [[ "$owner_fd" == 4 ]]; then exec 4<>"$owner_file"; else exec 8<>"$owner_file"; fi
  flock --exclusive --nonblock "$owner_fd" || gp_die "Ein anderer Wartungsprozess besitzt bereits den Sicherungsauftrag."
  "$node" "$helper" publish "$database" "$maintenance_fd" "$owner_fd" || gp_die "Die Sicherungsverantwortung konnte nicht uebernommen werden."
}

gp_stop_service() {
  local service="$1"
  local timeout_seconds="${2:-120}" initial_pid current_pid state
  gp_require_systemd_unit "$service"
  if systemctl is-active --quiet "$service"; then
    initial_pid="$(systemctl show --property=MainPID --value "$service")"
    [[ "$initial_pid" =~ ^[1-9][0-9]*$ ]] || gp_die "$service hat keinen eindeutigen Hauptprozess."
    gp_info "Beende $service kontrolliert; laufende Sicherungsprozesse duerfen zuerst abschliessen."
    # A direct stop with KillMode=control-group also terminates the archive
    # workers the application is trying to drain. Signal only the main process
    # first; the existing shutdown owns and verifies its children until exit.
    systemctl kill --kill-whom=main --signal=SIGTERM "$service" \
      || gp_die "$service konnte nicht zum kontrollierten Dienststopp aufgefordert werden."
    local drain_deadline=$((SECONDS + 1500))
    while :; do
      current_pid="$(systemctl show --property=MainPID --value "$service")"
      [[ "$current_pid" == "0" ]] && break
      [[ "$current_pid" == "$initial_pid" ]] || gp_die "$service wurde waehrend des Dienststopps unerwartet neu gestartet."
      (( SECONDS < drain_deadline )) || gp_die "Die laufende Sicherung von $service wurde nicht rechtzeitig beendet; keine Prozesse werden zwangsweise abgebrochen."
      sleep 1
    done
  fi
  # Main has exited and drained its children. Cancel a queued failure restart
  # and let systemd finish the unit without sending SIGTERM to live backups.
  systemctl stop "$service"
  local deadline=$((SECONDS + timeout_seconds))
  while systemctl is-active --quiet "$service"; do
    (( SECONDS < deadline )) || gp_die "$service wurde nicht innerhalb von ${timeout_seconds}s beendet."
    sleep 1
  done
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

# Module setup can precede the application swap. Only the matching pair uses
# one nightly run. A rollback to the predecessor restores its expected timers.
gp_nightly_schedule_mode() {
  local app="${1:?App-Verzeichnis fehlt}" node="${2:?Node-Laufzeit fehlt}"
  "$node" - "$app" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
try {
  const installed='/etc/grabenplaner/offsite/installed-contract.json';
  if(!fs.existsSync(installed)){process.stdout.write('none');process.exit(0);}
  function read(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||(s.mode&0o022)||s.size>131072||fs.realpathSync(file)!==file)throw Error();return JSON.parse(fs.readFileSync(file,'utf8'));}
  const core=read(path.join(process.argv[2],'server-tools/linux/offsite/module-schema.json')),module=read(installed);
  if(core.format!=='grabenplaner-linux-offsite-module-contract'||core.schemaVersion!==1||module.format!=='grabenplaner-linux-offsite-installed-contract'||module.schemaVersion!==1||![7,8,9,10,11,12,13].includes(core.moduleVersion)||![7,8,9,10,11,12,13].includes(module.moduleVersion))throw Error();
  process.stdout.write(core.moduleVersion>=10&&module.moduleVersion>=10?'single':'legacy');
}catch{process.stderr.write('Der Sicherungszeitplan konnte nicht verifiziert werden.\n');process.exitCode=1;}
NODE
}

# Read the protected matrix receipt through its real schema/revision validator.
# An absent receipt is distinct from an invalid one: invalid state never falls
# back to installation defaults.
gp_maintenance_schedule_state() {
  local app="${1:?App-Verzeichnis fehlt}" node="${2:?Node-Laufzeit fehlt}"
  "$node" - "$app" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
try {
  const root='/var/lib/grabenplaner-maintenance-schedules';
  let directory;try{directory=fs.lstatSync(root);}catch(e){if(e.code!=='ENOENT')throw e;process.stdout.write('none');process.exit(0);}
  if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==0||directory.gid!==0||directory.nlink<2||(directory.mode&0o7777)!==0o700||fs.realpathSync(root)!==root)throw Error();
  const file=path.join(root,'schedules.json');
  try{fs.lstatSync(file);}catch(e){if(e.code!=='ENOENT')throw e;process.stdout.write('none');process.exit(0);}
  let helper=path.join(process.argv[2],'server-tools/linux/offsite/lib/maintenance-schedule-broker.js');
  if(!fs.existsSync(helper))helper='/opt/grabenplaner-offsite/module/lib/maintenance-schedule-broker.js';
  const info=fs.lstatSync(helper);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||info.nlink!==1||(info.mode&0o022)||info.size>262144||fs.realpathSync(helper)!==helper)throw Error();
  const broker=require(helper),state=broker.readState({stateRoot:root});
  if(!state)throw Error();
  const rows=broker.TASKS.map(task=>{
    const value=state.schedules.find(row=>row.id===task.id);if(!value||typeof value.enabled!=='boolean')throw Error();
    return task.timer+'='+(value.enabled?'1':'0');
  });
  process.stdout.write(rows.join('\n'));
}catch{process.stderr.write('Der gespeicherte Wartungszeitplan konnte nicht verifiziert werden.\n');process.exitCode=1;}
NODE
}

gp_maintenance_timer_expected() {
  local state="${1:?Zeitplanstand fehlt}" timer="${2:?Timer fehlt}" unit enabled
  if [[ "$state" == none ]]; then printf '1'; return 0; fi
  while IFS='=' read -r unit enabled; do
    if [[ "$unit" == "$timer" && ( "$enabled" == 0 || "$enabled" == 1 ) ]]; then printf '%s' "$enabled"; return 0; fi
  done <<< "$state"
  return 1
}

gp_maintenance_timer_matches() {
  local timer="${1:?Timer fehlt}" expected="${2:?Aktivierung fehlt}" paused="${3:-0}" enabled active
  enabled="$(systemctl is-enabled "$timer" 2>/dev/null)" || [[ "$enabled" == disabled ]] || return 1
  active="$(systemctl is-active "$timer" 2>/dev/null)" || [[ "$active" == inactive ]] || return 1
  if [[ "$expected" == 0 ]]; then [[ "$enabled" == disabled && "$active" == inactive ]];
  elif [[ "$expected" == 1 ]]; then [[ "$enabled" == enabled && ( "$active" == active || ( "$paused" == 1 && "$active" == inactive ) ) ]];
  else return 1; fi
}

gp_configure_nightly_backups() {
  local mode saved_schedule
  mode="$(gp_nightly_schedule_mode "$1" "$2")" || return 1
  [[ "$mode" != none ]] || return 0
  saved_schedule="$(gp_maintenance_schedule_state "$1" "$2")" || return 1
  # Matrix-managed timers keep their existing configuration and deploy pause.
  # The updater separately restores the exact previously active timers.
  [[ "$saved_schedule" == none ]] || return 0
  # Verify the complete replacement BEFORE removing the standalone daily run.
  systemctl enable --now grabenplaner-offsite-assurance.timer >/dev/null || return 1
  systemctl is-enabled --quiet grabenplaner-offsite-assurance.timer \
    && systemctl is-active --quiet grabenplaner-offsite-assurance.timer || return 1
  if [[ "$mode" == single ]]; then
    systemctl disable --now grabenplaner-offsite-upload.timer >/dev/null || return 1
  else
    systemctl enable --now grabenplaner-offsite-upload.timer >/dev/null || return 1
  fi
}

gp_apply_app_permissions() {
  local path="$1"
  local group="${2:-$GP_DEFAULT_SERVICE_GROUP}"
  local linux_root=""
  [[ -d "$path" && ! -L "$path" ]] || {
    gp_log ERROR "Der App-Baum fuer die Rechtevergabe ist ungueltig."
    return 1
  }
  if [[ -d "$path/server-tools" && ! -L "$path/server-tools" \
    && -d "$path/server-tools/linux" && ! -L "$path/server-tools/linux" ]]; then
    linux_root="$path/server-tools/linux"
  elif [[ -f "$path/update-grabenplaner-server.sh" && ! -L "$path/update-grabenplaner-server.sh" \
    && -f "$path/lib/common.sh" && ! -L "$path/lib/common.sh" ]]; then
    linux_root="$path"
  else
    gp_log ERROR "Der App-Baum enthaelt keinen eindeutig vertrauenswuerdigen Linux-Werkzeugordner."
    return 1
  fi
  [[ -f "$linux_root/update-grabenplaner-server.sh" && ! -L "$linux_root/update-grabenplaner-server.sh" \
    && -f "$linux_root/lib/common.sh" && ! -L "$linux_root/lib/common.sh" ]] || {
    gp_log ERROR "Der Linux-Werkzeugordner besitzt keinen gueltigen Wartungsvertrag."
    return 1
  }
  chown -R "root:$group" -- "$path"
  find "$path" -type d -exec chmod 0750 -- {} +
  find "$path" -type f ! -perm /111 -exec chmod 0640 -- {} +
  find "$path" -type f -perm /111 -exec chmod 0750 -- {} +
  find "$linux_root" -type f -name '*.sh' -exec chmod 0750 -- {} +
}

# Copy into fresh inodes behind a root-only directory before root executes
# candidate code. Chown alone cannot revoke a build process's open writer FDs.
gp_seal_build_tree() {
  local source="$1" target="$2" group="$3" parent source_parent private_root unsafe
  [[ -d "$source" && ! -L "$source" && ! -e "$target" && ! -L "$target" ]] || return 1
  parent="$(dirname -- "$target")"
  [[ "$(realpath --canonicalize-existing -- "$parent")" == "$parent" \
    && "$(stat --format='%u' -- "$parent")" == 0 ]] || return 1
  local parent_mode
  parent_mode="$(stat --format='%a' -- "$parent")"
  (( (8#$parent_mode & 022) == 0 )) || return 1
  source_parent="$(dirname -- "$source")"
  [[ "$(realpath --canonicalize-existing -- "$source_parent")" == "$source_parent" \
    && "$(stat --format='%u' -- "$source_parent")" == 0 ]] || return 1
  parent_mode="$(stat --format='%a' -- "$source_parent")"
  (( (8#$parent_mode & 022) == 0 )) || return 1
  private_root="$(mktemp --directory --tmpdir="$parent" .root-seal.XXXXXXXX)" || return 1
  chmod 0700 -- "$private_root" || return 1
  mkdir -m 0700 -- "$private_root/tree" || return 1
  # The builder may rename a directory while it is copied. Hold each source
  # directory descriptor and open every child relative to it, without following
  # links; a pathname-recursive copy could otherwise read outside that tree.
  /usr/bin/python3 -I - "$source" "$private_root/tree" <<'PY' || return 1
import json, os, posixpath, re, shlex, stat, sys
source, target = sys.argv[1:]
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
executable_links = []
assert os.geteuid() == 0

def defer_executable_link(source_fd, name, before, parts):
    # Hold the npm command-link inode itself, never its untrusted target.
    assert parts[-2:] == ('node_modules', '.bin')
    assert re.fullmatch(r'[A-Za-z0-9_@][A-Za-z0-9_.+-]{0,199}', name)
    assert len(executable_links) < 4096 and before.st_nlink == 1
    descriptor = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=source_fd)
    try:
        opened = os.fstat(descriptor)
        assert stat.S_ISLNK(opened.st_mode) and opened.st_nlink == 1
        assert (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino)
        link = os.readlink('', dir_fd=descriptor)
        assert re.fullmatch(r'[A-Za-z0-9_@./+-]{1,2048}', link) and not link.startswith('/')
        resolved = posixpath.normpath(posixpath.join(*parts, link))
        assert not resolved.startswith('../') and resolved != '..'
        resolved_parts = tuple(resolved.split('/'))
        assert 'node_modules' in resolved_parts and '.bin' not in resolved_parts
        executable_links.append((parts, name, descriptor, link, resolved_parts))
    except BaseException:
        os.close(descriptor)
        raise

def copy_directory(source_fd, target_fd, depth=0, parts=()):
    assert depth < 128
    for name in sorted(os.listdir(source_fd)):
        assert name not in ('.', '..') and '/' not in name and '\0' not in name
        before = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        if stat.S_ISDIR(before.st_mode):
            child = os.open(name, directory_flags, dir_fd=source_fd)
            try:
                opened = os.fstat(child)
                assert (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino)
                os.mkdir(name, 0o700, dir_fd=target_fd)
                destination = os.open(name, directory_flags, dir_fd=target_fd)
                try:
                    copy_directory(child, destination, depth + 1, parts + (name,))
                finally:
                    os.close(destination)
            finally:
                os.close(child)
        elif stat.S_ISLNK(before.st_mode):
            defer_executable_link(source_fd, name, before, parts)
        else:
            assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
            try:
                opened = os.fstat(descriptor)
                assert stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1
                assert (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino)
                output = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o700 if opened.st_mode & 0o111 else 0o600, dir_fd=target_fd)
                try:
                    while chunk := os.read(descriptor, 1024 * 1024):
                        view = memoryview(chunk)
                        while view:
                            count = os.write(output, view)
                            assert count > 0
                            view = view[count:]
                finally:
                    os.close(output)
            finally:
                os.close(descriptor)
def copied_directory(root_fd, parts):
    descriptor = os.dup(root_fd)
    try:
        for part in parts:
            assert part not in ('', '.', '..')
            child = os.open(part, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            assert os.fstat(descriptor).st_uid == 0
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

def copied_regular(root_fd, parts, limit):
    parent = copied_directory(root_fd, parts[:-1])
    try:
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=parent)
        try:
            info = os.fstat(descriptor)
            assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0
            return info, os.read(descriptor, limit + 1)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        assert key not in result
        result[key] = value
    return result

def materialize_executable_links(root_fd):
    # Validate only fresh root-owned bytes. Nested ESM type markers are not
    # package roots: the nearest node_modules boundary selects the bin manifest.
    for parts, name, descriptor, link, resolved in executable_links:
        info = os.fstat(descriptor)
        assert stat.S_ISLNK(info.st_mode) and info.st_nlink == 1
        assert os.readlink('', dir_fd=descriptor) == link
        boundary = max(i for i, part in enumerate(resolved) if part == 'node_modules')
        package_end = boundary + (3 if resolved[boundary + 1].startswith('@') else 2)
        assert package_end < len(resolved)
        package = resolved[:package_end]
        package_name = '/'.join(package[boundary + 1:])
        _, data = copied_regular(root_fd, package + ('package.json',), 1024 * 1024)
        assert len(data) <= 1024 * 1024
        metadata = json.loads(data, object_pairs_hook=unique_object)
        assert isinstance(metadata, dict) and metadata.get('name') == package_name
        commands = metadata.get('bin')
        if isinstance(commands, str):
            commands = {package_name.rsplit('/', 1)[-1]: commands}
        assert isinstance(commands, dict) and isinstance(commands.get(name), str)
        declared = commands[name]
        assert re.fullmatch(r'[A-Za-z0-9_@./+-]{1,2048}', declared) and not declared.startswith('/')
        declared_parts = tuple(posixpath.normpath(posixpath.join(*package, declared)).split('/'))
        assert declared_parts == resolved and declared_parts[:package_end] == package
        executable, prefix = copied_regular(root_fd, resolved, 256)
        assert executable.st_mode & 0o111
        # sha.js@2.4.12 uses the valid Linux space immediately after #!.
        # Keep an exact interpreter allowlist: no arguments or shell parsing.
        assert prefix.split(b'\n', 1)[0] in (
            b'#!/usr/bin/env node', b'#!/usr/bin/node', b'#! /usr/bin/env node')
        destination = copied_directory(root_fd, parts)
        try:
            output = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o700, dir_fd=destination)
            try:
                relative = posixpath.relpath('/'.join(resolved), '/'.join(parts))
                shim = ('#!/bin/sh\ncase "$0" in\n  */*) gp_bin_dir=${0%/*} ;;\n'
                        '  *) gp_bin_dir=. ;;\nesac\nexec "$gp_bin_dir"/' +
                        shlex.quote(relative) + ' "$@"\n').encode('utf-8')
                assert os.write(output, shim) == len(shim)
            finally:
                os.close(output)
        finally:
            os.close(destination)

source_fd = os.open(source, directory_flags)
try:
    target_fd = os.open(target, directory_flags)
    try:
        copy_directory(source_fd, target_fd)
        materialize_executable_links(target_fd)
    finally:
        os.close(target_fd)
finally:
    os.close(source_fd)
    for _, _, descriptor, _, _ in executable_links:
        os.close(descriptor)
PY
  unsafe="$(find "$private_root/tree" ! -type f ! -type d -print -quit)" || return 1
  [[ -z "$unsafe" ]] || return 1
  unsafe="$(find "$private_root/tree" -type f ! -links 1 -print -quit)" || return 1
  [[ -z "$unsafe" ]] || return 1
  unsafe="$(find "$private_root/tree" ! -user root -print -quit)" || return 1
  [[ -z "$unsafe" ]] || return 1
  gp_apply_app_permissions "$private_root/tree" "$group" || return 1
  mv -T -- "$private_root/tree" "$target" || return 1
  rmdir -- "$private_root" || return 1
}

# This independent verifier reads the original, root-owned SHA-pinned ZIP.
# Neither a build-modified manifest nor candidate JavaScript is a trust anchor.
gp_verify_sealed_zip() {
  local package="$1" sealed="$2" dependencies="${3:-0}"
  /usr/bin/python3 -I - "$package" "$sealed" "$dependencies" <<'PY'
import os, stat, sys, zipfile
from pathlib import Path
package, root, dependencies = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
assert os.geteuid() == 0 and dependencies in ('0', '1')
assert package.is_absolute() and root.is_absolute()
assert package.resolve() == package and root.resolve() == root
info = package.lstat()
assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and info.st_mode & 0o022 == 0
expected = set()
with zipfile.ZipFile(package) as archive:
    for entry in archive.infolist():
        name = entry.filename.removeprefix('./').rstrip('/')
        assert name and '\\' not in name and not name.startswith('/') and all(ord(c) >= 32 and ord(c) != 127 for c in name)
        parts = name.split('/')
        assert all(part and part not in ('.', '..') for part in parts)
        if entry.is_dir():
            continue
        assert name not in expected and not (dependencies == '1' and parts[0] == 'node_modules')
        expected.add(name)
        target = root.joinpath(*parts)
        info = target.lstat()
        assert target.resolve() == target and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and info.st_mode & 0o022 == 0
        assert info.st_size == entry.file_size
        descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as current, archive.open(entry) as original:
            while True:
                before, after = original.read(1024 * 1024), current.read(1024 * 1024)
                assert before == after
                if not before:
                    break
actual = set()
for directory, folders, files in os.walk(root, followlinks=False):
    for name in folders + files:
        target = Path(directory) / name
        info = target.lstat()
        assert target.resolve() == target and not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0
    if dependencies == '1' and Path(directory) == root and 'node_modules' in folders:
        folders.remove('node_modules')
    for name in files:
        target = Path(directory) / name
        assert stat.S_ISREG(target.lstat().st_mode)
        actual.add(target.relative_to(root).as_posix())
assert actual == expected
PY
}

gp_assert_root_node() {
  # No candidate runtime code may execute to establish this boundary. Require
  # the native Linux executable; script wrappers could load writable siblings.
  /usr/bin/python3 -I - "$1" <<'PY'
import os, stat, sys
from pathlib import Path
file = Path(sys.argv[1]).resolve(strict=True)
assert os.geteuid() == 0 and file.is_absolute()
info = file.lstat()
assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_mode & 0o111
for item in (file, *file.parents):
    info = item.lstat()
    assert info.st_uid == 0 and not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022 == 0
with file.open('rb') as stream:
    assert stream.read(4) == b'\x7fELF'
print(file)
PY
}

gp_assert_root_package_manager() {
  # Both supported distributions bundle their implementation. An entry file
  # alone is insufficient: a writable dist/ sibling would execute as root.
  /usr/bin/python3 -I - "$1" "${2:-}" <<'PY'
import json, os, stat, sys
from pathlib import Path
file = Path(sys.argv[1]).resolve(strict=True)
assert os.geteuid() == 0 and file.is_absolute()
kind = 'corepack' if sys.argv[2] == 'pnpm' else 'pnpm'
assert sys.argv[2] in ('', 'pnpm')
package = next((p for p in file.parents if (p / 'package.json').is_file()), None)
assert package is not None
metadata = json.loads((package / 'package.json').read_text())
assert metadata['name'] == kind
assert kind != 'pnpm' or metadata['version'] == '11.7.0'
assert not any(metadata.get(key) for key in ('dependencies', 'optionalDependencies', 'peerDependencies'))
entry = metadata['bin'][kind]
assert (package / entry).resolve(strict=True) == file and file.suffix in ('.js', '.mjs', '.cjs')
count = 0
for item in (*package.parents, package):
    info = item.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0
for directory, folders, files in os.walk(package, followlinks=False):
    for name in (*folders, *files):
        item = Path(directory) / name
        info = item.lstat()
        assert info.st_uid == 0 and info.st_mode & 0o022 == 0
        assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1
        count += 1
        assert count <= 100000
print(file)
PY
}

gp_prepare_root_pg_dependencies() {
  local helper="${BASH_SOURCE[0]%/*}/root-postgresql-dependencies.sh"
  # Check before executing the helper; the build account must not supply the
  # verifier itself through a writable source tree or an extra hard link.
  /usr/bin/python3 -I - "$helper" <<'PY' || return 1
import os, stat, sys
from pathlib import Path
file = Path(sys.argv[1])
assert os.geteuid() == 0 and file.is_absolute() and file.resolve() == file
info = file.lstat()
assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1
for item in (file, *file.parents):
    info = item.lstat()
    assert info.st_uid == 0 and not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022 == 0
PY
  /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 /usr/bin/bash -- "$helper" "$@"
}

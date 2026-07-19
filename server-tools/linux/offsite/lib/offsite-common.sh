#!/usr/bin/env bash

# Gemeinsame Sicherheitsbasis des optionalen, getrennt aktivierten
# Grabenplaner-Offsite-Moduls. Dieses Modul enthaelt absichtlich keine Secrets.

readonly OFFSITE_ROOT="/opt/grabenplaner-offsite"
readonly OFFSITE_MODULE_ROOT="$OFFSITE_ROOT/module"
readonly OFFSITE_BIN_ROOT="$OFFSITE_ROOT/bin"
readonly OFFSITE_STATE_ROOT="/var/lib/grabenplaner-offsite"
readonly OFFSITE_STAGE_ROOT="$OFFSITE_STATE_ROOT/staging"
readonly OFFSITE_STAGE_CURRENT="$OFFSITE_STAGE_ROOT/current"
readonly OFFSITE_RESTORE_ROOT="$OFFSITE_STATE_ROOT/restore-tests"
readonly OFFSITE_CREDENTIAL_STATE_ROOT="$OFFSITE_STATE_ROOT/credentials"
readonly OFFSITE_RCLONE_CONFIG="$OFFSITE_CREDENTIAL_STATE_ROOT/rclone.conf"
readonly OFFSITE_UPLOADER_HOME="$OFFSITE_STATE_ROOT/uploader-home"
readonly OFFSITE_RUN_ROOT="/run/grabenplaner-offsite"
readonly OFFSITE_REPOSITORY_LOCK="$OFFSITE_RUN_ROOT/repository.lock"
readonly OFFSITE_CONFIG_ROOT="/etc/grabenplaner/offsite"
readonly OFFSITE_STATUS_ROOT="$OFFSITE_STATE_ROOT"
readonly OFFSITE_STATUS_FILE="$OFFSITE_STATE_ROOT/status.json"
readonly OFFSITE_APP_ROOT="/opt/grabenplaner/app"
readonly OFFSITE_DATA_ROOT="/var/lib/grabenplaner"
readonly OFFSITE_BACKUP_ROOT="/var/backups/grabenplaner"
readonly OFFSITE_APP_ENV="/etc/grabenplaner/grabenplaner.env"
readonly OFFSITE_APP_SERVICE="grabenplaner.service"
readonly OFFSITE_USER="grabenplaner-offsite"
readonly OFFSITE_GROUP="grabenplaner-offsite"
readonly OFFSITE_STATUS_GROUP="grabenplaner-offsite-status"
readonly OFFSITE_APP_USER="grabenplaner"
readonly OFFSITE_APP_GROUP="grabenplaner"
readonly OFFSITE_RESTIC="$OFFSITE_BIN_ROOT/restic"
readonly OFFSITE_RCLONE="$OFFSITE_BIN_ROOT/rclone"
readonly OFFSITE_NODE="/usr/bin/node"
readonly OFFSITE_RCLONE_WRAPPER="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-rclone-wrapper.sh"
readonly OFFSITE_LEGACY_RCLONE_WRAPPER="$OFFSITE_BIN_ROOT/grabenplaner-rclone"
readonly OFFSITE_BINARY_PINS="$OFFSITE_CONFIG_ROOT/binary-pins.json"
readonly OFFSITE_READER="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-read-secret.sh"
readonly OFFSITE_STATUS_HELPER="$OFFSITE_MODULE_ROOT/lib/offsite-status.js"
readonly OFFSITE_STAGE_HELPER="$OFFSITE_MODULE_ROOT/lib/offsite-stage.js"
readonly OFFSITE_REPOSITORY_ID_FILE="$OFFSITE_CONFIG_ROOT/repository-id"
readonly OFFSITE_RETENTION_DAILY=14
readonly OFFSITE_RETENTION_WEEKLY=8
readonly OFFSITE_RETENTION_MONTHLY=12

offsite_log() {
  local level="$1"
  shift
  printf '%s [%s] %s\n' "$(date --utc '+%Y-%m-%dT%H:%M:%SZ')" "$level" "$*" >&2
}

offsite_info() { offsite_log INFO "$@"; }
offsite_warn() { offsite_log WARN "$@"; }
offsite_die() {
  offsite_log ERROR "$*"
  exit 1
}

offsite_require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || offsite_die "Dieser Vorgang muss als root ausgefuehrt werden."
}

offsite_require_command() {
  command -v "$1" >/dev/null 2>&1 || offsite_die "Erforderliches Programm fehlt: $1"
}

offsite_assert_fixed_tree() {
  local path="$1"
  local expected="$2"
  [[ "$path" == "$expected" && "$path" == /* && "$path" != "/" ]] \
    || offsite_die "Ein interner Offsite-Pfad weicht vom freigegebenen Vertrag ab."
}

offsite_assert_regular_root_file() {
  local path="$1"
  local maximum_mode="${2:-600}"
  local owner group mode links
  [[ -f "$path" && ! -L "$path" ]] || offsite_die "Geschuetzte Offsite-Datei fehlt."
  owner="$(stat --format='%u' -- "$path")"
  group="$(stat --format='%g' -- "$path")"
  mode="$(stat --format='%a' -- "$path")"
  links="$(stat --format='%h' -- "$path")"
  [[ "$owner" == "0" && "$group" == "0" && "$links" == "1" ]] \
    || offsite_die "Geschuetzte Offsite-Dateien muessen eindeutige root:root-Dateien sein."
  (( (8#$mode & 077) == 0 )) || offsite_die "Geschuetzte Offsite-Dateien duerfen ausschliesslich root lesbar sein."
  [[ "$maximum_mode" == "600" ]] || offsite_die "Interner Modusvertrag ist ungueltig."
}

offsite_assert_root_executable() {
  local path="$1"
  local metadata mode
  [[ -f "$path" && ! -L "$path" ]] || offsite_die "Eine erforderliche Offsite-Binaerdatei fehlt."
  metadata="$(stat --format='%u:%g:%h' -- "$path")"
  mode="$(stat --format='%a' -- "$path")"
  [[ "$metadata" == "0:0:1" ]] || offsite_die "Offsite-Binaerdateien muessen eindeutige root:root-Dateien sein."
  (( (8#$mode & 022) == 0 && (8#$mode & 0111) != 0 )) \
    || offsite_die "Eine Offsite-Binaerdatei hat unsichere Ausfuehrungsrechte."
}

offsite_assert_runtime_binaries() {
  local restic_pin rclone_pin restic_version rclone_version platform
  local restic_actual rclone_actual
  local -a pins=()

  offsite_assert_installed_contract
  offsite_assert_regular_root_file "$OFFSITE_BINARY_PINS"
  offsite_assert_root_executable "$OFFSITE_RESTIC"
  offsite_assert_root_executable "$OFFSITE_RCLONE"
  offsite_assert_root_executable "$OFFSITE_RCLONE_WRAPPER"

  readarray -t pins < <("$OFFSITE_NODE" - "$OFFSITE_BINARY_PINS" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedKeys = ["format", "platform", "rcloneSha256", "rcloneVersion", "resticSha256", "resticVersion", "schemaVersion"];
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) process.exit(1);
if (value.format !== "grabenplaner-offsite-binary-pins" || value.schemaVersion !== 1 || value.platform !== "linux/amd64") process.exit(1);
if (!/^[a-f0-9]{64}$/.test(value.resticSha256) || !/^[a-f0-9]{64}$/.test(value.rcloneSha256)) process.exit(1);
if (!/^\d+\.\d+\.\d+$/.test(value.resticVersion) || !/^\d+\.\d+\.\d+$/.test(value.rcloneVersion)) process.exit(1);
process.stdout.write(`${value.resticSha256}\n${value.rcloneSha256}\n${value.resticVersion}\n${value.rcloneVersion}\n${value.platform}\n`);
NODE
  ) || offsite_die "Der Beleg der Offsite-Binaerdateien ist ungueltig."
  (( ${#pins[@]} == 5 )) || offsite_die "Der Beleg der Offsite-Binaerdateien ist unvollstaendig."
  restic_pin="${pins[0]}"
  rclone_pin="${pins[1]}"
  restic_version="${pins[2]}"
  rclone_version="${pins[3]}"
  platform="${pins[4]}"
  [[ -n "$restic_version" && -n "$rclone_version" && "$platform" == "linux/amd64" ]] \
    || offsite_die "Der Versionsvertrag der Offsite-Binaerdateien ist ungueltig."

  restic_actual="$(sha256sum --binary -- "$OFFSITE_RESTIC" | awk '{print tolower($1)}')"
  rclone_actual="$(sha256sum --binary -- "$OFFSITE_RCLONE" | awk '{print tolower($1)}')"
  [[ "$restic_actual" == "$restic_pin" && "$rclone_actual" == "$rclone_pin" ]] \
    || offsite_die "Eine Offsite-Binaerdatei stimmt nicht mit dem Installationsbeleg ueberein."
}

offsite_assert_installed_contract() {
  local file="$OFFSITE_CONFIG_ROOT/installed-contract.json"
  offsite_assert_regular_root_file "$file"
  "$OFFSITE_NODE" "$OFFSITE_MODULE_ROOT/lib/offsite-contract.js" verify-installed "$OFFSITE_MODULE_ROOT" "$file" >/dev/null \
    || offsite_die "Das installierte Offsite-Modul stimmt nicht mit seinem Installationsbeleg ueberein."
}

offsite_credentials_directory() {
  local directory="${CREDENTIALS_DIRECTORY:-${GRABENPLANER_OFFSITE_CREDENTIALS_DIR:-}}"
  [[ -n "$directory" && "$directory" == /* && -d "$directory" && ! -L "$directory" ]] \
    || offsite_die "Die geschuetzten systemd-Credentials fehlen."
  printf '%s\n' "$directory"
}

offsite_assert_credentials() {
  local directory="$1"
  local name target
  for name in repository restic-password rclone-config-password repository-id installation-id; do
    target="$directory/$name"
    [[ -f "$target" && ! -L "$target" ]] || offsite_die "Ein erforderliches Offsite-Credential fehlt."
  done
}

offsite_make_uploader_credentials() {
  local source_directory="$1"
  local target_directory name
  offsite_assert_credentials "$source_directory"
  offsite_prepare_run_root
  target_directory="$(mktemp --directory --tmpdir="$OFFSITE_RUN_ROOT" credentials.XXXXXXXX)"
  chown "root:$OFFSITE_GROUP" -- "$target_directory"
  chmod 0750 -- "$target_directory"
  for name in repository restic-password rclone-config-password repository-id installation-id; do
    install -m 0440 -o root -g "$OFFSITE_GROUP" -- "$source_directory/$name" "$target_directory/$name"
  done
  printf '%s\n' "$target_directory"
}

offsite_assert_persistent_rclone_config() {
  local owner group mode links size
  [[ -f "$OFFSITE_RCLONE_CONFIG" && ! -L "$OFFSITE_RCLONE_CONFIG" ]] || offsite_die "Die persistente verschluesselte rclone-Konfiguration fehlt."
  owner="$(stat --format='%U' -- "$OFFSITE_RCLONE_CONFIG")"
  group="$(stat --format='%G' -- "$OFFSITE_RCLONE_CONFIG")"
  mode="$(stat --format='%a' -- "$OFFSITE_RCLONE_CONFIG")"
  links="$(stat --format='%h' -- "$OFFSITE_RCLONE_CONFIG")"
  size="$(stat --format='%s' -- "$OFFSITE_RCLONE_CONFIG")"
  [[ "$owner" == "$OFFSITE_USER" && "$group" == "$OFFSITE_GROUP" && "$mode" == "600" && "$links" == "1" ]] \
    || offsite_die "Die persistente rclone-Konfiguration hat unsichere Rechte."
  [[ "$size" =~ ^[0-9]+$ ]] && (( size >= 16 && size <= 1048576 )) \
    || offsite_die "Die persistente rclone-Konfiguration hat eine unzulaessige Groesse."
}

offsite_assert_group_isolation() {
  local uploader_gid status_gid uploader_primary status_primary uploader_members status_members
  uploader_gid="$(getent group "$OFFSITE_GROUP" | awk -F: '{print $3}')"
  status_gid="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $3}')"
  [[ "$uploader_gid" =~ ^[0-9]+$ && "$status_gid" =~ ^[0-9]+$ && "$uploader_gid" != "$status_gid" ]] \
    || offsite_die "Die Offsite-Gruppenkennungen sind ungueltig."
  uploader_primary="$(getent passwd | awk -F: -v gid="$uploader_gid" '$4==gid {print $1}' | sort | paste -sd, -)"
  status_primary="$(getent passwd | awk -F: -v gid="$status_gid" '$4==gid {print $1}' | sort | paste -sd, -)"
  uploader_members="$(getent group "$OFFSITE_GROUP" | awk -F: '{print $4}' | tr ',' '\n' | sed '/^$/d' | sort | paste -sd, -)"
  status_members="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $4}' | tr ',' '\n' | sed '/^$/d' | sort | paste -sd, -)"
  [[ "$uploader_primary" == "$OFFSITE_USER" && -z "$status_primary" && -z "$uploader_members" \
    && "$status_members" == "$OFFSITE_APP_USER,$OFFSITE_USER" ]] \
    || offsite_die "Eine Offsite-Gruppe enthaelt unerwartete Konten."
}

offsite_installation_host() {
  local credentials="$1"
  local identifier
  identifier="$(tr -d '\r\n' <"$credentials/installation-id")"
  [[ "$identifier" =~ ^[a-f0-9]{32}$ ]] || offsite_die "Die stabile Offsite-Installationskennung ist ungueltig."
  printf 'grabenplaner-%s\n' "$identifier"
}

offsite_remove_uploader_credentials() {
  local target_directory="${1:-}"
  [[ -n "$target_directory" && "$target_directory" == "$OFFSITE_RUN_ROOT/credentials."* ]] || return 1
  [[ -d "$target_directory" && ! -L "$target_directory" ]] || return 0
  rm -rf --one-file-system -- "$target_directory"
}

offsite_prepare_run_root() {
  if [[ -e "$OFFSITE_RUN_ROOT" || -L "$OFFSITE_RUN_ROOT" ]]; then
    [[ -d "$OFFSITE_RUN_ROOT" && ! -L "$OFFSITE_RUN_ROOT" ]] || offsite_die "Das Offsite-Laufzeitverzeichnis ist unsicher."
    chown root:root -- "$OFFSITE_RUN_ROOT"
    chmod 0755 -- "$OFFSITE_RUN_ROOT"
  else
    install -d -m 0755 -o root -g root -- "$OFFSITE_RUN_ROOT"
  fi
}

offsite_acquire_repository_lock() {
  offsite_require_command flock
  offsite_prepare_run_root
  if [[ -e "$OFFSITE_REPOSITORY_LOCK" || -L "$OFFSITE_REPOSITORY_LOCK" ]]; then
    [[ -f "$OFFSITE_REPOSITORY_LOCK" && ! -L "$OFFSITE_REPOSITORY_LOCK" ]] || offsite_die "Die Repository-Sperre ist unsicher."
    chown "$OFFSITE_USER:$OFFSITE_GROUP" -- "$OFFSITE_REPOSITORY_LOCK"
    chmod 0600 -- "$OFFSITE_REPOSITORY_LOCK"
  else
    install -m 0600 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" /dev/null "$OFFSITE_REPOSITORY_LOCK"
  fi
  exec 8<>"$OFFSITE_REPOSITORY_LOCK"
  flock --wait 14400 8 || offsite_die "Ein anderer Offsite-Repository-Vorgang konnte nicht innerhalb des Wartungsfensters abgeschlossen werden."
}

offsite_run_as_uploader() {
  local credentials="$1"
  shift
  runuser --user "$OFFSITE_USER" -- env -i \
    HOME="$OFFSITE_UPLOADER_HOME" USER="$OFFSITE_USER" LOGNAME="$OFFSITE_USER" \
    PATH="$OFFSITE_BIN_ROOT:/usr/bin:/bin" CREDENTIALS_DIRECTORY="$credentials" \
    "$@"
}

offsite_restic() {
  local credentials="$1"
  shift
  # Direkt vor jedem Repositoryzugriff werden sowohl der Modulvertrag (inklusive
  # rclone-Wrapper) als auch die separat gepinnten Binaerdateien fail-closed
  # geprueft. Erst danach erfolgt der Privilegabwurf zum Uploaderkonto.
  offsite_assert_runtime_binaries
  offsite_run_as_uploader "$credentials" "$OFFSITE_RESTIC" \
    --repository-file "$credentials/repository" \
    --password-file "$credentials/restic-password" \
    --retry-lock 15m \
    -o "rclone.program=$OFFSITE_RCLONE_WRAPPER" \
    "$@"
}

offsite_verify_repository_identity() {
  local credentials="$1"
  local config_file="$2"
  local actual expected
  if ! offsite_restic "$credentials" cat config >"$config_file" 2>/dev/null; then
    return 1
  fi
  actual="$("$OFFSITE_NODE" -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[a-f0-9]{16,64}$/i.test(String(value.id||"")))process.exit(1);process.stdout.write(String(value.id).toLowerCase())' "$config_file")" || return 1
  expected="$(tr -d '\r\n' <"$credentials/repository-id")"
  [[ "$expected" =~ ^[a-f0-9]{16,64}$ && "$actual" == "$expected" ]]
}

offsite_status() {
  local status_gid
  offsite_require_root
  status_gid="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $3}')"
  [[ "$status_gid" =~ ^[0-9]+$ ]] || offsite_die "Die Offsite-Statusgruppe konnte nicht sicher aufgeloest werden."
  "$OFFSITE_NODE" "$OFFSITE_STATUS_HELPER" --status-file "$OFFSITE_STATUS_FILE" --status-gid "$status_gid" "$@"
}

offsite_fixed_failure() {
  local code="$1"
  local summary="$2"
  offsite_status failure --code "$code" --summary "$summary" >/dev/null || true
  offsite_die "$summary"
}

#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

usage() {
  cat <<'EOF'
Verwendung: sudo ./install-grabenplaner-offsite.sh [Optionen]

  --restic PFAD                    lokal bereitgestellte restic-Binaerdatei
  --restic-sha256 SHA256           erwartete SHA-256-Pruefsumme
  --rclone PFAD                    lokal bereitgestellte rclone-Binaerdatei
  --rclone-sha256 SHA256           erwartete SHA-256-Pruefsumme
  --restic-password PFAD           root-only Restic-Passwortdatei
  --rclone-config PFAD             verschluesselte rclone-Konfiguration
  --rclone-config-password PFAD    root-only Konfigurationspasswort
  --repository rclone:REMOTE:PFAD  direktes Restic-rclone-Repository
  --initialize-repository          nur ein noch leeres Repository initialisieren
EOF
}

restic_source=""
restic_sha256=""
rclone_source=""
rclone_sha256=""
restic_password_source=""
rclone_config_source=""
rclone_password_source=""
repository=""
initialize_repository=0
while (($#)); do
  case "$1" in
    --restic) restic_source="${2:?Wert fehlt}"; shift 2 ;;
    --restic-sha256) restic_sha256="${2:?Wert fehlt}"; shift 2 ;;
    --rclone) rclone_source="${2:?Wert fehlt}"; shift 2 ;;
    --rclone-sha256) rclone_sha256="${2:?Wert fehlt}"; shift 2 ;;
    --restic-password) restic_password_source="${2:?Wert fehlt}"; shift 2 ;;
    --rclone-config) rclone_config_source="${2:?Wert fehlt}"; shift 2 ;;
    --rclone-config-password) rclone_password_source="${2:?Wert fehlt}"; shift 2 ;;
    --repository) repository="${2:?Wert fehlt}"; shift 2 ;;
    --initialize-repository) initialize_repository=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) offsite_die "Unbekannte Option: $1" ;;
  esac
done

offsite_require_root
for command_name in awk chown chmod cmp cp curl cut dirname find flock getent gpasswd grep groupadd groupdel id install ln mktemp mv openssl paste readlink realpath rm runuser sed sha256sum sleep sort stat systemctl tr useradd usermod wc; do
  offsite_require_command "$command_name"
done
[[ -x "$OFFSITE_NODE" ]] || offsite_die "Node.js muss unter /usr/bin/node installiert sein."
os_release_source="$(realpath --canonicalize-existing -- /etc/os-release)" \
  || offsite_die "Ubuntu konnte nicht sicher erkannt werden."
case "$os_release_source" in
  /etc/os-release|/usr/lib/os-release) ;;
  *) offsite_die "Ubuntu verwendet einen unerwarteten Systempfad." ;;
esac
[[ -f "$os_release_source" && ! -L "$os_release_source" ]] \
  || offsite_die "Ubuntu konnte nicht sicher erkannt werden."
[[ "$(stat --format='%u:%g:%h' -- "$os_release_source")" == "0:0:1" ]] \
  || offsite_die "Die Ubuntu-Systemkennung hat unsichere Besitzrechte."
os_release_mode="$(stat --format='%a' -- "$os_release_source")"
(( (8#$os_release_mode & 022) == 0 )) \
  || offsite_die "Die Ubuntu-Systemkennung darf nicht durch Gruppe oder andere Benutzer beschreibbar sein."
# shellcheck disable=SC1091
source "$os_release_source"
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" =~ ^(24\.04|26\.04)$ ]] \
  || offsite_die "Unterstuetzt werden Ubuntu 24.04 LTS und Ubuntu 26.04 LTS."
systemctl show-environment >/dev/null 2>&1 || offsite_die "Ein aktives systemd wird benoetigt."
[[ -d "$OFFSITE_APP_ROOT" && ! -L "$OFFSITE_APP_ROOT" && -f "$OFFSITE_APP_ENV" && ! -L "$OFFSITE_APP_ENV" ]] \
  || offsite_die "Zuerst muss der Grabenplaner-Ubuntu-Server installiert werden."
recovery_command="$OFFSITE_APP_ROOT/server-tools/linux/recovery/grabenplaner-recovery.sh"
[[ -f "$recovery_command" && ! -L "$recovery_command" ]] || offsite_die "Der ueberwachte Recovery-Befehl fehlt im installierten Serverpaket."
recovery_command_mode="$(stat --format='%a' -- "$recovery_command")"
[[ "$(stat --format='%u:%h' -- "$recovery_command")" == "0:1" && $((8#$recovery_command_mode & 022)) -eq 0 \
  && $((8#$recovery_command_mode & 0111)) -ne 0 ]] || offsite_die "Der Recovery-Befehl hat unsichere Dateirechte."

secure_source() {
  local source="$1" label="$2" strict_secret="${3:-0}" resolved owner group mode links
  [[ -n "$source" && "$source" == /* ]] || offsite_die "$label muss ein absoluter lokaler Pfad sein."
  resolved="$(realpath --canonicalize-existing -- "$source")" || offsite_die "$label wurde nicht gefunden."
  [[ -f "$resolved" && ! -L "$resolved" ]] || offsite_die "$label muss eine regulaere Datei sein."
  owner="$(stat --format='%u' -- "$resolved")"
  group="$(stat --format='%g' -- "$resolved")"
  mode="$(stat --format='%a' -- "$resolved")"
  links="$(stat --format='%h' -- "$resolved")"
  [[ "$owner" == "0" && "$group" == "0" && "$links" == "1" ]] \
    || offsite_die "$label muss eine eindeutige root:root-Datei sein."
  if (( strict_secret == 1 )); then
    [[ "$mode" == "600" ]] || offsite_die "$label muss exakt Modus 0600 verwenden."
  else
    (( (8#$mode & 022) == 0 )) || offsite_die "$label darf nicht durch Gruppe oder andere Benutzer beschreibbar sein."
  fi
  printf '%s\n' "$resolved"
}

restic_source="$(secure_source "$restic_source" "restic-Binaerdatei")"
rclone_source="$(secure_source "$rclone_source" "rclone-Binaerdatei")"
restic_password_source="$(secure_source "$restic_password_source" "Restic-Passwortdatei" 1)"
rclone_config_source="$(secure_source "$rclone_config_source" "rclone-Konfiguration" 1)"
rclone_password_source="$(secure_source "$rclone_password_source" "rclone-Konfigurationspasswort" 1)"
[[ "$restic_sha256" =~ ^[a-fA-F0-9]{64}$ && "$rclone_sha256" =~ ^[a-fA-F0-9]{64}$ ]] \
  || offsite_die "Beide Binaerdateien benoetigen eine gueltige SHA-256-Pruefsumme."
restic_sha256="${restic_sha256,,}"
rclone_sha256="${rclone_sha256,,}"
[[ "$(sha256sum --binary -- "$restic_source" | awk '{print tolower($1)}')" == "$restic_sha256" ]] \
  || offsite_die "Die restic-Pruefsumme stimmt nicht."
[[ "$(sha256sum --binary -- "$rclone_source" | awk '{print tolower($1)}')" == "$rclone_sha256" ]] \
  || offsite_die "Die rclone-Pruefsumme stimmt nicht."

readarray -t repository_values < <("$OFFSITE_NODE" - "$repository" <<'NODE'
const value = String(process.argv[2] || "");
const match = value.match(/^rclone:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([A-Za-z0-9][A-Za-z0-9._/-]{0,511})$/);
if (!match || match[2].split("/").some((part) => !part || part === "." || part === "..")) process.exit(1);
const parts = match[2].split("/");
const leaf = parts.pop();
process.stdout.write(`${value}\n${match[1]}\n${match[2]}\n${parts.join("/")}\n${leaf}\n`);
NODE
) || offsite_die "Das Repository muss ein sicherer direkter rclone-Pfad sein."
repository="${repository_values[0]:-}"
rclone_remote="${repository_values[1]:-}"
repository_path="${repository_values[2]:-}"
repository_parent="${repository_values[3]:-}"
repository_leaf="${repository_values[4]:-}"
[[ -n "$repository" && -n "$rclone_remote" && -n "$repository_path" && -n "$repository_leaf" ]] || offsite_die "Das Repository ist ungueltig."

"$OFFSITE_NODE" - "$restic_password_source" "$rclone_config_source" "$rclone_password_source" <<'NODE' \
  || offsite_die "Eine Offsite-Geheimdatei ist ungueltig."
const fs = require("node:fs");
const [restic, config, password] = process.argv.slice(2);
const read = (file, min, max) => {
  const value = fs.readFileSync(file);
  if (value.length < min || value.length > max || value.includes(0)) process.exit(1);
  return value;
};
const resticValue = read(restic, 16, 4096).toString("utf8");
const resticLine = resticValue.endsWith("\n") ? resticValue.slice(0, -1) : resticValue;
if (Buffer.byteLength(resticLine, "utf8") < 16 || /[\r\n]/.test(resticLine)) process.exit(1);
const configValue = read(config, 32, 1024 * 1024).toString("utf8");
// rclone may prepend its official explanatory comment to an encrypted config.
// Permit only blank/comment lines before the marker; arbitrary clear text stays rejected.
if (!/^(?:(?:[ \t]*#[^\r\n]*|[ \t]*)\r?\n)*RCLONE_ENCRYPT_V0:/.test(configValue)) process.exit(1);
const passwordValue = read(password, 16, 1024).toString("utf8");
if (/\r|\n/.test(passwordValue.trimEnd()) || !passwordValue.trim()) process.exit(1);
NODE

if ! getent group "$OFFSITE_GROUP" >/dev/null; then groupadd --system "$OFFSITE_GROUP"; fi
if ! getent group "$OFFSITE_STATUS_GROUP" >/dev/null; then groupadd --system "$OFFSITE_STATUS_GROUP"; fi
if ! getent passwd "$OFFSITE_USER" >/dev/null; then
  useradd --system --gid "$OFFSITE_GROUP" --home-dir "$OFFSITE_STATE_ROOT" --shell /usr/sbin/nologin "$OFFSITE_USER"
fi
[[ "$(id -gn "$OFFSITE_USER")" == "$OFFSITE_GROUP" && "$(getent passwd "$OFFSITE_USER" | cut -d: -f6-7)" == "$OFFSITE_STATE_ROOT:/usr/sbin/nologin" ]] \
  || offsite_die "Der vorhandene Offsite-Dienstbenutzer weicht vom Sicherheitsvertrag ab."
getent passwd "$OFFSITE_APP_USER" >/dev/null || offsite_die "Der Grabenplaner-Dienstbenutzer fehlt."
usermod --groups "$OFFSITE_STATUS_GROUP" "$OFFSITE_USER"
usermod --append --groups "$OFFSITE_STATUS_GROUP" "$OFFSITE_APP_USER"
[[ "$(id -Gn "$OFFSITE_USER")" == "$OFFSITE_GROUP $OFFSITE_STATUS_GROUP" \
  || "$(id -Gn "$OFFSITE_USER")" == "$OFFSITE_STATUS_GROUP $OFFSITE_GROUP" ]] \
  || offsite_die "Der Offsite-Dienstbenutzer besitzt unerwartete Zusatzgruppen."
offsite_assert_group_isolation

assert_existing_directory() {
  local path="$1" expected_uid="$2" expected_gid="$3" expected_mode="$4"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || offsite_die "Ein fester Offsite-Pfad ist kein sicheres Verzeichnis: $path"
    [[ "$(stat --format='%u:%g:%a' -- "$path")" == "$expected_uid:$expected_gid:$expected_mode" ]] \
      || offsite_die "Ein vorhandenes Offsite-Verzeichnis weicht vom Rechtevertrag ab: $path"
  fi
}

offsite_uid="$(id -u "$OFFSITE_USER")"
offsite_gid="$(getent group "$OFFSITE_GROUP" | awk -F: '{print $3}')"
status_gid="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $3}')"
app_uid="$(id -u "$OFFSITE_APP_USER")"
app_gid="$(getent group "$OFFSITE_APP_GROUP" | awk -F: '{print $3}')"
backup_root_contract="$(stat --format='%u:%g:%a' -- "$OFFSITE_BACKUP_ROOT" 2>/dev/null || true)"
[[ "$offsite_uid" =~ ^[0-9]+$ && "$offsite_gid" =~ ^[0-9]+$ && "$status_gid" =~ ^[0-9]+$ \
  && "$app_uid" =~ ^[0-9]+$ && "$app_gid" =~ ^[0-9]+$ ]] || offsite_die "Die Dienstkonten konnten nicht sicher aufgeloest werden."

[[ -d /opt && ! -L /opt && -d /var/lib && ! -L /var/lib && -d /etc/grabenplaner && ! -L /etc/grabenplaner \
  && -d "$OFFSITE_DATA_ROOT" && ! -L "$OFFSITE_DATA_ROOT" && -d "$OFFSITE_BACKUP_ROOT" && ! -L "$OFFSITE_BACKUP_ROOT" ]] \
  || offsite_die "Ein benoetigter Server-Basispfad ist unsicher."
configuration_directory_ok=0
configuration_directory_contract="$(stat --format='%u:%g:%a' -- /etc/grabenplaner)"
if [[ "$configuration_directory_contract" == "0:0:700" ]]; then
  configuration_directory_ok=1
elif [[ "$configuration_directory_contract" == "0:$app_gid:750" ]] \
  && "$OFFSITE_NODE" - "$OFFSITE_APP_ROOT" "$OFFSITE_APP_ENV" "$app_gid" <<'NODE'
const fs = require('node:fs');
const [root, env, group] = process.argv.slice(2);
const configuration = require('node:util').parseEnv(fs.readFileSync(env, 'utf8'));
if (configuration.DB_PROVIDER !== 'postgresql') process.exit(1);
const C = require(root + '/lib/persistence/postgresql/productive-configuration');
C.resolveDocument(C.readProtectedJson(C.FILE, { gid: Number(group) }), C.readProtectedJson(C.ANCHOR, { gid: Number(group) }));
NODE
then
  configuration_directory_ok=1
fi
[[ "$configuration_directory_ok" == 1 \
  && "$(stat --format='%u:%g:%a' -- "$OFFSITE_DATA_ROOT")" == "$app_uid:$app_gid:750" \
  && ( "$backup_root_contract" == "$app_uid:$app_gid:700" \
    || "$backup_root_contract" == "$app_uid:$app_gid:750" ) ]] \
  || offsite_die "Ein benoetigter Server-Basispfad weicht vom Rechtevertrag ab."

assert_existing_directory "$OFFSITE_ROOT" 0 0 755
assert_existing_directory "$OFFSITE_BIN_ROOT" 0 0 755
assert_existing_directory "$OFFSITE_STATE_ROOT" 0 "$status_gid" 750
assert_existing_directory "$OFFSITE_STAGE_ROOT" 0 "$offsite_gid" 750
assert_existing_directory "$OFFSITE_RESTORE_ROOT" 0 "$offsite_gid" 750
assert_existing_directory "$OFFSITE_RECOVERY_SET_ROOT" 0 0 700
assert_existing_directory "$OFFSITE_CREDENTIAL_STATE_ROOT" "$offsite_uid" "$offsite_gid" 700
assert_existing_directory "$OFFSITE_UPLOADER_HOME" "$offsite_uid" "$offsite_gid" 700
assert_existing_directory "$OFFSITE_CONFIG_ROOT" 0 0 700
assert_existing_directory "$OFFSITE_MODULE_ROOT" 0 0 755
assert_existing_directory "$OFFSITE_MAINTENANCE_SCHEDULE_ROOT" 0 0 700

maintenance_schedule_dropin_dirs=(
  /etc/systemd/system/grabenplaner-monitor.timer.d
  /etc/systemd/system/grabenplaner-offsite-assurance.timer.d
  /etc/systemd/system/grabenplaner-offsite-check.timer.d
  /etc/systemd/system/grabenplaner-offsite-restore-test.timer.d
  /etc/systemd/system/grabenplaner-host-security-audit.timer.d
)
for schedule_dropin_dir in "${maintenance_schedule_dropin_dirs[@]}"; do
  assert_existing_directory "$schedule_dropin_dir" 0 0 755
  schedule_dropin_file="$schedule_dropin_dir/20-grabenplaner-schedule.conf"
  if [[ -e "$schedule_dropin_file" || -L "$schedule_dropin_file" ]]; then
    [[ -f "$schedule_dropin_file" && ! -L "$schedule_dropin_file" \
      && "$(stat --format='%u:%g:%a:%h' -- "$schedule_dropin_file")" == "0:0:644:1" ]] \
      || offsite_die "Ein vorhandener Wartungszeitplan ist unsicher: $schedule_dropin_file"
  fi
done

for config_name in repository repository-id installation-id restic-password rclone-config-password installed-contract.json binary-pins.json; do
  config_path="$OFFSITE_CONFIG_ROOT/$config_name"
  if [[ -e "$config_path" || -L "$config_path" ]]; then
    [[ -f "$config_path" && ! -L "$config_path" \
      && "$(stat --format='%u:%g:%a:%h' -- "$config_path")" == "0:0:600:1" ]] \
      || offsite_die "Eine vorhandene Offsite-Konfigurationsdatei ist unsicher."
  fi
done

if [[ ! -d "$OFFSITE_MODULE_ROOT" || -L "$OFFSITE_MODULE_ROOT" ]]; then
  for stale_path in "$OFFSITE_RESTIC" "$OFFSITE_RCLONE" "$OFFSITE_LEGACY_RCLONE_WRAPPER" \
    "$OFFSITE_CONFIG_ROOT/installed-contract.json" "$OFFSITE_CONFIG_ROOT/binary-pins.json"; do
    [[ ! -e "$stale_path" && ! -L "$stale_path" ]] \
      || offsite_die "Ungebundene Offsite-Installationsdateien wurden gefunden."
  done
fi

if [[ -e "$OFFSITE_RCLONE_CONFIG" || -L "$OFFSITE_RCLONE_CONFIG" ]]; then
  offsite_assert_persistent_rclone_config
fi

status_configured_before=0
if [[ -e "$OFFSITE_STATUS_FILE" || -L "$OFFSITE_STATUS_FILE" ]]; then
  [[ -f "$OFFSITE_STATUS_FILE" && ! -L "$OFFSITE_STATUS_FILE" \
    && "$(stat --format='%u:%g:%a:%h' -- "$OFFSITE_STATUS_FILE")" == "0:$status_gid:640:1" ]] \
    || offsite_die "Der vorhandene Offsite-Status ist unsicher."
  status_inspection="$("$OFFSITE_NODE" "$SCRIPT_DIR/lib/offsite-status.js" --status-file "$OFFSITE_STATUS_FILE" --status-gid "$status_gid" inspect)" \
    || offsite_die "Der vorhandene Offsite-Status ist ungueltig."
  status_configured_before="$("$OFFSITE_NODE" -e 'const v=JSON.parse(process.argv[1]);if(v.ok!==true||typeof v.configured!=="boolean")process.exit(1);process.stdout.write(v.configured?"1":"0")' "$status_inspection")" \
    || offsite_die "Der vorhandene Offsite-Status ist ungueltig."
fi

installed_module_version=0
if [[ -e "$OFFSITE_MODULE_ROOT" || -L "$OFFSITE_MODULE_ROOT" ]]; then
  offsite_assert_regular_root_file "$OFFSITE_CONFIG_ROOT/installed-contract.json"
  "$OFFSITE_NODE" "$SCRIPT_DIR/lib/offsite-contract.js" verify-installed \
    "$OFFSITE_MODULE_ROOT" "$OFFSITE_CONFIG_ROOT/installed-contract.json" >/dev/null \
    || offsite_die "Das vorhandene Offsite-Modul stimmt nicht mit seinem Installationsbeleg ueberein."
  installed_module_version="$("$OFFSITE_NODE" - "$OFFSITE_CONFIG_ROOT/installed-contract.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(value.moduleVersion)) process.exit(1);
process.stdout.write(String(value.moduleVersion));
NODE
)" || offsite_die "Die installierte Offsite-Modulversion ist nicht migrationsfaehig."
fi

install -d -m 0755 -o root -g root -- "$OFFSITE_ROOT" "$OFFSITE_BIN_ROOT"
install -d -m 0750 -o root -g "$OFFSITE_STATUS_GROUP" -- "$OFFSITE_STATE_ROOT"
install -d -m 0750 -o root -g "$OFFSITE_GROUP" -- "$OFFSITE_STAGE_ROOT" "$OFFSITE_RESTORE_ROOT"
install -d -m 0700 -o root -g root -- "$OFFSITE_RECOVERY_SET_ROOT"
install -d -m 0700 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" -- "$OFFSITE_CREDENTIAL_STATE_ROOT" "$OFFSITE_UPLOADER_HOME"
install -d -m 0700 -o root -g root -- "$OFFSITE_CONFIG_ROOT"
install -d -m 0700 -o root -g root -- "$OFFSITE_MAINTENANCE_SCHEDULE_ROOT"
for schedule_dropin_dir in "${maintenance_schedule_dropin_dirs[@]}"; do
  install -d -m 0755 -o root -g root -- "$schedule_dropin_dir"
done
offsite_prepare_run_root

contract_receipt="$(mktemp --tmpdir="$OFFSITE_RUN_ROOT" module-contract.XXXXXXXX)"
module_candidate="$(mktemp --directory --tmpdir="$OFFSITE_ROOT" .module.XXXXXXXX)"
setup_credentials=""
operation_root=""
module_previous=""
rclone_previous=""
rollback_root=""
commit_started=0
restic_had_original=0
rclone_had_original=0
legacy_wrapper_had_original=0
recovery_command_had_original=0
rebind_command_had_original=0
assurance_command_had_original=0
recovery_set_command_had_original=0
assurance_root_had_original=0
assurance_root_initialized=0
config_had_original=0
status_had_original=0
declare -a timer_was_enabled=(0 0 0 0)
declare -a timer_was_active=(0 0 0 0)
timers_paused=0
control_group_created=0
control_member_added=0
control_socket="grabenplaner-offsite-assurance-control.socket"
control_socket_was_enabled=0
control_socket_was_active=0
control_socket_paused=0
target_control_socket="grabenplaner-offsite-target-control.socket"
target_control_socket_was_enabled=0
target_control_socket_was_active=0
target_control_socket_paused=0
setup_complete=0
app_restart_started=0
app_groups_before="$(id -G -- "$OFFSITE_APP_USER")"
rollback_control_group() {
  (( setup_complete == 0 )) || return 0
  if (( control_member_added == 1 || control_group_created == 1 )) && getent group "$OFFSITE_CONTROL_GROUP" >/dev/null; then
    gpasswd --delete "$OFFSITE_APP_USER" "$OFFSITE_CONTROL_GROUP" >/dev/null 2>&1 || true
    control_member_added=0
  fi
  if (( control_group_created == 1 )) && getent group "$OFFSITE_CONTROL_GROUP" >/dev/null; then
    control_gid="$(getent group "$OFFSITE_CONTROL_GROUP" | awk -F: '{print $3}')"
    control_primary="$(getent passwd | awk -F: -v gid="$control_gid" '$4==gid {print $1}' | sort | paste -sd, -)"
    control_members="$(getent group "$OFFSITE_CONTROL_GROUP" | awk -F: '{print $4}' | tr ',' '\n' | sed '/^$/d' | sort | paste -sd, -)"
    [[ -z "$control_primary" && -z "$control_members" ]] \
      || offsite_die "Die neu angelegte Recovery-Assurance-Steuerungsgruppe konnte nicht sicher zurueckgerollt werden."
    groupdel "$OFFSITE_CONTROL_GROUP"
    control_group_created=0
  fi
}
cleanup() {
  local status=$?
  if (( setup_complete == 0 && commit_started == 1 )); then
    for unit in 'grabenplaner-offsite-target-control@*.service' grabenplaner-offsite-target-control.socket \
      'grabenplaner-offsite-assurance-control@*.service' grabenplaner-offsite-assurance-control.socket \
      'grabenplaner-offsite-assurance@*.service' \
      grabenplaner-offsite-assurance.timer grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer \
      grabenplaner-offsite-application-smoke.service grabenplaner-offsite-upload.service grabenplaner-offsite-prepare.service grabenplaner-offsite-check.service grabenplaner-offsite-restore-test.service; do
      systemctl disable --now "$unit" >/dev/null 2>&1 || true
    done
    if [[ -z "$module_previous" ]]; then
      declare -A rollback_commands=(
        [grabenplaner-offsite-assurance]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-assurance.sh"
        [grabenplaner-offsite-pre-update]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-pre-update.sh"
        [grabenplaner-offsite-prepare]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-prepare.sh"
        [grabenplaner-offsite-recovery-set]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-recovery-set.sh"
        [grabenplaner-offsite-rebind-rclone]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-rebind-rclone.sh"
        [grabenplaner-offsite-test]="$OFFSITE_MODULE_ROOT/test-grabenplaner-offsite.sh"
        [grabenplaner-offsite-uninstall]="$OFFSITE_MODULE_ROOT/uninstall-grabenplaner-offsite.sh"
        [grabenplaner-recovery]="$recovery_command"
      )
      for command_name in "${!rollback_commands[@]}"; do
        command_path="/usr/local/sbin/$command_name"
        if [[ -L "$command_path" && "$(readlink -- "$command_path")" == "${rollback_commands[$command_name]}" ]]; then
          rm -f -- "$command_path"
        fi
      done
    fi
    if (( recovery_command_had_original == 0 )); then
      recovery_link="/usr/local/sbin/grabenplaner-recovery"
      if [[ -L "$recovery_link" && "$(readlink -- "$recovery_link")" == "$recovery_command" ]]; then rm -f -- "$recovery_link"; fi
    fi
    [[ -d "$OFFSITE_MODULE_ROOT" && ! -L "$OFFSITE_MODULE_ROOT" ]] && rm -rf --one-file-system -- "$OFFSITE_MODULE_ROOT"
    if [[ -n "$module_previous" && -d "$module_previous" && ! -L "$module_previous" ]]; then mv -T -- "$module_previous" "$OFFSITE_MODULE_ROOT"; fi
    rebind_link="/usr/local/sbin/grabenplaner-offsite-rebind-rclone"
    if (( rebind_command_had_original == 0 )) && [[ -L "$rebind_link" \
      && "$(readlink -- "$rebind_link")" == "$OFFSITE_MODULE_ROOT/grabenplaner-offsite-rebind-rclone.sh" ]]; then
      rm -f -- "$rebind_link"
    fi
    assurance_link="/usr/local/sbin/grabenplaner-offsite-assurance"
    if (( assurance_command_had_original == 0 )) && [[ -L "$assurance_link" \
      && "$(readlink -- "$assurance_link")" == "$OFFSITE_MODULE_ROOT/grabenplaner-offsite-assurance.sh" ]]; then
      rm -f -- "$assurance_link"
    fi
    recovery_set_link="/usr/local/sbin/grabenplaner-offsite-recovery-set"
    if (( recovery_set_command_had_original == 0 )) && [[ -L "$recovery_set_link" \
      && "$(readlink -- "$recovery_set_link")" == "$OFFSITE_MODULE_ROOT/grabenplaner-offsite-recovery-set.sh" ]]; then
      rm -f -- "$recovery_set_link"
    fi
    for entry in "restic:$OFFSITE_RESTIC:$restic_had_original" "rclone:$OFFSITE_RCLONE:$rclone_had_original" "legacy-wrapper:$OFFSITE_LEGACY_RCLONE_WRAPPER:$legacy_wrapper_had_original"; do
      IFS=: read -r backup_name target had_original <<<"$entry"
      if (( had_original == 1 )); then install -m 0755 -o root -g root -- "$rollback_root/$backup_name" "$target"; else rm -f -- "$target"; fi
    done
    if [[ -n "$rclone_previous" && -f "$rclone_previous" && ! -L "$rclone_previous" ]]; then
      mv -f -- "$rclone_previous" "$OFFSITE_RCLONE_CONFIG"
      chown "$OFFSITE_USER:$OFFSITE_GROUP" -- "$OFFSITE_RCLONE_CONFIG"
      chmod 0600 -- "$OFFSITE_RCLONE_CONFIG"
    elif (( config_had_original == 0 )); then
      rm -f -- "$OFFSITE_RCLONE_CONFIG"
    fi
    rm -rf --one-file-system -- "$OFFSITE_CONFIG_ROOT"
    install -d -m 0700 -o root -g root -- "$OFFSITE_CONFIG_ROOT"
    if (( config_had_original == 1 )); then cp --archive -- "$rollback_root/config/." "$OFFSITE_CONFIG_ROOT/"; fi
    for unit_name in grabenplaner-offsite-target-control.socket 'grabenplaner-offsite-target-control@.service' \
      grabenplaner-offsite-assurance-control.socket 'grabenplaner-offsite-assurance-control@.service' \
      'grabenplaner-offsite-assurance@.service' grabenplaner-offsite-assurance.timer \
      grabenplaner-offsite-application-smoke.service \
      grabenplaner-offsite-prepare.service grabenplaner-offsite-upload.service grabenplaner-offsite-upload.timer \
      grabenplaner-offsite-check.service grabenplaner-offsite-check.timer \
      grabenplaner-offsite-restore-test.service grabenplaner-offsite-restore-test.timer; do
      rm -f -- "/etc/systemd/system/$unit_name"
    done
    if [[ -d "$rollback_root/units" ]]; then cp --archive -- "$rollback_root/units/." /etc/systemd/system/; fi
    install -m 0600 -o root -g root -- "$rollback_root/grabenplaner.env" "$OFFSITE_APP_ENV"
    if (( status_had_original == 1 )); then
      install -m 0640 -o root -g "$OFFSITE_STATUS_GROUP" -- "$rollback_root/status.json" "$OFFSITE_STATUS_FILE"
    else
      rm -f -- "$OFFSITE_STATUS_FILE"
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    rollback_control_group
    if (( app_restart_started == 1 )) && ! (gp_stop_service "$OFFSITE_APP_SERVICE" 150 && gp_start_service "$OFFSITE_APP_SERVICE") >/dev/null 2>&1; then
      offsite_warn "Der bisherige App-Dienst konnte nach dem Modul-Rollback nicht kontrolliert gestartet werden."
    fi
  fi
  rollback_control_group
  if (( setup_complete == 0 && timers_paused == 1 )); then
    systemctl daemon-reload >/dev/null 2>&1 || true
    timers=(grabenplaner-offsite-assurance.timer grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer)
    for index in 0 1 2 3; do
      (( timer_was_enabled[index] == 1 )) && systemctl enable "${timers[index]}" >/dev/null 2>&1 || true
      (( timer_was_active[index] == 1 )) && systemctl start "${timers[index]}" >/dev/null 2>&1 || true
    done
  fi
  if (( setup_complete == 0 && control_socket_paused == 1 )); then
    systemctl daemon-reload >/dev/null 2>&1 || true
    (( control_socket_was_enabled == 1 )) && systemctl enable "$control_socket" >/dev/null 2>&1 || true
    (( control_socket_was_active == 1 )) && systemctl start "$control_socket" >/dev/null 2>&1 || true
  fi
  if (( setup_complete == 0 && target_control_socket_paused == 1 )); then
    systemctl daemon-reload >/dev/null 2>&1 || true
    (( target_control_socket_was_enabled == 1 )) && systemctl enable "$target_control_socket" >/dev/null 2>&1 || true
    (( target_control_socket_was_active == 1 )) && systemctl start "$target_control_socket" >/dev/null 2>&1 || true
  fi
  [[ -f "$contract_receipt" && ! -L "$contract_receipt" ]] && rm -f -- "$contract_receipt"
  [[ -n "$setup_credentials" ]] && offsite_remove_uploader_credentials "$setup_credentials" 2>/dev/null || true
  [[ -n "$operation_root" && -d "$operation_root" && ! -L "$operation_root" ]] && rm -rf --one-file-system -- "$operation_root"
  [[ -d "$module_candidate" && ! -L "$module_candidate" ]] && rm -rf --one-file-system -- "$module_candidate"
  if (( setup_complete == 0 && assurance_root_initialized == 1 && assurance_root_had_original == 0 )) \
    && [[ -d "$OFFSITE_ASSURANCE_ROOT" && ! -L "$OFFSITE_ASSURANCE_ROOT" ]]; then
    rm -rf --one-file-system -- "$OFFSITE_ASSURANCE_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT

# Module v6 adds the isolated target-control broker without changing credentials,
# repository contents or signed history. Existing verified v1 through v5 modules
# are migrated transactionally.
if (( installed_module_version >= 1 && installed_module_version <= 5 )); then
  offsite_info "Das verifizierte Offsite-Modul v${installed_module_version} wird kontrolliert auf v6 migriert."
fi
if (( installed_module_version >= 6 && installed_module_version <= 10 )); then
  offsite_info "Das verifizierte Offsite-Modul v${installed_module_version} wird kontrolliert auf v11 mit geschützter Zeitplansteuerung migriert."
fi
if getent group "$OFFSITE_CONTROL_GROUP" >/dev/null; then
  control_gid="$(getent group "$OFFSITE_CONTROL_GROUP" | awk -F: '{print $3}')"
  control_primary="$(getent passwd | awk -F: -v gid="$control_gid" '$4==gid {print $1}' | sort | paste -sd, -)"
  control_members="$(getent group "$OFFSITE_CONTROL_GROUP" | awk -F: '{print $4}' | tr ',' '\n' | sed '/^$/d' | sort | paste -sd, -)"
  [[ -z "$control_primary" && ( -z "$control_members" || "$control_members" == "$OFFSITE_APP_USER" ) ]] \
    || offsite_die "Die vorhandene Recovery-Assurance-Steuerungsgruppe enthaelt unerwartete Konten."
else
  control_group_created=1
  groupadd --system "$OFFSITE_CONTROL_GROUP"
  control_members=""
fi
if [[ "$control_members" != "$OFFSITE_APP_USER" ]]; then
  control_member_added=1
  usermod --append --groups "$OFFSITE_CONTROL_GROUP" "$OFFSITE_APP_USER"
fi
offsite_assert_control_group_isolation

"$OFFSITE_NODE" "$SCRIPT_DIR/lib/offsite-contract.js" contract "$SCRIPT_DIR" >"$contract_receipt" \
  || offsite_die "Der Offsite-Modulvertrag konnte nicht verifiziert werden."
chmod 0600 -- "$contract_receipt"
cp --preserve=mode,timestamps -- "$SCRIPT_DIR/module-schema.json" "$module_candidate/module-schema.json"
while IFS= read -r relative; do
  [[ -n "$relative" && "$relative" != /* && "$relative" != *".."* ]] || offsite_die "Der Modulvertrag enthaelt einen ungueltigen Pfad."
  install -d -m 0755 -o root -g root -- "$module_candidate/$(dirname -- "$relative")"
  mode=0644
  [[ "$relative" == *.sh ]] && mode=0755
  install -m "$mode" -o root -g root -- "$SCRIPT_DIR/$relative" "$module_candidate/$relative"
done < <("$OFFSITE_NODE" -e 'const fs=require("node:fs");for(const x of JSON.parse(fs.readFileSync(process.argv[1],"utf8")).files)console.log(x.path)' "$contract_receipt")
chown -R root:root -- "$module_candidate"
chmod 0755 -- "$module_candidate"

operation_root="$(mktemp --directory --tmpdir="$OFFSITE_RUN_ROOT" setup.XXXXXXXX)"
chown "root:$OFFSITE_GROUP" -- "$operation_root"
chmod 0750 -- "$operation_root"
install -d -m 0700 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" -- "$operation_root/config"
install -m 0755 -o root -g root -- "$restic_source" "$operation_root/restic"
install -m 0755 -o root -g root -- "$rclone_source" "$operation_root/rclone"
install -m 0755 -o root -g root -- "$SCRIPT_DIR/grabenplaner-offsite-read-secret.sh" "$operation_root/read-secret"
install -m 0755 -o root -g root -- "$SCRIPT_DIR/lib/offsite-setup-rclone-wrapper.sh" "$operation_root/rclone-wrapper"
install -m 0600 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" -- "$rclone_config_source" "$operation_root/config/rclone.conf"

restic_version_output="$operation_root/restic-version.txt"
rclone_version_output="$operation_root/rclone-version.txt"
runuser --user "$OFFSITE_USER" -- env -i HOME="$OFFSITE_UPLOADER_HOME" PATH=/usr/bin:/bin \
  "$operation_root/restic" version >"$restic_version_output" 2>/dev/null \
  || offsite_die "Die gepinnte restic-Binaerdatei ist nicht lauffaehig."
runuser --user "$OFFSITE_USER" -- env -i HOME="$OFFSITE_UPLOADER_HOME" PATH=/usr/bin:/bin \
  "$operation_root/rclone" version >"$rclone_version_output" 2>/dev/null \
  || offsite_die "Die gepinnte rclone-Binaerdatei ist nicht lauffaehig."
readarray -t binary_versions < <("$OFFSITE_NODE" - "$restic_version_output" "$rclone_version_output" <<'NODE'
const fs=require("node:fs");
const [resticFile,rcloneFile]=process.argv.slice(2);
const restic=fs.readFileSync(resticFile,"utf8"), rclone=fs.readFileSync(rcloneFile,"utf8");
const rv=restic.match(/\brestic\s+(\d+\.\d+\.\d+)\b[\s\S]*\bon\s+linux\/amd64\b/i);
const cv=rclone.match(/\brclone\s+v(\d+\.\d+(?:\.\d+)?)\b/i);
if(!rv||!cv||!/os\/type:\s*linux\b/i.test(rclone)||!/os\/arch:\s*amd64\b/i.test(rclone))process.exit(1);
const atLeast=(value,min)=>{const a=value.split(".").map(Number),b=min.split(".").map(Number);while(a.length<3)a.push(0);for(let i=0;i<3;i++){if(a[i]>b[i])return true;if(a[i]<b[i])return false;}return true;};
if(!atLeast(rv[1],"0.17.3")||!atLeast(cv[1],"1.70.0"))process.exit(1);
process.stdout.write(`${rv[1]}\n${cv[1]}\n`);
NODE
) || offsite_die "restic/rclone sind nicht linux/amd64 oder unterschreiten die freigegebenen Mindestversionen."
restic_version="${binary_versions[0]:-}"
rclone_version="${binary_versions[1]:-}"

if [[ -e "$OFFSITE_CONFIG_ROOT/installation-id" || -L "$OFFSITE_CONFIG_ROOT/installation-id" ]]; then
  [[ -f "$OFFSITE_CONFIG_ROOT/installation-id" && ! -L "$OFFSITE_CONFIG_ROOT/installation-id" \
    && "$(stat --format='%u:%g:%a:%h' -- "$OFFSITE_CONFIG_ROOT/installation-id")" == "0:0:600:1" ]] \
    || offsite_die "Die vorhandene stabile Installationskennung ist unsicher."
  installation_id="$(tr -d '\r\n' <"$OFFSITE_CONFIG_ROOT/installation-id")"
  [[ "$installation_id" =~ ^[a-f0-9]{32}$ && "$(wc -c <"$OFFSITE_CONFIG_ROOT/installation-id")" -eq 33 ]] \
    || offsite_die "Die vorhandene stabile Installationskennung ist ungueltig."
else
  installation_id="$(openssl rand -hex 16)"
fi
printf '%s\n' "$repository" >"$operation_root/repository"
printf '%s\n' "0000000000000000" >"$operation_root/repository-id"
printf '%s\n' "$installation_id" >"$operation_root/installation-id"
cp -- "$restic_password_source" "$operation_root/restic-password"
cp -- "$rclone_password_source" "$operation_root/rclone-config-password"
chown root:root -- "$operation_root/repository" "$operation_root/repository-id" "$operation_root/installation-id" \
  "$operation_root/restic-password" "$operation_root/rclone-config-password"
chmod 0600 -- "$operation_root/repository" "$operation_root/repository-id" "$operation_root/installation-id" \
  "$operation_root/restic-password" "$operation_root/rclone-config-password"
setup_credentials="$(offsite_make_uploader_credentials "$operation_root")"
setup_run() {
  runuser --user "$OFFSITE_USER" -- env -i HOME="$OFFSITE_UPLOADER_HOME" USER="$OFFSITE_USER" LOGNAME="$OFFSITE_USER" \
    PATH=/usr/bin:/bin CREDENTIALS_DIRECTORY="$setup_credentials" GRABENPLANER_OFFSITE_SETUP_ROOT="$operation_root" "$@"
}
setup_restic() {
  setup_run "$operation_root/restic" --repository-file "$setup_credentials/repository" \
    --password-file "$setup_credentials/restic-password" --retry-lock 15m \
    -o "rclone.program=$operation_root/rclone-wrapper" "$@"
}
core_common="$OFFSITE_APP_ROOT/server-tools/linux/lib/common.sh"
[[ -f "$core_common" && ! -L "$core_common" ]] || offsite_die "Die verifizierte Core-Wartungssperre fehlt."
# shellcheck source=server-tools/linux/lib/common.sh
source "$core_common"
gp_acquire_maintenance_lock
# Validate existing matrix state before pausing any timer. An older Core may
# migrate without this helper only when no matrix receipt exists yet.
maintenance_schedule_state=none
if [[ -e "$OFFSITE_MAINTENANCE_SCHEDULE_ROOT/schedules.json" || -L "$OFFSITE_MAINTENANCE_SCHEDULE_ROOT/schedules.json" ]]; then
  declare -F gp_maintenance_schedule_state >/dev/null \
    || offsite_die "Der vorhandene Wartungszeitplan kann mit diesem Core nicht sicher geprueft werden."
  maintenance_schedule_state="$(gp_maintenance_schedule_state "$OFFSITE_APP_ROOT" "$OFFSITE_NODE")" \
    || offsite_die "Der vorhandene Wartungszeitplan ist ungueltig."
fi
timers=(grabenplaner-offsite-assurance.timer grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer)
for index in 0 1 2 3; do
  systemctl is-enabled --quiet "${timers[index]}" && timer_was_enabled[index]=1 || true
  systemctl is-active --quiet "${timers[index]}" && timer_was_active[index]=1 || true
  systemctl disable --now "${timers[index]}" >/dev/null 2>&1 || true
done
timers_paused=1
if [[ "$(systemctl show --property=LoadState --value "$control_socket" 2>/dev/null || true)" != "not-found" ]]; then
  systemctl is-enabled --quiet "$control_socket" && control_socket_was_enabled=1 || true
  systemctl is-active --quiet "$control_socket" && control_socket_was_active=1 || true
  systemctl disable --now "$control_socket" >/dev/null 2>&1 || true
fi
systemctl stop 'grabenplaner-offsite-assurance-control@*.service' >/dev/null 2>&1 || true
control_socket_paused=1
if [[ "$(systemctl show --property=LoadState --value "$target_control_socket" 2>/dev/null || true)" != "not-found" ]]; then
  systemctl is-enabled --quiet "$target_control_socket" && target_control_socket_was_enabled=1 || true
  systemctl is-active --quiet "$target_control_socket" && target_control_socket_was_active=1 || true
  systemctl disable --now "$target_control_socket" >/dev/null 2>&1 || true
fi
systemctl stop 'grabenplaner-offsite-target-control@*.service' >/dev/null 2>&1 || true
target_control_socket_paused=1
offsite_acquire_assurance_lock
offsite_acquire_repository_lock
previous_provider_id=""
previous_provider_binding=0
previous_repository=""
previous_repository_id=""
if (( installed_module_version >= 1 )); then
  if previous_provider_id="$("$OFFSITE_NODE" "$module_candidate/lib/offsite-contract.js" provider-id \
    "$OFFSITE_CONFIG_ROOT/installed-contract.json" 2>/dev/null)"; then
    previous_provider_binding=1
  else
    previous_provider_id=""
  fi
  if [[ -z "$previous_provider_id" ]]; then
    # Module vor der Providerbindung unterstuetzten ausschliesslich den
    # dedizierten Google-Drive-Pfad. Diese einmalige Zuordnung ermoeglicht die
    # kontrollierte Migration, aber keinen stillen Wechsel zu S3.
    previous_provider_id="google_drive"
  fi
  previous_repository="$("$OFFSITE_NODE" - "$OFFSITE_CONFIG_ROOT/repository" <<'NODE'
const fs = require("node:fs");
const value = fs.readFileSync(process.argv[2], "utf8");
const match = value.match(/^(rclone:[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[A-Za-z0-9][A-Za-z0-9._/-]{0,511})\n?$/);
if (!match || match[1].split(":").at(-1).split("/").some((part) => !part || part === "." || part === "..")) process.exit(1);
process.stdout.write(match[1]);
NODE
)" || offsite_die "Das bisher gebundene Offsite-Repository ist ungueltig."
  previous_repository_id="$("$OFFSITE_NODE" - "$OFFSITE_CONFIG_ROOT/repository-id" <<'NODE'
const fs = require("node:fs");
const value = fs.readFileSync(process.argv[2], "utf8");
const match = value.match(/^([a-f0-9]{16,64})\n?$/);
if (!match) process.exit(1);
process.stdout.write(match[1]);
NODE
)" || offsite_die "Die bisher gebundene Repository-Identitaet ist ungueltig."
  (( initialize_repository == 0 )) \
    || offsite_die "--initialize-repository ist nur bei der ersten Offsite-Einrichtung erlaubt."
elif (( status_configured_before == 1 )); then
  offsite_die "Ein konfigurierter Offsite-Status ohne installiertes Modul ist nicht migrationsfaehig."
fi
provider_policy="$operation_root/provider-policy.json"
setup_run "$operation_root/rclone-wrapper" config redacted "$rclone_remote" 2>/dev/null \
  | "$OFFSITE_NODE" "$module_candidate/lib/offsite-rclone-policy.js" "$rclone_remote" >"$provider_policy" \
  || offsite_die "Das gewaehlte rclone-Remote entspricht keiner freigegebenen Offsite-Provider-Richtlinie."
chmod 0600 -- "$provider_policy"
if (( previous_provider_binding == 1 )); then
  "$OFFSITE_NODE" "$module_candidate/lib/offsite-contract.js" verify-provider-binding \
    "$OFFSITE_CONFIG_ROOT/installed-contract.json" "$provider_policy" "$operation_root/repository" >/dev/null \
    || offsite_die "Eine Aenderung der gebundenen Provider-, Endpoint- oder Repository-Richtlinie ist nur ueber einen eigenen Migrationsvorgang erlaubt."
fi
bound_contract_receipt="$operation_root/installed-contract.bound.json"
"$OFFSITE_NODE" "$module_candidate/lib/offsite-contract.js" bind-provider \
  "$contract_receipt" "$provider_policy" "$operation_root/repository" >"$bound_contract_receipt" \
  || offsite_die "Die validierte Provider- und Repository-Bindung ist ungueltig."
chmod 0600 -- "$bound_contract_receipt"
mv -f -- "$bound_contract_receipt" "$contract_receipt"
validated_provider="$("$OFFSITE_NODE" "$module_candidate/lib/offsite-contract.js" verify-provider-binding \
  "$contract_receipt" "$provider_policy" "$operation_root/repository")" \
  || offsite_die "Die Providerbindung konnte nicht aus dem Installationsbeleg bestaetigt werden."
case "$validated_provider" in
  google_drive|hetzner_object_storage|backblaze_b2) ;;
  *) offsite_die "Der validierte Offsite-Provider ist ungueltig." ;;
esac
if [[ -n "$previous_provider_id" && "$validated_provider" != "$previous_provider_id" ]]; then
  offsite_die "Ein Offsite-Providerwechsel ist nur ueber einen eigenen, vollstaendig abgesicherten Migrationsvorgang erlaubt."
fi
if [[ -n "$previous_repository" && "$repository" != "$previous_repository" ]]; then
  offsite_die "Ein Wechsel des gebundenen Offsite-Repositorys ist im Installer nicht erlaubt."
fi

repository_config="$operation_root/repository-config.json"
set +e
setup_restic cat config >"$repository_config" 2>"$operation_root/repository.error"
repository_status=$?
set -e
if (( repository_status != 0 )); then
  [[ "$repository_status" -eq 10 && "$initialize_repository" -eq 1 ]] \
    || offsite_die "Das Restic-Repository ist nicht initialisiert, nicht erreichbar oder die Zugangsdaten stimmen nicht."
  if [[ "$validated_provider" == "google_drive" ]]; then
    setup_run "$operation_root/rclone-wrapper" about "$rclone_remote:" \
      >"$operation_root/remote-about.out" 2>"$operation_root/remote-about.error" \
      || offsite_die "Das Google-Drive-Remote ist nicht sicher erreichbar."
  else
    s3_bucket="${repository_path%%/*}"
    [[ -n "$s3_bucket" && "$s3_bucket" != "$repository_path" ]] \
      || offsite_die "Der fest gebundene S3-Bucket konnte nicht bestimmt werden."
    setup_run "$operation_root/rclone-wrapper" lsf "$rclone_remote:$s3_bucket" --dirs-only --max-depth 1 \
      >"$operation_root/bucket-list.out" 2>"$operation_root/bucket-list.error" \
      || offsite_die "Der fest gebundene S3-Bucket ist nicht sicher erreichbar."
  fi
  set +e
  setup_run "$operation_root/rclone-wrapper" lsf "$rclone_remote:$repository_path" --max-depth 1 \
    >"$operation_root/repository-list.out" 2>"$operation_root/repository-list.error"
  list_status=$?
  set -e
  if (( list_status == 0 )); then
    [[ ! -s "$operation_root/repository-list.out" ]] || offsite_die "Das neue Repository-Ziel ist nicht leer."
  else
    parent_target="$rclone_remote:"
    [[ -n "$repository_parent" ]] && parent_target="$rclone_remote:$repository_parent"
    setup_run "$operation_root/rclone-wrapper" lsf "$parent_target" --dirs-only --max-depth 1 \
      >"$operation_root/repository-parent.out" 2>"$operation_root/repository-parent.error" \
      || offsite_die "Der Elternordner des neuen Repository-Ziels ist nicht sicher pruefbar."
    if grep -Fxq "$repository_leaf/" "$operation_root/repository-parent.out"; then
      offsite_die "Das neue Repository-Ziel ist vorhanden, aber nicht sicher als leer bestaetigt."
    fi
  fi
  setup_restic init >"$operation_root/init.out" 2>"$operation_root/init.error" \
    || offsite_die "Das Restic-Repository konnte nicht initialisiert werden."
  setup_restic cat config >"$repository_config" 2>"$operation_root/repository.error" \
    || offsite_die "Das initialisierte Restic-Repository konnte nicht bestaetigt werden."
fi
repository_id="$("$OFFSITE_NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[a-f0-9]{16,64}$/i.test(String(v.id||"")))process.exit(1);process.stdout.write(String(v.id).toLowerCase())' "$repository_config")" \
  || offsite_die "Die Repository-Identitaet konnte nicht sicher gelesen werden."
if [[ -n "$previous_repository_id" && "$repository_id" != "$previous_repository_id" ]]; then
  offsite_die "Die erreichbare Repository-Identitaet weicht von der bisher gebundenen Identitaet ab."
fi
printf '%s\n' "$repository_id" >"$operation_root/repository-id"
offsite_remove_uploader_credentials "$setup_credentials"
setup_credentials="$(offsite_make_uploader_credentials "$operation_root")"
if ! setup_restic cat config >"$operation_root/repository-confirm.json" 2>/dev/null \
  || [[ "$("$OFFSITE_NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(v.id||"").toLowerCase())' "$operation_root/repository-confirm.json")" != "$repository_id" ]]; then
  offsite_die "Die Repository-Identitaet konnte nicht erneut bestaetigt werden."
fi
# Ein moeglicher Credential-Refresh oder eine rclone-interne
# Konfigurationsaktualisierung waehrend des Repositoryzugriffs darf die
# zuvor gebundene Provider-Richtlinie nicht veraendern.
post_provider_policy="$operation_root/provider-policy.post.json"
setup_run "$operation_root/rclone-wrapper" config redacted "$rclone_remote" 2>/dev/null \
  | "$OFFSITE_NODE" "$module_candidate/lib/offsite-rclone-policy.js" "$rclone_remote" >"$post_provider_policy" \
  || offsite_die "Die aktualisierte rclone-Konfiguration verletzt die gebundene Provider-Richtlinie."
chmod 0600 -- "$post_provider_policy"
post_validated_provider="$("$OFFSITE_NODE" "$module_candidate/lib/offsite-contract.js" verify-provider-binding \
  "$contract_receipt" "$post_provider_policy" "$operation_root/repository")" \
  || offsite_die "Die aktualisierte rclone-Konfiguration weicht von der gebundenen Provider-Richtlinie ab."
[[ "$post_validated_provider" == "$validated_provider" ]] \
  || offsite_die "Der validierte Offsite-Provider hat sich waehrend der Einrichtung geaendert."

rollback_root="$operation_root/rollback"
install -d -m 0700 -o root -g root -- "$rollback_root" "$rollback_root/units"
install -m 0600 -o root -g root -- "$OFFSITE_APP_ENV" "$rollback_root/grabenplaner.env"
for entry in "restic:$OFFSITE_RESTIC" "rclone:$OFFSITE_RCLONE" "legacy-wrapper:$OFFSITE_LEGACY_RCLONE_WRAPPER"; do
  IFS=: read -r backup_name target <<<"$entry"
  if [[ -e "$target" || -L "$target" ]]; then
    target_mode="$(stat --format='%a' -- "$target" 2>/dev/null || true)"
    [[ -f "$target" && ! -L "$target" && "$(stat --format='%u:%g:%h' -- "$target")" == "0:0:1" \
      && -n "$target_mode" && $((8#$target_mode & 022)) -eq 0 ]] \
      || offsite_die "Eine vorhandene Offsite-Binaerdatei ist unsicher."
    install -m 0600 -o root -g root -- "$target" "$rollback_root/$backup_name"
    case "$backup_name" in restic) restic_had_original=1 ;; rclone) rclone_had_original=1 ;; legacy-wrapper) legacy_wrapper_had_original=1 ;; esac
  fi
done
if find "$OFFSITE_CONFIG_ROOT" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  config_had_original=1
  install -d -m 0700 -o root -g root -- "$rollback_root/config"
  cp --archive -- "$OFFSITE_CONFIG_ROOT/." "$rollback_root/config/"
fi
if [[ -f "$OFFSITE_STATUS_FILE" && ! -L "$OFFSITE_STATUS_FILE" ]]; then
  status_had_original=1
  install -m 0600 -o root -g root -- "$OFFSITE_STATUS_FILE" "$rollback_root/status.json"
fi
for template in "$module_candidate"/systemd/*.in; do
  unit_name="$(basename -- "$template" .in)"
  unit_file="/etc/systemd/system/$unit_name"
  if [[ -e "$unit_file" || -L "$unit_file" ]]; then
    [[ -f "$unit_file" && ! -L "$unit_file" ]] || offsite_die "Eine vorhandene Offsite-Unit ist unsicher."
    if [[ -d "$OFFSITE_MODULE_ROOT" && ! -L "$OFFSITE_MODULE_ROOT" && -f "$OFFSITE_MODULE_ROOT/systemd/$(basename -- "$template")" ]] \
      && cmp --silent -- "$OFFSITE_MODULE_ROOT/systemd/$(basename -- "$template")" "$unit_file"; then
      install -m 0644 -o root -g root -- "$unit_file" "$rollback_root/units/$unit_name"
    else
      offsite_die "Eine vorhandene Offsite-Unit wurde veraendert und wird nicht ueberschrieben."
    fi
  fi
done
for service_name in 'grabenplaner-offsite-target-control@*.service' 'grabenplaner-offsite-assurance-control@*.service' 'grabenplaner-offsite-assurance@*.service' grabenplaner-offsite-application-smoke.service grabenplaner-offsite-prepare.service grabenplaner-offsite-upload.service grabenplaner-offsite-check.service grabenplaner-offsite-restore-test.service; do
  deadline=$((SECONDS + 14400))
  while systemctl is-active --quiet "$service_name"; do
    (( SECONDS < deadline )) || offsite_die "Ein laufender Offsite-Vorgang wurde nicht rechtzeitig abgeschlossen."
    sleep 2
  done
done
if [[ -e "$OFFSITE_ASSURANCE_ROOT" || -L "$OFFSITE_ASSURANCE_ROOT" ]]; then
  assurance_root_had_original=1
fi
"$OFFSITE_NODE" "$module_candidate/lib/assurance-history.js" init \
  --root "$OFFSITE_ASSURANCE_ROOT" --status-gid "$status_gid" >/dev/null \
  || offsite_die "Der signierte Recovery-Assurance-Verlauf konnte nicht sicher initialisiert werden."
assurance_root_initialized=1
declare -A expected_commands=(
  [grabenplaner-offsite-assurance]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-assurance.sh"
  [grabenplaner-offsite-pre-update]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-pre-update.sh"
  [grabenplaner-offsite-prepare]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-prepare.sh"
  [grabenplaner-offsite-recovery-set]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-recovery-set.sh"
  [grabenplaner-offsite-rebind-rclone]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-rebind-rclone.sh"
  [grabenplaner-offsite-test]="$OFFSITE_MODULE_ROOT/test-grabenplaner-offsite.sh"
  [grabenplaner-offsite-uninstall]="$OFFSITE_MODULE_ROOT/uninstall-grabenplaner-offsite.sh"
  [grabenplaner-recovery]="$recovery_command"
)
for command_name in "${!expected_commands[@]}"; do
  command_path="/usr/local/sbin/$command_name"
  if [[ -e "$command_path" || -L "$command_path" ]]; then
    [[ -d "$OFFSITE_MODULE_ROOT" && ! -L "$OFFSITE_MODULE_ROOT" && -L "$command_path" \
      && "$(readlink -- "$command_path")" == "${expected_commands[$command_name]}" ]] \
      || offsite_die "Ein fremder Offsite-Befehl wuerde ueberschrieben."
    [[ "$command_name" == "grabenplaner-recovery" ]] && recovery_command_had_original=1
    [[ "$command_name" == "grabenplaner-offsite-rebind-rclone" ]] && rebind_command_had_original=1
    [[ "$command_name" == "grabenplaner-offsite-assurance" ]] && assurance_command_had_original=1
    [[ "$command_name" == "grabenplaner-offsite-recovery-set" ]] && recovery_set_command_had_original=1
  fi
done
if [[ -d "$OFFSITE_MODULE_ROOT" && ! -L "$OFFSITE_MODULE_ROOT" ]]; then
  module_previous="$OFFSITE_ROOT/.module.previous.$$"
  mv -T -- "$OFFSITE_MODULE_ROOT" "$module_previous"
fi
commit_started=1
mv -T -- "$module_candidate" "$OFFSITE_MODULE_ROOT"
chown -R root:root -- "$OFFSITE_MODULE_ROOT"
chmod 0755 -- "$OFFSITE_MODULE_ROOT"
install -m 0755 -o root -g root -- "$restic_source" "$OFFSITE_RESTIC"
install -m 0755 -o root -g root -- "$rclone_source" "$OFFSITE_RCLONE"
rm -f -- "$OFFSITE_LEGACY_RCLONE_WRAPPER"
if [[ -f "$OFFSITE_RCLONE_CONFIG" && ! -L "$OFFSITE_RCLONE_CONFIG" ]]; then
  rclone_previous="$OFFSITE_CREDENTIAL_STATE_ROOT/.rclone.previous.$$"
  mv -- "$OFFSITE_RCLONE_CONFIG" "$rclone_previous"
fi
install -m 0600 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" -- "$operation_root/config/rclone.conf" "$OFFSITE_RCLONE_CONFIG"
offsite_assert_persistent_rclone_config

for name in repository repository-id installation-id restic-password rclone-config-password; do
  install -m 0600 -o root -g root -- "$operation_root/$name" "$OFFSITE_CONFIG_ROOT/$name"
done
install -m 0600 -o root -g root -- "$contract_receipt" "$OFFSITE_CONFIG_ROOT/installed-contract.json"
"$OFFSITE_NODE" - "$OFFSITE_CONFIG_ROOT/binary-pins.json" "$restic_sha256" "$rclone_sha256" "$restic_version" "$rclone_version" <<'NODE'
const fs = require("node:fs");
const [file, restic, rclone, resticVersion, rcloneVersion] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({ format: "grabenplaner-offsite-binary-pins", schemaVersion: 1, resticSha256: restic, rcloneSha256: rclone, resticVersion, rcloneVersion, platform: "linux/amd64" }, null, 2)}\n`, { mode: 0o600 });
NODE
chown root:root -- "$OFFSITE_CONFIG_ROOT/binary-pins.json"
chmod 0600 -- "$OFFSITE_CONFIG_ROOT/binary-pins.json"
offsite_assert_installed_contract
offsite_assert_runtime_binaries

for template in "$OFFSITE_MODULE_ROOT"/systemd/*.in; do
  unit_name="$(basename -- "$template" .in)"
  install -m 0644 -o root -g root -- "$template" "/etc/systemd/system/$unit_name"
done
declare -A commands=(
  [grabenplaner-offsite-assurance]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-assurance.sh"
  [grabenplaner-offsite-pre-update]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-pre-update.sh"
  [grabenplaner-offsite-prepare]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-prepare.sh"
  [grabenplaner-offsite-recovery-set]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-recovery-set.sh"
  [grabenplaner-offsite-rebind-rclone]="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-rebind-rclone.sh"
  [grabenplaner-offsite-test]="$OFFSITE_MODULE_ROOT/test-grabenplaner-offsite.sh"
  [grabenplaner-offsite-uninstall]="$OFFSITE_MODULE_ROOT/uninstall-grabenplaner-offsite.sh"
  [grabenplaner-recovery]="$recovery_command"
)
for command_name in "${!commands[@]}"; do
  ln -sfn -- "${commands[$command_name]}" "/usr/local/sbin/$command_name"
done

env_temporary="$(mktemp --tmpdir="$(dirname -- "$OFFSITE_APP_ENV")" .grabenplaner.env.XXXXXXXX)"
"$OFFSITE_NODE" - "$OFFSITE_APP_ENV" "$env_temporary" "$validated_provider" <<'NODE'
const fs = require("node:fs");
const [source, target, provider] = process.argv.slice(2);
if (!["google_drive", "hetzner_object_storage", "backblaze_b2"].includes(provider)) process.exit(1);
const original = fs.readFileSync(source, "utf8");
const expected = ["GRABENPLANER_OFFSITE_CONFIGURED=1", `GRABENPLANER_OFFSITE_PROVIDER=${provider}`,
  "GRABENPLANER_OFFSITE_STATUS_FILE=/var/lib/grabenplaner-offsite/status.json"];
const originalLines = original.split(/\r?\n/);
if (expected.every(value => {
  const prefix = value.slice(0, value.indexOf("=") + 1), matching = originalLines.filter(line => line.startsWith(prefix));
  return matching.length === 1 && matching[0] === value;
})) {
  fs.writeFileSync(target, original, { mode: 0o600 });
  process.exit(0);
}
const lines = originalLines
  .filter((line) => !/^GRABENPLANER_OFFSITE_(?:CONFIGURED|PROVIDER|STATUS_FILE)=/.test(line));
while (lines.length && !lines.at(-1)) lines.pop();
lines.push(
  "GRABENPLANER_OFFSITE_CONFIGURED=1",
  `GRABENPLANER_OFFSITE_PROVIDER=${provider}`,
  "GRABENPLANER_OFFSITE_STATUS_FILE=/var/lib/grabenplaner-offsite/status.json",
  "",
);
fs.writeFileSync(target, lines.join("\n"), { mode: 0o600 });
NODE
chown root:root -- "$env_temporary"
chmod 0600 -- "$env_temporary"
mv -f -- "$env_temporary" "$OFFSITE_APP_ENV"

if (( status_configured_before == 0 )); then
  offsite_status configured >/dev/null
else
  offsite_status bind-provider >/dev/null
fi
systemctl daemon-reload
systemctl enable --now grabenplaner-offsite-assurance-control.socket >/dev/null
# Only a fresh installation receives defaults. Upgrades restore each timer's
# independently captured enabled and active states, including disabled rows.
if (( installed_module_version >= 1 )); then
  for index in 0 1 2 3; do
    if (( timer_was_enabled[index] == 1 )); then
      systemctl enable "${timers[index]}" >/dev/null
    else
      systemctl disable "${timers[index]}" >/dev/null
    fi
    if (( timer_was_active[index] == 1 )); then
      systemctl start "${timers[index]}" >/dev/null
    else
      systemctl stop "${timers[index]}" >/dev/null
    fi
  done
else
  systemctl enable --now grabenplaner-offsite-assurance.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer >/dev/null
fi
# A module can precede its matching app. Keep the predecessor schedule until
# the new Core is installed; the updater converges it after the application swap.
core_offsite_module_version="$($OFFSITE_NODE - "$OFFSITE_APP_ROOT/server-tools/linux/offsite/module-schema.json" <<'NODE'
const fs=require("node:fs");
const value=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if(value?.format!=="grabenplaner-linux-offsite-module-contract"||value?.schemaVersion!==1
  ||![7,8,9,10,11].includes(value?.moduleVersion))process.exit(1);
process.stdout.write(String(value.moduleVersion));
NODE
)" || offsite_die "Der installierte Core-Offsite-Vertrag ist ungueltig."
if (( installed_module_version == 0 )); then
  if (( core_offsite_module_version >= 10 )); then
    systemctl disable --now grabenplaner-offsite-upload.timer >/dev/null
  elif declare -F gp_configure_nightly_backups >/dev/null; then
    gp_configure_nightly_backups "$OFFSITE_APP_ROOT" "$OFFSITE_NODE"
  else
    systemctl enable --now grabenplaner-offsite-upload.timer >/dev/null
  fi
fi
if [[ "$validated_provider" == "google_drive" ]]; then
  systemctl enable --now grabenplaner-offsite-target-control.socket >/dev/null
else
  systemctl disable --now grabenplaner-offsite-target-control.socket >/dev/null 2>&1 || true
  systemctl stop 'grabenplaner-offsite-target-control@*.service' >/dev/null 2>&1 || true
fi
# The exact module-7/runtime-5 predecessor needs no core restart when its
# environment and process groups are unchanged. All other transitions drain
# native backup children before systemd finishes the old process.
core_workflow="$(offsite_core_deploy_workflow 2>/dev/null || true)"
if [[ "$installed_module_version" == 7 && "$core_workflow" == legacy-full ]] \
  && cmp --silent "$rollback_root/grabenplaner.env" "$OFFSITE_APP_ENV" \
  && [[ "$app_groups_before" == "$(id -G -- "$OFFSITE_APP_USER")" ]] \
  && systemctl is-active --quiet "$OFFSITE_APP_SERVICE"; then
  offsite_info "Modulwechsel ohne zusaetzlichen App-Neustart: Core-Konfiguration und Prozessgruppen sind unveraendert."
else
  app_restart_started=1
  gp_stop_service "$OFFSITE_APP_SERVICE" 150
  gp_start_service "$OFFSITE_APP_SERVICE"
fi
systemctl is-active --quiet "$OFFSITE_APP_SERVICE" || offsite_die "Der Grabenplaner-Dienst konnte nach der Offsite-Aktivierung nicht gestartet werden."
systemctl is-active --quiet grabenplaner-offsite-assurance-control.socket \
  || offsite_die "Der abgesicherte Recovery-Assurance-Steuerungssocket wurde nicht aktiviert."
if [[ "$validated_provider" == "google_drive" ]]; then
  systemctl is-enabled --quiet grabenplaner-offsite-target-control.socket \
    || offsite_die "Der abgesicherte Google-Drive-Ziel-Steuerungssocket wurde nicht aktiviert."
  systemctl is-active --quiet grabenplaner-offsite-target-control.socket \
    || offsite_die "Der abgesicherte Google-Drive-Ziel-Steuerungssocket wurde nicht gestartet."
else
  ! systemctl is-enabled --quiet grabenplaner-offsite-target-control.socket \
    || offsite_die "Die Google-Drive-Ziel-Steuerung darf fuer den gebundenen S3-Provider nicht aktiviert sein."
  ! systemctl is-active --quiet grabenplaner-offsite-target-control.socket \
    || offsite_die "Die Google-Drive-Ziel-Steuerung darf fuer den gebundenen S3-Provider nicht laufen."
fi
app_port="$("$OFFSITE_NODE" - "$OFFSITE_APP_ENV" <<'NODE'
const fs = require("node:fs");
const matches = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter((line) => /^PORT=/.test(line));
if (matches.length !== 1) process.exit(1);
const port = Number(matches[0].slice(5));
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
process.stdout.write(String(port));
NODE
)" || offsite_die "Der lokale Grabenplaner-Port konnte nicht sicher gelesen werden."
gp_wait_ready "http://127.0.0.1:${app_port}/api/health/ready" 1500 \
  || offsite_die "Der Grabenplaner hat nach der Offsite-Aktivierung die Bereitschaftspruefung nicht bestanden."

# Ab hier ist die neue Offsite-Konfiguration gesund und committed. Ein Fehler
# beim nachgelagerten RAS-Queueing darf diesen betriebsbereiten Stand nicht mehr
# zurueckrollen; der Installer meldet ihn deutlich und die Pruefung kann manuell
# erneut gestartet werden.
setup_complete=1
assurance_trigger="offsite-config-changed"
[[ -n "$module_previous" ]] && assurance_trigger="offsite-module-changed"
app_version="$($OFFSITE_NODE -e 'const value=require("/opt/grabenplaner/app/package.json");const version=String(value.version||"");if(!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version))process.exit(1);process.stdout.write(version)')" \
  || offsite_die "Die installierte App-Version ist fuer Recovery Assurance ungueltig."
if ! (offsite_record_assurance_queue configuration-change-queued "$assurance_trigger" "$app_version"); then
  offsite_warn "Die erfolgreiche Offsite-Einrichtung konnte nicht im signierten Recovery-Assurance-Verlauf vorgemerkt werden."
fi
if ! systemctl start --no-block "grabenplaner-offsite-assurance@${assurance_trigger}.service" >/dev/null; then
  offsite_warn "Die Recovery-Assurance-Pruefung nach der Offsite-Einrichtung konnte nicht eingeplant werden."
fi
[[ -n "$module_previous" && -d "$module_previous" && ! -L "$module_previous" ]] && rm -rf --one-file-system -- "$module_previous"
[[ -n "$rclone_previous" && -f "$rclone_previous" && ! -L "$rclone_previous" ]] && rm -f -- "$rclone_previous"
offsite_info "Das optionale verschluesselte Offsite-Modul wurde idempotent eingerichtet."

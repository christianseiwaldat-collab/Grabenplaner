#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# This controller is intentionally conservative: `audit` is the default and is
# read-only unless --write-status is explicitly supplied. Host changes always
# remain pending until a second, newly opened key-only SSH session confirms the
# transaction. No command below resets UFW or edits rules it does not own.

readonly CONTROLLER_NAME="grabenplaner-host-security"
readonly SSH_DROPIN="/etc/ssh/sshd_config.d/00-grabenplaner-hardening.conf"
readonly SYSCTL_DROPIN="/etc/sysctl.d/60-grabenplaner-sysctl.conf"
readonly JOURNALD_DROPIN="/etc/systemd/journald.conf.d/60-grabenplaner-journald.conf"
readonly UNATTENDED_DROPIN="/etc/apt/apt.conf.d/60grabenplaner-unattended-upgrades"
readonly AUTO_UPGRADES_DROPIN="/etc/apt/apt.conf.d/60grabenplaner-auto-upgrades"
readonly UFW_USER_RULES="/etc/ufw/user.rules"
readonly UFW_USER6_RULES="/etc/ufw/user6.rules"
readonly UFW_CONFIG="/etc/ufw/ufw.conf"
readonly UFW_DEFAULT="/etc/default/ufw"
readonly ACTIVE_TRANSACTION_FILE="/var/lib/grabenplaner-host-security/active-transaction"
readonly AUTOMATIC_ROLLBACK_LOCK_WAIT_SECONDS=50
readonly ROLLBACK_CONFIRMATION_SECONDS=600
readonly -a MANAGED_KEYS=(ssh sysctl journald unattended auto-upgrades ufw-user ufw-user6 ufw-config ufw-default)
readonly -a UFW_MANAGED_KEYS=(ufw-user ufw-user6 ufw-config ufw-default)

# Installed operation uses the immutable module copy. The local fallback only
# exists for syntax checks in a source checkout.
if [[ -r /opt/grabenplaner-hardening/module/lib/hardening-common.sh ]]; then
  # shellcheck source=/dev/null
  source /opt/grabenplaner-hardening/module/lib/hardening-common.sh
else
  readonly SOURCE_MODULE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  # shellcheck source=lib/hardening-common.sh
  source "$SOURCE_MODULE_ROOT/lib/hardening-common.sh"
fi

readonly POLICY_FILE="$HARDENING_MODULE_ROOT/lib/hardening-policy.js"
readonly TEMPLATE_ROOT="$HARDENING_MODULE_ROOT/templates"

CONFIG_ADMIN=""
CONFIG_SSH_PORT=""
CONFIG_SOURCES=()
SESSION_CLIENT_IP=""
SESSION_SERVER_IP=""
SESSION_SERVER_PORT=""
SESSION_FINGERPRINT=""
ROLLBACK_ARMED=0
ROLLBACK_TRANSACTION=""
ROLLBACK_ADMIN=""
ROLLBACK_CLIENT_IP=""
ROLLBACK_SERVER_IP=""
ROLLBACK_SSH_PORT=""
ROLLBACK_UFW_WAS_ACTIVE=""
ROLLBACK_SOURCES=()
UFW_TRANSITION_BASELINE_FILE=""

command_json() {
  local mode="$1" state="$2" source_count="$3" matched="$4" pending="$5" reboot_required="$6"
  printf '{"format":"grabenplaner-host-security-command-result","schemaVersion":1,"mode":"%s","state":"%s","sourceCount":%d,"clientMatched":%s,"pendingConfirmation":%s,"rebootRequired":%s}\n' \
    "$mode" "$state" "$source_count" "$matched" "$pending" "$reboot_required"
}

require_controller_dependencies() {
  local command
  for command in apt-config awk cmp date flock getent grep install mktemp mv readlink sha256sum sshd ssh-keygen stat sudo sync sysctl systemctl systemd-analyze ufw; do
    hardening_require_command "$command"
  done
  [[ -f "$POLICY_FILE" && ! -L "$POLICY_FILE" ]] || hardening_die "Die installierte Hardening-Policy fehlt."
}

policy_validate_configuration() {
  local node admin="$1" port="$2"
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Sicherheitspruefung."
  "$node" - "$POLICY_FILE" "$admin" "$port" <<'NODE' >/dev/null
const policy = require(process.argv[2]);
if (!policy.isValidAdminUsername(process.argv[3]) || !policy.isValidSshPort(process.argv[4])) process.exit(1);
NODE
}

policy_validate_port() {
  local node port="$1"
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Portpruefung."
  "$node" - "$POLICY_FILE" "$port" <<'NODE' >/dev/null
const policy = require(process.argv[2]);
if (!policy.isValidPort(process.argv[3])) process.exit(1);
NODE
}

policy_validate_transaction() {
  local node transaction_id="$1"
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Transaktionspruefung."
  "$node" - "$POLICY_FILE" "$transaction_id" <<'NODE' >/dev/null
const policy = require(process.argv[2]);
if (!policy.isValidTransactionId(process.argv[3])) process.exit(1);
NODE
}

policy_validate_session() {
  local node client_ip="$1"
  shift
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Sitzungspruefung."
  "$node" - "$POLICY_FILE" "$client_ip" "$@" <<'NODE' >/dev/null
const policy = require(process.argv[2]);
const result = policy.validateSession({ clientIp: process.argv[3], allowedSources: process.argv.slice(4) });
if (!result.clientMatched) process.exit(1);
NODE
}

policy_validate_sources() {
  local node
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Quellenpruefung."
  "$node" - "$POLICY_FILE" "$@" <<'NODE' >/dev/null
const policy = require(process.argv[2]);
try { policy.validateAllowedSources(process.argv.slice(3), { requireNonEmpty: true }); } catch { process.exit(1); }
NODE
}

policy_validate_ip() {
  local node address="$1"
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die IP-Pruefung."
  "$node" - "$POLICY_FILE" "$address" <<'NODE' >/dev/null
const policy = require(process.argv[2]);
try { policy.parseIpAddress(process.argv[3]); } catch { process.exit(1); }
NODE
}

generate_transaction_id() {
  local node transaction_id
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Transaktionserstellung."
  transaction_id="$($node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  policy_validate_transaction "$transaction_id" || hardening_die "Die Transaktionserstellung ist fehlgeschlagen."
  printf '%s\n' "$transaction_id"
}

transaction_directory() {
  policy_validate_transaction "$1" || hardening_die "Die Transaktions-ID ist ungueltig."
  printf '%s/%s\n' "$HARDENING_TRANSACTION_ROOT" "$1"
}

acquire_controller_lock() {
  hardening_acquire_controller_lock fail-fast 0 \
    || hardening_die "Eine andere Host-Sicherheitstransaktion ist bereits aktiv."
}

parse_configuration_arguments() {
  CONFIG_ADMIN=""
  CONFIG_SSH_PORT=""
  CONFIG_SOURCES=()
  while (($#)); do
    case "$1" in
      --admin)
        [[ -z "$CONFIG_ADMIN" && $# -ge 2 ]] || hardening_die "Die Admin-Angabe ist ungueltig."
        CONFIG_ADMIN="$2"
        shift 2
        ;;
      --admin=*)
        [[ -z "$CONFIG_ADMIN" && -n "${1#*=}" ]] || hardening_die "Die Admin-Angabe ist ungueltig."
        CONFIG_ADMIN="${1#*=}"
        shift
        ;;
      --ssh-port)
        [[ -z "$CONFIG_SSH_PORT" && $# -ge 2 ]] || hardening_die "Die SSH-Portangabe ist ungueltig."
        CONFIG_SSH_PORT="$2"
        shift 2
        ;;
      --ssh-port=*)
        [[ -z "$CONFIG_SSH_PORT" && -n "${1#*=}" ]] || hardening_die "Die SSH-Portangabe ist ungueltig."
        CONFIG_SSH_PORT="${1#*=}"
        shift
        ;;
      --source)
        [[ $# -ge 2 ]] || hardening_die "Eine SSH-Quellfreigabe fehlt."
        CONFIG_SOURCES+=("$2")
        shift 2
        ;;
      --source=*)
        [[ -n "${1#*=}" ]] || hardening_die "Eine SSH-Quellfreigabe fehlt."
        CONFIG_SOURCES+=("${1#*=}")
        shift
        ;;
      *) hardening_die "Unbekannte oder unvollstaendige Sicherheitsoption." ;;
    esac
  done
  [[ -n "$CONFIG_ADMIN" && -n "$CONFIG_SSH_PORT" && ${#CONFIG_SOURCES[@]} -gt 0 ]] \
    || hardening_die "Admin, aktueller SSH-Port und mindestens eine erlaubte Quelle sind erforderlich."
  policy_validate_configuration "$CONFIG_ADMIN" "$CONFIG_SSH_PORT" \
    || hardening_die "Admin oder SSH-Port ist ungueltig."
  policy_validate_sources "${CONFIG_SOURCES[@]}" \
    || hardening_die "Erlaubt sind hoechstens 64 eindeutige SSH-Quellnetze."
}

require_live_ssh_session() {
  local admin="$1" requested_port="$2"
  shift 2
  local client_ip client_port server_ip server_port extra=""
  [[ -n "${SSH_TTY:-}" && -n "${SSH_CONNECTION:-}" ]] || hardening_die "Eine interaktive SSH-Sitzung ist erforderlich."
  [[ "$SSH_TTY" == /dev/pts/* || "$SSH_TTY" == /dev/tty* ]] || hardening_die "Die SSH-Terminalsitzung ist ungueltig."
  [[ -c "$SSH_TTY" ]] || hardening_die "Die SSH-Terminalsitzung ist nicht mehr aktiv."
  read -r client_ip client_port server_ip server_port extra <<<"$SSH_CONNECTION"
  [[ -n "$client_ip" && -n "$client_port" && -n "$server_ip" && -n "$server_port" && -z "$extra" ]] \
    || hardening_die "Die SSH-Sitzungsdaten sind unvollstaendig."
  policy_validate_port "$client_port" || hardening_die "Die SSH-Sitzungsdaten sind ungueltig."
  policy_validate_configuration "$admin" "$server_port" || hardening_die "Die SSH-Sitzungsdaten sind ungueltig."
  policy_validate_ip "$server_ip" || hardening_die "Die SSH-Sitzungsdaten sind ungueltig."
  [[ "$requested_port" == "$server_port" ]] || hardening_die "Der SSH-Port darf gegenueber der aktiven Sitzung nicht geaendert werden."
  policy_validate_session "$client_ip" "$@" || hardening_die "Die aktuelle SSH-Sitzung liegt nicht in einer erlaubten Quelle."
  [[ "${SUDO_USER:-}" == "$admin" && "$SUDO_USER" != "root" ]] \
    || hardening_die "Die Sitzung muss vom vorgesehenen Admin mit sudo bestaetigt werden."

  SESSION_CLIENT_IP="$client_ip"
  SESSION_SERVER_IP="$server_ip"
  SESSION_SERVER_PORT="$server_port"
  SESSION_CONNECTION_FINGERPRINT="$(printf '%s' "$SSH_CONNECTION" | sha256sum --binary | awk '{print tolower($1)}')"
  policy_validate_transaction "$SESSION_CONNECTION_FINGERPRINT" || hardening_die "Die SSH-Verbindung konnte nicht sicher gebunden werden."
  SESSION_FINGERPRINT="$(printf '%s\0%s' "$SSH_TTY" "$SSH_CONNECTION" | sha256sum --binary | awk '{print tolower($1)}')"
  policy_validate_transaction "$SESSION_FINGERPRINT" || hardening_die "Die SSH-Sitzung konnte nicht sicher gebunden werden."
}

ssh_connection_is_independent() {
  local current_connection_fingerprint="$1" first_connection_fingerprint="$2"
  [[ "$current_connection_fingerprint" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$first_connection_fingerprint" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$current_connection_fingerprint" != "$first_connection_fingerprint" ]]
}

admin_key_sudo_preflight() {
  local admin="$1" passwd_entry username _ uid gid gecos home shell ssh_dir authorized_keys owner mode links
  passwd_entry="$(getent passwd "$admin")" || hardening_die "Der vorgesehene Admin existiert nicht."
  IFS=: read -r username _ uid gid gecos home shell <<<"$passwd_entry"
  [[ "$username" == "$admin" && "$uid" =~ ^[0-9]+$ && "$uid" -gt 0 && "$gid" =~ ^[0-9]+$ \
    && "$home" == /* && "$shell" == /* && "$shell" != */false && "$shell" != */nologin ]] \
    || hardening_die "Das Admin-Konto ist fuer die SSH-Wartung ungeeignet."
  sudo -n -l -U "$admin" >/dev/null 2>&1 || hardening_die "Das Admin-Konto besitzt keine nachweisbaren sudo-Rechte."

  [[ -d "$home" && ! -L "$home" ]] || hardening_die "Das Admin-Home ist kein vertrauenswuerdiges Verzeichnis."
  owner="$(stat --format='%u' -- "$home")"
  mode="$(stat --format='%a' -- "$home")"
  [[ ( "$owner" == "$uid" || "$owner" == "0" ) && $((8#$mode & 022)) -eq 0 ]] \
    || hardening_die "Das Admin-Home ist fuer unberechtigte Benutzer beschreibbar."

  ssh_dir="$home/.ssh"
  authorized_keys="$ssh_dir/authorized_keys"
  [[ -d "$ssh_dir" && ! -L "$ssh_dir" && -f "$authorized_keys" && ! -L "$authorized_keys" ]] \
    || hardening_die "Fuer den Admin fehlt eine regulaere authorized_keys-Datei."
  owner="$(stat --format='%u' -- "$ssh_dir")"
  mode="$(stat --format='%a' -- "$ssh_dir")"
  links="$(stat --format='%h' -- "$ssh_dir")"
  [[ "$owner" == "$uid" && $((8#$mode & 022)) -eq 0 && "$links" =~ ^[0-9]+$ && "$links" -ge 2 ]] \
    || hardening_die "Der Admin-SSH-Ordner ist unsicher."
  owner="$(stat --format='%u' -- "$authorized_keys")"
  mode="$(stat --format='%a' -- "$authorized_keys")"
  [[ "$owner" == "$uid" && $((8#$mode & 022)) -eq 0 && "$(stat --format='%h' -- "$authorized_keys")" == "1" ]] \
    || hardening_die "Die Admin-Schluesseldatei ist unsicher."
  awk '
    NF != 2 { exit 1 }
    $1 !~ /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/ { exit 1 }
    $2 !~ /^[A-Za-z0-9+\/]+={0,3}$/ { exit 1 }
    { keys += 1 }
    END { exit(keys > 0 ? 0 : 1) }
  ' "$authorized_keys" \
    || hardening_die "authorized_keys darf nur kommentarlosen Schluesselinhalt enthalten."
  LC_ALL=C ssh-keygen -l -f "$authorized_keys" >/dev/null 2>&1 \
    || hardening_die "Der Admin-SSH-Schluessel ist nicht parsebar."
}

sshd_effective_configuration() {
  local admin="$1" client_ip="$2" server_ip="$3" server_port="$4" error_file="$5"
  sshd -T -C "user=$admin,addr=$client_ip,laddr=$server_ip,lport=$server_port" 2>>"$error_file"
}

sshd_effective_has_exact_port() {
  local effective="$1" expected_port="$2"
  awk -v expected="$expected_port" '
    $1 == "port" { count += 1; if (NF != 2 || $2 != expected) invalid = 1 }
    END { exit(count == 1 && !invalid ? 0 : 1) }
  ' <<<"$effective"
}

sshd_validate_and_require_port() {
  local admin="$1" client_ip="$2" server_ip="$3" requested_port="$4" effective
  sshd -t >/dev/null 2>&1 || hardening_die "Die SSH-Konfiguration ist syntaktisch ungueltig."
  effective="$(sshd_effective_configuration "$admin" "$client_ip" "$server_ip" "$requested_port" /dev/null)" \
    || hardening_die "Die effektive SSH-Konfiguration konnte nicht geprueft werden."
  sshd_effective_has_exact_port "$effective" "$requested_port" \
    || hardening_die "SSH muss exakt einen wirksamen Port verwenden, der mit der Sitzung uebereinstimmt."
}

sshd_require_hardened_effective_policy() {
  local effective="${1,,}" expected
  # Keep this list aligned with templates/00-grabenplaner-hardening.conf.  The
  # port is deliberately checked against the live SSH session by the caller.
  for expected in \
    'permitrootlogin no' \
    'pubkeyauthentication yes' \
    'passwordauthentication no' \
    'kbdinteractiveauthentication no' \
    'authenticationmethods publickey' \
    'permitemptypasswords no' \
    'x11forwarding no' \
    'allowagentforwarding no' \
    'allowtcpforwarding local' \
    'gatewayports no' \
    'permittunnel no' \
    'permituserenvironment no' \
    'maxauthtries 3' \
    'logingracetime 30' \
    'clientaliveinterval 300' \
    'clientalivecountmax 2' \
    'loglevel verbose' \
    'strictmodes yes'; do
    grep -Fqx -- "$expected" <<<"$effective" \
      || hardening_die "Die wirksame SSH-Richtlinie entspricht nicht vollstaendig dem Sicherheitsprofil."
  done
}

ufw_is_active() {
  LC_ALL=C ufw status 2>/dev/null | grep -qx 'Status: active'
}

validate_effective_ufw_policy() {
  local mode="$1" port="$2" node added status baseline="" baseline_payload=""
  shift 2
  [[ "$mode" == baseline || "$mode" == complete ]] || return 1
  node="$(hardening_node)" || return 1
  added="$(LC_ALL=C ufw show added 2>/dev/null)" || return 1
  status="$(LC_ALL=C ufw status verbose 2>/dev/null)" || return 1
  if [[ -n "$UFW_TRANSITION_BASELINE_FILE" ]]; then
    private_file_is_secure "$UFW_TRANSITION_BASELINE_FILE" || return 1
    baseline="$(<"$UFW_TRANSITION_BASELINE_FILE")" || return 1
    baseline_payload="1$baseline"
  fi
  printf '%s\0%s\0%s' "$added" "$status" "$baseline_payload" | "$node" -e '
const fs = require("node:fs");
const policy = require(process.argv[1]);
const input = fs.readFileSync(0);
const first = input.indexOf(0);
const second = input.indexOf(0, first + 1);
if (first < 0 || second < 0) process.exit(1);
try {
  policy.validateUfwPolicy({
    addedRules: input.subarray(0, first).toString("utf8"),
    status: input.subarray(first + 1, second).toString("utf8"),
    baselineAddedRules: input.length > second + 1 && input[second + 1] === 49
      ? input.subarray(second + 2).toString("utf8") : null,
    sshPort: process.argv[3],
    allowedSources: process.argv.slice(4),
    requireComplete: process.argv[2] === "complete",
  });
} catch { process.exit(1); }
' "$POLICY_FILE" "$mode" "$port" "$@"
}

validate_ufw_support_file_transition() {
  local transaction_directory="$1" node
  node="$(hardening_node)" || return 1
  private_file_is_secure "$transaction_directory/backups/ufw-config" || return 1
  private_file_is_secure "$transaction_directory/backups/ufw-default" || return 1
  "$node" -e '
const fs = require("node:fs");
function verify(beforePath, currentPath, allowed) {
  const before = fs.readFileSync(beforePath, "utf8").replace(/\r\n/g, "\n").split("\n");
  const current = fs.readFileSync(currentPath, "utf8").replace(/\r\n/g, "\n").split("\n");
  const parse = (lines) => {
    const values = new Map();
    const rest = [];
    for (const line of lines) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (match && Object.hasOwn(allowed, match[1])) values.set(match[1], match[2]); else rest.push(line);
    }
    return { values, rest };
  };
  const a = parse(before); const b = parse(current);
  if (JSON.stringify(a.rest) !== JSON.stringify(b.rest)) throw new Error("foreign drift");
  for (const [key, desired] of Object.entries(allowed)) {
    const currentValue = b.values.get(key);
    if (currentValue !== a.values.get(key) && currentValue !== desired) throw new Error("invalid transition");
  }
}
verify(process.argv[1], process.argv[2], { ENABLED: "yes", LOGLEVEL: "low" });
verify(process.argv[3], process.argv[4], {
  DEFAULT_INPUT_POLICY: "\"DROP\"", DEFAULT_OUTPUT_POLICY: "\"ACCEPT\"", DEFAULT_FORWARD_POLICY: "\"DROP\"",
});
' "$transaction_directory/backups/ufw-config" "$UFW_CONFIG" \
    "$transaction_directory/backups/ufw-default" "$UFW_DEFAULT"
}

ufw_plan_preflight() {
  local port="$1"
  shift
  local source
  for source in "$@"; do
    LC_ALL=C ufw --dry-run allow proto tcp from "$source" to any port "$port" comment 'Grabenplaner managed SSH' >/dev/null 2>&1 \
      || hardening_die "Eine geplante SSH-Firewallregel ist ungueltig."
  done
  LC_ALL=C ufw --dry-run allow 80/tcp comment 'Grabenplaner managed HTTP' >/dev/null 2>&1 \
    || hardening_die "Die geplante HTTP-Firewallregel ist ungueltig."
  LC_ALL=C ufw --dry-run allow 443/tcp comment 'Grabenplaner managed HTTPS' >/dev/null 2>&1 \
    || hardening_die "Die geplante HTTPS-Firewallregel ist ungueltig."
  LC_ALL=C ufw --dry-run default deny incoming >/dev/null 2>&1 \
    || hardening_die "Die geplante eingehende Firewall-Policy ist ungueltig."
  LC_ALL=C ufw --dry-run default allow outgoing >/dev/null 2>&1 \
    || hardening_die "Die geplante ausgehende Firewall-Policy ist ungueltig."
  LC_ALL=C ufw --dry-run default deny routed >/dev/null 2>&1 \
    || hardening_die "Die geplante Routing-Firewall-Policy ist ungueltig."
  LC_ALL=C ufw --dry-run logging low >/dev/null 2>&1 \
    || hardening_die "Die geplante Firewall-Protokollierung ist ungueltig."
}

common_preflight() {
  hardening_require_root
  hardening_validate_os
  hardening_assert_installed_contract
  require_controller_dependencies
}

configured_preflight() {
  hardening_systemd_unit_exists "$HARDENING_ROLLBACK_TIMER" \
    || hardening_die "Der automatische Rollback-Timer ist nicht installiert."
  require_live_ssh_session "$CONFIG_ADMIN" "$CONFIG_SSH_PORT" "${CONFIG_SOURCES[@]}"
  admin_key_sudo_preflight "$CONFIG_ADMIN"
  sshd_validate_and_require_port "$CONFIG_ADMIN" "$SESSION_CLIENT_IP" "$SESSION_SERVER_IP" "$CONFIG_SSH_PORT"
  ufw_plan_preflight "$CONFIG_SSH_PORT" "${CONFIG_SOURCES[@]}"
  validate_effective_ufw_policy baseline "$CONFIG_SSH_PORT" "${CONFIG_SOURCES[@]}" \
    || hardening_die "Bestehende UFW-Freigaben sind breiter als die geplante Host-Sicherheitspolicy."
}

write_private_value() {
  local destination="$1" value="$2"
  hardening_atomic_private_write "$destination" "$value"
}

read_private_value() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" && "$(stat --format='%u:%g' -- "$file")" == "0:0" \
    && "$(stat --format='%a' -- "$file")" == "600" && "$(stat --format='%h' -- "$file")" == "1" ]] \
    || hardening_die "Private Transaktionsdaten fehlen oder sind unsicher."
  local value
  IFS= read -r value <"$file"
  printf '%s\n' "$value"
}

assert_private_file() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" && "$(stat --format='%u:%g' -- "$file")" == "0:0" \
    && "$(stat --format='%a' -- "$file")" == "600" && "$(stat --format='%h' -- "$file")" == "1" ]] \
    || hardening_die "Private Transaktionsdaten fehlen oder sind unsicher."
}

private_file_is_secure() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" && "$(stat --format='%u:%g:%a:%h' -- "$file")" == "0:0:600:1" ]]
}

managed_target_for_key() {
  case "$1" in
    ssh) printf '%s\n' "$SSH_DROPIN" ;;
    sysctl) printf '%s\n' "$SYSCTL_DROPIN" ;;
    journald) printf '%s\n' "$JOURNALD_DROPIN" ;;
    unattended) printf '%s\n' "$UNATTENDED_DROPIN" ;;
    auto-upgrades) printf '%s\n' "$AUTO_UPGRADES_DROPIN" ;;
    ufw-user) printf '%s\n' "$UFW_USER_RULES" ;;
    ufw-user6) printf '%s\n' "$UFW_USER6_RULES" ;;
    ufw-config) printf '%s\n' "$UFW_CONFIG" ;;
    ufw-default) printf '%s\n' "$UFW_DEFAULT" ;;
    *) return 1 ;;
  esac
}

manifest_record_for_key() {
  local manifest="$1" key="$2"
  awk -F '\t' -v key="$key" '$1 == key { if (found++) exit 2; record=$0 } END { if (found != 1) exit 1; print record }' "$manifest"
}

validate_manifest_record() {
  local record="$1" key="$2" record_key state hash uid gid mode
  IFS=$'\t' read -r record_key state hash uid gid mode <<<"$record"
  [[ "$record_key" == "$key" ]] || return 1
  if [[ "$state" == present ]]; then
    [[ "$hash" =~ ^[0-9a-f]{64}$ && "$uid" == 0 && "$gid" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ ]] \
      || return 1
    (( (8#$mode & 022) == 0 ))
  else
    [[ "$state" == absent && "$hash" == - && "$uid" == 0 && "$gid" == 0 && "$mode" == 0 ]]
  fi
}

file_matches_manifest_record() {
  local target="$1" record="$2" _ state hash uid gid mode
  IFS=$'\t' read -r _ state hash uid gid mode <<<"$record"
  if [[ "$state" == absent ]]; then
    [[ ! -e "$target" && ! -L "$target" ]]
    return
  fi
  [[ -f "$target" && ! -L "$target" && "$(stat --format='%h' -- "$target")" == 1 ]] || return 1
  [[ "$(sha256sum --binary -- "$target" | awk '{print tolower($1)}')" == "$hash" \
    && "$(stat --format='%u' -- "$target")" == "$uid" \
    && "$(stat --format='%g' -- "$target")" == "$gid" \
    && "$(stat --format='%a' -- "$target")" == "$mode" ]]
}

record_post_apply_state() {
  local transaction_directory="$1" manifest="$transaction_directory/post-apply.tsv" temporary key target hash uid gid mode
  [[ ! -e "$manifest" && ! -L "$manifest" ]] || return 1
  temporary="$(mktemp "$transaction_directory/.post-apply.XXXXXXXX")" || return 1
  : >"$temporary" || { rm -f -- "$temporary"; return 1; }
  for key in "${MANAGED_KEYS[@]}"; do
    target="$(managed_target_for_key "$key")" || { rm -f -- "$temporary"; return 1; }
    if [[ -e "$target" || -L "$target" ]]; then
      [[ -f "$target" && ! -L "$target" && "$(stat --format='%h' -- "$target")" == 1 ]] \
        || { rm -f -- "$temporary"; return 1; }
      hash="$(sha256sum --binary -- "$target" | awk '{print tolower($1)}')" || { rm -f -- "$temporary"; return 1; }
      uid="$(stat --format='%u' -- "$target")" || { rm -f -- "$temporary"; return 1; }
      gid="$(stat --format='%g' -- "$target")" || { rm -f -- "$temporary"; return 1; }
      mode="$(stat --format='%a' -- "$target")" || { rm -f -- "$temporary"; return 1; }
      [[ "$uid" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] \
        && (( (8#$mode & 022) == 0 )) || { rm -f -- "$temporary"; return 1; }
      printf '%s\tpresent\t%s\t%s\t%s\t%s\n' "$key" "$hash" "$uid" "$gid" "$mode" >>"$temporary" \
        || { rm -f -- "$temporary"; return 1; }
    else
      printf '%s\tabsent\t-\t0\t0\t0\n' "$key" >>"$temporary"
    fi
  done
  chown root:root -- "$temporary" || { rm -f -- "$temporary"; return 1; }
  chmod 0600 -- "$temporary" || { rm -f -- "$temporary"; return 1; }
  mv -f -- "$temporary" "$manifest" || { rm -f -- "$temporary"; return 1; }
  sync || return 1
}

write_apply_journal() {
  local transaction_directory="$1" phase="$2"
  case "$phase" in
    prepared|ufw_in_progress|ufw_complete|ssh_in_progress|ssh_complete|sysctl_in_progress|sysctl_complete|journald_in_progress|journald_complete|apt_in_progress|apt_complete|complete) ;;
    *) return 1 ;;
  esac
  write_private_value "$transaction_directory/apply-journal" "$phase"
}

record_intended_file_state() {
  local transaction_directory="$1" key="$2" source="$3" uid="$4" gid="$5" mode="$6" intended_directory hash record
  intended_directory="$transaction_directory/intended"
  if [[ ! -e "$intended_directory" && ! -L "$intended_directory" ]]; then
    install -d -o root -g root -m 0700 -- "$intended_directory"
  fi
  [[ -d "$intended_directory" && ! -L "$intended_directory" \
    && "$(stat --format='%u:%g:%a' -- "$intended_directory")" == "0:0:700" ]] || return 1
  [[ -f "$source" && ! -L "$source" && "$(stat --format='%h' -- "$source")" == 1 ]] || return 1
  hash="$(sha256sum --binary -- "$source" | awk '{print tolower($1)}')" || return 1
  record="$(printf '%s\tpresent\t%s\t%s\t%s\t%s' "$key" "$hash" "$uid" "$gid" "$mode")"
  validate_manifest_record "$record" "$key" || return 1
  write_private_value "$intended_directory/$key.tsv" "$record"
}

record_intended_current_state() {
  local transaction_directory="$1" key="$2" target uid gid mode
  target="$(managed_target_for_key "$key")" || return 1
  [[ -f "$target" && ! -L "$target" && "$(stat --format='%h' -- "$target")" == 1 ]] || return 1
  uid="$(stat --format='%u' -- "$target")" || return 1
  gid="$(stat --format='%g' -- "$target")" || return 1
  mode="$(stat --format='%a' -- "$target")" || return 1
  record_intended_file_state "$transaction_directory" "$key" "$target" "$uid" "$gid" "$mode"
}

intended_record_for_key() {
  local transaction_directory="$1" key="$2" file="$transaction_directory/intended/$key.tsv" record
  private_file_is_secure "$file" || return 1
  IFS= read -r record <"$file" || return 1
  validate_manifest_record "$record" "$key" || return 1
  printf '%s\n' "$record"
}

restore_permit_record_for_key() {
  local transaction_directory="$1" key="$2" file="$transaction_directory/restore-permits/$key.tsv" record
  private_file_is_secure "$file" || return 1
  IFS= read -r record <"$file" || return 1
  validate_manifest_record "$record" "$key" || return 1
  printf '%s\n' "$record"
}

record_restore_permitted_current_state() {
  local transaction_directory="$1" key="$2" directory target hash uid gid mode record
  directory="$transaction_directory/restore-permits"
  if [[ ! -e "$directory" && ! -L "$directory" ]]; then
    install -d -o root -g root -m 0700 -- "$directory" || return 1
  fi
  [[ -d "$directory" && ! -L "$directory" \
    && "$(stat --format='%u:%g:%a' -- "$directory")" == "0:0:700" ]] || return 1
  target="$(managed_target_for_key "$key")" || return 1
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" && "$(stat --format='%h' -- "$target")" == 1 ]] || return 1
    hash="$(sha256sum --binary -- "$target" | awk '{print tolower($1)}')" || return 1
    uid="$(stat --format='%u' -- "$target")" || return 1
    gid="$(stat --format='%g' -- "$target")" || return 1
    mode="$(stat --format='%a' -- "$target")" || return 1
    record="$(printf '%s\tpresent\t%s\t%s\t%s\t%s' "$key" "$hash" "$uid" "$gid" "$mode")"
  else
    record="$(printf '%s\tabsent\t-\t0\t0\t0' "$key")"
  fi
  validate_manifest_record "$record" "$key" || return 1
  write_private_value "$directory/$key.tsv" "$record"
}

backup_file() {
  local transaction_directory="$1" key="$2" target="$3" backup="$transaction_directory/backups/$key" metadata uid gid mode
  metadata="$transaction_directory/hashes.tsv"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" && "$(stat --format='%h' -- "$target")" == "1" ]] \
      || hardening_die "Eine zu sichernde Host-Konfigurationsdatei ist unzulaessig."
    uid="$(stat --format='%u' -- "$target")"
    gid="$(stat --format='%g' -- "$target")"
    mode="$(stat --format='%a' -- "$target")"
    [[ "$uid" == 0 && "$gid" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ ]] \
      && (( (8#$mode & 022) == 0 )) \
      || hardening_die "Eine Host-Konfigurationsdatei besitzt unsichere Vorgaengerrechte."
    install -o root -g root -m 0600 -- "$target" "$backup"
    printf '%s\tpresent\t%s\t%s\t%s\t%s\n' "$key" "$(sha256sum --binary -- "$backup" | awk '{print tolower($1)}')" \
      "$uid" "$gid" "$mode" >>"$metadata"
  else
    printf '%s\tabsent\t-\t0\t0\t0\n' "$key" >>"$metadata"
  fi
  chmod 0600 -- "$metadata"
  chown root:root -- "$metadata"
}

backup_host_configuration() {
  local transaction_directory="$1" ufw_added_before
  install -d -o root -g root -m 0700 -- "$transaction_directory/backups"
  : >"$transaction_directory/hashes.tsv"
  chmod 0600 -- "$transaction_directory/hashes.tsv"
  backup_file "$transaction_directory" ssh "$SSH_DROPIN"
  backup_file "$transaction_directory" sysctl "$SYSCTL_DROPIN"
  backup_file "$transaction_directory" journald "$JOURNALD_DROPIN"
  backup_file "$transaction_directory" unattended "$UNATTENDED_DROPIN"
  backup_file "$transaction_directory" auto-upgrades "$AUTO_UPGRADES_DROPIN"
  backup_file "$transaction_directory" ufw-user "$UFW_USER_RULES"
  backup_file "$transaction_directory" ufw-user6 "$UFW_USER6_RULES"
  backup_file "$transaction_directory" ufw-config "$UFW_CONFIG"
  backup_file "$transaction_directory" ufw-default "$UFW_DEFAULT"
  ufw_added_before="$(LC_ALL=C ufw show added 2>/dev/null)" \
    || hardening_die "Die bestehende UFW-Regelbasis konnte nicht gesichert werden."
  write_private_value "$transaction_directory/ufw-added-before" "$ufw_added_before"
  if ufw_is_active; then write_private_value "$transaction_directory/ufw-was-active" true
  else write_private_value "$transaction_directory/ufw-was-active" false; fi
}

restore_parent_is_secure() {
  local parent="$1" mode resolved
  [[ "$parent" == /* && -d "$parent" && ! -L "$parent" \
    && "$(stat --format='%u' -- "$parent")" == 0 ]] || return 1
  mode="$(stat --format='%a' -- "$parent")" || return 1
  (( (8#$mode & 022) == 0 )) || return 1
  resolved="$(readlink -f -- "$parent")" || return 1
  [[ "$resolved" == "$parent" ]]
}

current_target_is_restore_permitted() {
  local transaction_directory="$1" key="$2" target="$3" backup_record="$4"
  local manifest record state_file state=""
  if file_matches_manifest_record "$target" "$backup_record"; then return 0; fi
  manifest="$transaction_directory/post-apply.tsv"
  if [[ -e "$manifest" || -L "$manifest" ]]; then
    private_file_is_secure "$manifest" || return 1
    record="$(manifest_record_for_key "$manifest" "$key")" || return 1
    validate_manifest_record "$record" "$key" || return 1
    if file_matches_manifest_record "$target" "$record"; then return 0; fi
  fi
  manifest="$transaction_directory/intended/$key.tsv"
  if [[ -e "$manifest" || -L "$manifest" ]]; then
    private_file_is_secure "$manifest" || return 1
    IFS= read -r record <"$manifest" || return 1
    validate_manifest_record "$record" "$key" || return 1
    if file_matches_manifest_record "$target" "$record"; then return 0; fi
  fi
  state_file="$transaction_directory/state.json"
  if [[ -e "$state_file" || -L "$state_file" ]]; then
    state="$(transaction_state "$transaction_directory")" || return 1
  fi
  if [[ "$state" == rollback_in_progress ]]; then
    record="$(restore_permit_record_for_key "$transaction_directory" "$key")" || return 1
    if file_matches_manifest_record "$target" "$record"; then return 0; fi
  fi
  return 1
}

restore_file() {
  local transaction_directory="$1" key="$2" target="$3" record state hash uid gid mode backup parent temporary=""
  record="$(manifest_record_for_key "$transaction_directory/hashes.tsv" "$key")" || return 1
  validate_manifest_record "$record" "$key" || return 1
  IFS=$'\t' read -r _ state hash uid gid mode <<<"$record"
  parent="$(dirname -- "$target")" || return 1
  restore_parent_is_secure "$parent" || return 1

  if [[ "$state" == present ]]; then
    backup="$transaction_directory/backups/$key"
    private_file_is_secure "$backup" || return 1
    [[ "$(sha256sum --binary -- "$backup" | awk '{print tolower($1)}')" == "$hash" ]] || return 1
    if file_matches_manifest_record "$target" "$record"; then
      sync -f "$parent"
      return
    fi
    current_target_is_restore_permitted "$transaction_directory" "$key" "$target" "$record" || return 1
    temporary="$(mktemp "$parent/.grabenplaner-restore-${key}.XXXXXXXX")" || return 1
    if ! install -o "$uid" -g "$gid" -m "$mode" -- "$backup" "$temporary" \
      || ! file_matches_manifest_record "$temporary" "$record" \
      || ! sync -f "$temporary"; then
      rm -f -- "$temporary"
      return 1
    fi
    # Revalidate both the directory and current inode immediately before the
    # atomic replacement. A killed process therefore leaves either the exact
    # pre-restore record or the exact predecessor backup, never a partial file.
    if ! restore_parent_is_secure "$parent" \
      || ! current_target_is_restore_permitted "$transaction_directory" "$key" "$target" "$record" \
      || ! file_matches_manifest_record "$temporary" "$record" \
      || ! mv -fT -- "$temporary" "$target"; then
      rm -f -- "$temporary"
      return 1
    fi
    temporary=""
    sync -f "$parent" || return 1
    file_matches_manifest_record "$target" "$record"
  elif [[ "$state" == absent ]]; then
    if [[ ! -e "$target" && ! -L "$target" ]]; then
      sync -f "$parent"
      return
    fi
    current_target_is_restore_permitted "$transaction_directory" "$key" "$target" "$record" || return 1
    restore_parent_is_secure "$parent" \
      && current_target_is_restore_permitted "$transaction_directory" "$key" "$target" "$record" \
      && rm -f -- "$target" \
      && sync -f "$parent" \
      && [[ ! -e "$target" && ! -L "$target" ]]
  else
    return 1
  fi
}

transaction_state() {
  local transaction_directory="$1" node
  assert_private_file "$transaction_directory/state.json"
  node="$(hardening_node)" || return 1
  "$node" - "$transaction_directory/state.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value?.format !== "grabenplaner-host-security-transaction" || value?.schemaVersion !== 1 ||
    !["prepared", "pending_confirmation", "confirmed", "rollback_in_progress", "rolled_back"].includes(value?.state)) process.exit(1);
process.stdout.write(value.state);
NODE
}

preflight_rollback_transaction() {
  local transaction_directory="$1" state="$2" key target expected_record="" backup_record backup
  local backup_state backup_hash journal post_available=0 ufw_semantic_needed=0 intended_file permit_record
  local manifest="$transaction_directory/post-apply.tsv" backup_manifest="$transaction_directory/hashes.tsv"
  [[ -d "$transaction_directory" && ! -L "$transaction_directory" \
    && "$(stat --format='%u:%g:%a' -- "$transaction_directory")" == "0:0:700" ]] || return 1
  [[ -d "$transaction_directory/backups" && ! -L "$transaction_directory/backups" \
    && "$(stat --format='%u:%g:%a' -- "$transaction_directory/backups")" == "0:0:700" ]] || return 1
  private_file_is_secure "$backup_manifest" || return 1
  awk -F '\t' -v expected="${#MANAGED_KEYS[@]}" 'NF != 6 { exit 1 } END { exit(NR == expected ? 0 : 1) }' "$backup_manifest" || return 1
  private_file_is_secure "$transaction_directory/apply-journal" || return 1
  journal="$(read_private_value "$transaction_directory/apply-journal")" || return 1
  case "$journal" in
    prepared|ufw_in_progress|ufw_complete|ssh_in_progress|ssh_complete|sysctl_in_progress|sysctl_complete|journald_in_progress|journald_complete|apt_in_progress|apt_complete|complete) ;;
    *) return 1 ;;
  esac
  if [[ -e "$manifest" || -L "$manifest" ]]; then
    private_file_is_secure "$manifest" || return 1
    awk -F '\t' -v expected="${#MANAGED_KEYS[@]}" 'NF != 6 { exit 1 } END { exit(NR == expected ? 0 : 1) }' "$manifest" || return 1
    post_available=1
  elif [[ "$journal" == complete ]]; then
    return 1
  fi

  for key in admin ssh-port client-ip server-ip first-connection.sha256 first-session.sha256 created-epoch sources ufw-was-active ufw-added-before rollback-deadline-epoch; do
    private_file_is_secure "$transaction_directory/$key" || return 1
  done
  # Apply creates this boundary only after all managed mutations. Its absence
  # must not prevent rollback when apply is killed before reaching that point;
  # once present, however, unsafe metadata is always rejected.
  if [[ -e "$transaction_directory/confirmation-not-before-epoch" \
    || -L "$transaction_directory/confirmation-not-before-epoch" ]]; then
    private_file_is_secure "$transaction_directory/confirmation-not-before-epoch" || return 1
  fi
  ROLLBACK_ADMIN="$(read_private_value "$transaction_directory/admin")" || return 1
  ROLLBACK_CLIENT_IP="$(read_private_value "$transaction_directory/client-ip")" || return 1
  ROLLBACK_SERVER_IP="$(read_private_value "$transaction_directory/server-ip")" || return 1
  ROLLBACK_SSH_PORT="$(read_private_value "$transaction_directory/ssh-port")" || return 1
  ROLLBACK_UFW_WAS_ACTIVE="$(read_private_value "$transaction_directory/ufw-was-active")" || return 1
  mapfile -t ROLLBACK_SOURCES <"$transaction_directory/sources" || return 1
  policy_validate_configuration "$ROLLBACK_ADMIN" "$ROLLBACK_SSH_PORT" || return 1
  policy_validate_sources "${ROLLBACK_SOURCES[@]}" || return 1
  policy_validate_session "$ROLLBACK_CLIENT_IP" "${ROLLBACK_SOURCES[@]}" || return 1
  policy_validate_ip "$ROLLBACK_SERVER_IP" || return 1
  [[ "$ROLLBACK_UFW_WAS_ACTIVE" == true || "$ROLLBACK_UFW_WAS_ACTIVE" == false ]] || return 1

  # The write-ahead journal makes every group recoverable even if the process
  # dies before the final post-apply manifest exists. Each target must be the
  # exact predecessor, a predeclared own target, or the final recorded state.
  for key in "${MANAGED_KEYS[@]}"; do
    target="$(managed_target_for_key "$key")" || return 1
    backup_record="$(manifest_record_for_key "$backup_manifest" "$key")" || return 1
    validate_manifest_record "$backup_record" "$key" || return 1
    IFS=$'\t' read -r _ backup_state backup_hash _ _ _ <<<"$backup_record"
    if [[ "$backup_state" == present ]]; then
      backup="$transaction_directory/backups/$key"
      private_file_is_secure "$backup" || return 1
      [[ "$(sha256sum --binary -- "$backup" | awk '{print tolower($1)}')" == "$backup_hash" ]] || return 1
    fi
    if ((post_available == 1)); then
      expected_record="$(manifest_record_for_key "$manifest" "$key")" || return 1
      validate_manifest_record "$expected_record" "$key" || return 1
      if file_matches_manifest_record "$target" "$expected_record"; then continue; fi
      if [[ "$state" == rollback_in_progress ]] && file_matches_manifest_record "$target" "$backup_record"; then continue; fi
    else
      intended_file="$transaction_directory/intended/$key.tsv"
      if [[ -e "$intended_file" || -L "$intended_file" ]]; then
        expected_record="$(intended_record_for_key "$transaction_directory" "$key")" || return 1
        if file_matches_manifest_record "$target" "$expected_record"; then continue; fi
      fi
      if file_matches_manifest_record "$target" "$backup_record"; then continue; fi
      if [[ "$state" == rollback_in_progress ]]; then
        permit_record="$(restore_permit_record_for_key "$transaction_directory" "$key")" || permit_record=""
        if [[ -n "$permit_record" ]] && file_matches_manifest_record "$target" "$permit_record"; then continue; fi
      fi
      if [[ "$journal" == ufw_in_progress && " ${UFW_MANAGED_KEYS[*]} " == *" $key "* ]]; then
        ufw_semantic_needed=1
        continue
      fi
    fi
    hardening_warn "Rollback abgebrochen: Eine verwaltete Host-Datei wurde nachtraeglich veraendert ($key)."
    return 1
  done
  if ((ufw_semantic_needed == 1)); then
    UFW_TRANSITION_BASELINE_FILE="$transaction_directory/ufw-added-before"
    if ! validate_effective_ufw_policy baseline "$ROLLBACK_SSH_PORT" "${ROLLBACK_SOURCES[@]}"; then
      UFW_TRANSITION_BASELINE_FILE=""
      hardening_warn "Rollback abgebrochen: Der UFW-Zwischenzustand ist nicht als eigene Mutation nachweisbar."
      return 1
    fi
    validate_ufw_support_file_transition "$transaction_directory" \
      || { UFW_TRANSITION_BASELINE_FILE=""; hardening_warn "Rollback abgebrochen: UFW-Unterstuetzungsdateien enthalten Fremddrift."; return 1; }
    # Bind the semantically validated emergency state to exact per-file
    # records. A retry after SIGKILL accepts only these records or backups.
    for key in "${UFW_MANAGED_KEYS[@]}"; do
      record_restore_permitted_current_state "$transaction_directory" "$key" || { UFW_TRANSITION_BASELINE_FILE=""; return 1; }
    done
    # Re-evaluate the policy after recording and then prove that no file
    # changed between the semantic check and the exact-record handoff.
    validate_effective_ufw_policy baseline "$ROLLBACK_SSH_PORT" "${ROLLBACK_SOURCES[@]}" \
      || { UFW_TRANSITION_BASELINE_FILE=""; return 1; }
    validate_ufw_support_file_transition "$transaction_directory" \
      || { UFW_TRANSITION_BASELINE_FILE=""; return 1; }
    for key in "${UFW_MANAGED_KEYS[@]}"; do
      target="$(managed_target_for_key "$key")" || { UFW_TRANSITION_BASELINE_FILE=""; return 1; }
      permit_record="$(restore_permit_record_for_key "$transaction_directory" "$key")" \
        || { UFW_TRANSITION_BASELINE_FILE=""; return 1; }
      file_matches_manifest_record "$target" "$permit_record" \
        || { UFW_TRANSITION_BASELINE_FILE=""; return 1; }
    done
    UFW_TRANSITION_BASELINE_FILE=""
  fi
}

write_transaction_state() {
  local transaction_directory="$1" state="$2" content
  content="$(printf '{"format":"grabenplaner-host-security-transaction","schemaVersion":1,"state":"%s","updatedAt":"%s"}' \
    "$state" "$(date --utc '+%Y-%m-%dT%H:%M:%SZ')")"
  hardening_atomic_private_write "$transaction_directory/state.json" "$content"
}

refresh_audit_status() {
  # The dedicated read-only audit owns the one public machine-status schema.
  # Its non-zero result represents detected findings, not a controller failure.
  "$HARDENING_AUDIT_COMMAND" --write-status >/dev/null 2>&1 || true
}

start_rollback_guard() {
  local transaction_id="$1" delay_seconds="${2:-$ROLLBACK_CONFIRMATION_SECONDS}" transaction_directory deadline_epoch
  [[ "$delay_seconds" =~ ^[0-9]+$ && "$delay_seconds" -le 3600 ]] \
    || hardening_die "Die Rollback-Frist ist ungueltig."
  transaction_directory="$(transaction_directory "$transaction_id")"
  deadline_epoch="$(( $(date --utc '+%s') + delay_seconds ))"
  write_private_value "$transaction_directory/rollback-deadline-epoch" "$deadline_epoch"
  write_private_value "$HARDENING_PENDING_FILE" "$transaction_id"
  if ! systemctl enable --now "$HARDENING_ROLLBACK_TIMER"; then
    systemctl disable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 || true
    rm -f -- "$HARDENING_PENDING_FILE"
    sync
    hardening_die "Der automatische Sicherheits-Rollback konnte nicht aktiviert werden."
  fi
  if ! sync; then
    systemctl disable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 || true
    rm -f -- "$HARDENING_PENDING_FILE"
    sync
    hardening_die "Der automatische Sicherheits-Rollback konnte nicht dauerhaft gesichert werden."
  fi
}

apply_ufw_rules() {
  local transaction_directory="$1" port="$2"
  shift 2
  local source log="$transaction_directory/ufw-private.log"
  : >"$log"
  chmod 0600 -- "$log"
  # SSH allow rules are deliberately installed before UFW can be activated.
  for source in "$@"; do
    LC_ALL=C ufw allow proto tcp from "$source" to any port "$port" comment 'Grabenplaner managed SSH' >>"$log" 2>&1 \
      || hardening_die "Eine SSH-Firewallregel konnte nicht gesetzt werden."
  done
  LC_ALL=C ufw allow 80/tcp comment 'Grabenplaner managed HTTP' >>"$log" 2>&1 \
    || hardening_die "Die HTTP-Firewallregel konnte nicht gesetzt werden."
  LC_ALL=C ufw allow 443/tcp comment 'Grabenplaner managed HTTPS' >>"$log" 2>&1 \
    || hardening_die "Die HTTPS-Firewallregel konnte nicht gesetzt werden."
  LC_ALL=C ufw default deny incoming >>"$log" 2>&1 \
    || hardening_die "Die eingehende Firewall-Policy konnte nicht gesetzt werden."
  LC_ALL=C ufw default allow outgoing >>"$log" 2>&1 \
    || hardening_die "Die ausgehende Firewall-Policy konnte nicht gesetzt werden."
  LC_ALL=C ufw default deny routed >>"$log" 2>&1 \
    || hardening_die "Die Routing-Firewall-Policy konnte nicht gesetzt werden."
  LC_ALL=C ufw logging low >>"$log" 2>&1 \
    || hardening_die "Die begrenzte Firewall-Protokollierung konnte nicht gesetzt werden."
  LC_ALL=C ufw --force enable >>"$log" 2>&1 || hardening_die "UFW konnte nicht sicher aktiviert werden."
  validate_effective_ufw_policy complete "$port" "$@" \
    || hardening_die "Die wirksame UFW-Policy ist nicht exakt auf SSH, HTTP und HTTPS begrenzt."
}

validate_effective_apt_configuration() {
  local effective log="$1" origin base=0 apps=0 infra=0
  local -a origins=()
  effective="$(LC_ALL=C apt-config dump 2>>"$log")" \
    || hardening_die "Die wirksame APT-Konfiguration konnte nicht gelesen werden."
  grep -Fqx 'APT::Periodic::Update-Package-Lists "1";' <<<"$effective" \
    || hardening_die "Automatische Paketlisten-Aktualisierungen sind nicht wirksam."
  grep -Fqx 'APT::Periodic::Unattended-Upgrade "1";' <<<"$effective" \
    || hardening_die "Automatische Sicherheitsaktualisierungen sind nicht wirksam."
  grep -Fqx 'Unattended-Upgrade::Automatic-Reboot "false";' <<<"$effective" \
    || hardening_die "Der automatische Serverneustart ist nicht sicher deaktiviert."
  grep -Fqx 'Unattended-Upgrade::Remove-Unused-Dependencies "false";' <<<"$effective" \
    || hardening_die "Die automatische Abhaengigkeitsentfernung ist nicht sicher deaktiviert."
  ! grep -Eq '^Unattended-Upgrade::Origins-Pattern::' <<<"$effective" \
    || hardening_die "APT Origins-Pattern darf keine zusaetzlichen Paketquellen freigeben."
  mapfile -t origins < <(awk -F '"' '/^Unattended-Upgrade::Allowed-Origins::[[:space:]]/ { print $2 }' <<<"$effective")
  [[ ${#origins[@]} -eq 3 ]] || hardening_die "APT muss exakt Security und ESM-Security verwenden."
  for origin in "${origins[@]}"; do
    case "$origin" in
      '${distro_id}:${distro_codename}-security'|Ubuntu:"${VERSION_CODENAME}"-security) ((base += 1)) ;;
      '${distro_id}ESMApps:${distro_codename}-apps-security'|UbuntuESMApps:"${VERSION_CODENAME}"-apps-security) ((apps += 1)) ;;
      '${distro_id}ESM:${distro_codename}-infra-security'|UbuntuESM:"${VERSION_CODENAME}"-infra-security) ((infra += 1)) ;;
      *) hardening_die "Eine nicht freigegebene APT-Paketquelle ist wirksam." ;;
    esac
  done
  [[ "$base" == 1 && "$apps" == 1 && "$infra" == 1 ]] \
    || hardening_die "APT Security-/ESM-Quellen sind unvollstaendig oder doppelt."
  for timer in apt-daily.timer apt-daily-upgrade.timer; do
    systemctl is-enabled --quiet "$timer" && systemctl is-active --quiet "$timer" \
      || hardening_die "Der APT-Sicherheitstimer $timer ist nicht aktiv."
  done
}

validate_effective_sysctl_configuration() {
  local line key expected actual
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" && "$line" != \#* ]] || continue
    key="${line%%=*}"
    expected="${line#*=}"
    key="$(awk '{$1=$1; print}' <<<"$key")"
    expected="$(awk '{$1=$1; print}' <<<"$expected")"
    actual="$(sysctl -n "$key" 2>/dev/null)" || return 1
    actual="$(awk '{$1=$1; print}' <<<"$actual")"
    [[ "$actual" == "$expected" ]] || return 1
  done <"$TEMPLATE_ROOT/60-grabenplaner-sysctl.conf"
}

validate_effective_journald_configuration() {
  local merged line key expected actual
  merged="$(systemd-analyze cat-config systemd/journald.conf 2>/dev/null)" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" && "$line" != \#* && "$line" != \[* ]] || continue
    key="${line%%=*}"
    expected="${line#*=}"
    key="$(awk '{$1=$1; print}' <<<"$key")"
    expected="$(awk '{$1=$1; print}' <<<"$expected")"
    actual="$(awk -F= -v wanted="$key" '
      /^\[Journal\][[:space:]]*$/ { section="Journal"; next }
      /^\[/ { section="other"; next }
      section == "Journal" {
        current=$1; gsub(/^[[:space:]]+|[[:space:]]+$/, "", current)
        if (current == wanted) { value=substr($0, index($0, "=")+1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); found=1 }
      }
      END { if (!found) exit 1; print value }
    ' <<<"$merged")" || return 1
    [[ "$actual" == "$expected" ]] || return 1
  done <"$TEMPLATE_ROOT/60-grabenplaner-journald.conf"
  systemctl is-active --quiet systemd-journald.service
}

install_managed_templates() {
  local transaction_directory="$1" effective
  record_intended_file_state "$transaction_directory" ssh "$TEMPLATE_ROOT/00-grabenplaner-hardening.conf" 0 0 644
  write_apply_journal "$transaction_directory" ssh_in_progress
  hardening_atomic_install "$TEMPLATE_ROOT/00-grabenplaner-hardening.conf" "$SSH_DROPIN" 0644
  # A reload is allowed only after both syntax and effective-policy checks.
  sshd -t >/dev/null 2>"$transaction_directory/sshd-private.log" \
    || hardening_die "Die vorbereitete SSH-Konfiguration ist ungueltig."
  effective="$(sshd_effective_configuration "$CONFIG_ADMIN" "$SESSION_CLIENT_IP" "$SESSION_SERVER_IP" "$CONFIG_SSH_PORT" \
    "$transaction_directory/sshd-private.log")" \
    || hardening_die "Die vorbereitete effektive SSH-Konfiguration ist ungueltig."
  sshd_effective_has_exact_port "$effective" "$CONFIG_SSH_PORT" \
    || hardening_die "Die SSH-Konfiguration wuerde keinen eindeutigen aktiven Port verwenden."
  sshd_require_hardened_effective_policy "$effective"
  systemctl reload ssh.service
  write_apply_journal "$transaction_directory" ssh_complete

  record_intended_file_state "$transaction_directory" sysctl "$TEMPLATE_ROOT/60-grabenplaner-sysctl.conf" 0 0 644
  write_apply_journal "$transaction_directory" sysctl_in_progress
  hardening_atomic_install "$TEMPLATE_ROOT/60-grabenplaner-sysctl.conf" "$SYSCTL_DROPIN" 0644
  sysctl --system >"$transaction_directory/sysctl-private.log" 2>&1 \
    || hardening_die "Die konservativen Kernel-Einstellungen konnten nicht angewendet werden."
  validate_effective_sysctl_configuration \
    || hardening_die "Eine spaetere sysctl-Konfiguration ueberschreibt das Sicherheitsprofil."
  write_apply_journal "$transaction_directory" sysctl_complete

  record_intended_file_state "$transaction_directory" journald "$TEMPLATE_ROOT/60-grabenplaner-journald.conf" 0 0 644
  write_apply_journal "$transaction_directory" journald_in_progress
  hardening_atomic_install "$TEMPLATE_ROOT/60-grabenplaner-journald.conf" "$JOURNALD_DROPIN" 0644
  systemctl restart systemd-journald.service
  systemctl is-active --quiet systemd-journald.service \
    || hardening_die "Die begrenzte Journal-Konfiguration konnte nicht aktiviert werden."
  validate_effective_journald_configuration \
    || hardening_die "Die wirksame Journal-Konfiguration weicht vom Sicherheitsprofil ab."
  write_apply_journal "$transaction_directory" journald_complete

  record_intended_file_state "$transaction_directory" unattended "$TEMPLATE_ROOT/60grabenplaner-unattended-upgrades" 0 0 644
  record_intended_file_state "$transaction_directory" auto-upgrades "$TEMPLATE_ROOT/60grabenplaner-auto-upgrades" 0 0 644
  write_apply_journal "$transaction_directory" apt_in_progress
  hardening_atomic_install "$TEMPLATE_ROOT/60grabenplaner-unattended-upgrades" "$UNATTENDED_DROPIN" 0644
  hardening_atomic_install "$TEMPLATE_ROOT/60grabenplaner-auto-upgrades" "$AUTO_UPGRADES_DROPIN" 0644
  validate_effective_apt_configuration "$transaction_directory/apt-private.log"
  write_apply_journal "$transaction_directory" apt_complete
}

restore_host_configuration() {
  local transaction_directory="$1" effective="" errors=0 ssh_restored=1 sysctl_restored=1
  local journald_restored=1 apt_restored=1 ufw_restored=1 log="$transaction_directory/rollback-private.log"
  : >"$log" || return 1
  chown root:root -- "$log" || return 1
  chmod 0600 -- "$log" || return 1

  if ! restore_file "$transaction_directory" ssh "$SSH_DROPIN"; then ssh_restored=0; ((errors += 1)); fi
  if ((ssh_restored == 1)); then
    if ! sshd -t >/dev/null 2>>"$log"; then
      ((errors += 1))
    elif ! effective="$(sshd_effective_configuration "$ROLLBACK_ADMIN" "$ROLLBACK_CLIENT_IP" "$ROLLBACK_SERVER_IP" \
      "$ROLLBACK_SSH_PORT" "$log")" || [[ -z "$effective" ]] \
      || ! sshd_effective_has_exact_port "$effective" "$ROLLBACK_SSH_PORT"; then
      ((errors += 1))
    elif ! systemctl reload ssh.service >>"$log" 2>&1; then
      ((errors += 1))
    fi
  fi

  if ! restore_file "$transaction_directory" sysctl "$SYSCTL_DROPIN"; then sysctl_restored=0; ((errors += 1)); fi
  if ((sysctl_restored == 1)) && ! sysctl --system >>"$log" 2>&1; then ((errors += 1)); fi

  if ! restore_file "$transaction_directory" journald "$JOURNALD_DROPIN"; then journald_restored=0; ((errors += 1)); fi
  if ((journald_restored == 1)); then
    if ! systemctl restart systemd-journald.service >>"$log" 2>&1; then
      ((errors += 1))
    elif ! systemctl is-active --quiet systemd-journald.service; then
      ((errors += 1))
    fi
  fi

  if ! restore_file "$transaction_directory" unattended "$UNATTENDED_DROPIN"; then apt_restored=0; ((errors += 1)); fi
  if ! restore_file "$transaction_directory" auto-upgrades "$AUTO_UPGRADES_DROPIN"; then apt_restored=0; ((errors += 1)); fi
  if ((apt_restored == 1)) && ! LC_ALL=C apt-config dump >/dev/null 2>>"$log"; then ((errors += 1)); fi

  # Recheck UFW immediately before its first restore mutation; earlier SSH,
  # sysctl, journald or APT work must not widen the drift race window.
  if ! preflight_rollback_transaction "$transaction_directory" rollback_in_progress; then
    ufw_restored=0
    ((errors += 1))
  fi
  if ((ufw_restored == 1)) && ! restore_file "$transaction_directory" ufw-user "$UFW_USER_RULES"; then ufw_restored=0; ((errors += 1)); fi
  if ((ufw_restored == 1)) && ! restore_file "$transaction_directory" ufw-user6 "$UFW_USER6_RULES"; then ufw_restored=0; ((errors += 1)); fi
  if ((ufw_restored == 1)) && ! restore_file "$transaction_directory" ufw-config "$UFW_CONFIG"; then ufw_restored=0; ((errors += 1)); fi
  if ((ufw_restored == 1)) && ! restore_file "$transaction_directory" ufw-default "$UFW_DEFAULT"; then ufw_restored=0; ((errors += 1)); fi
  if ((ufw_restored == 1)); then
    if [[ "$ROLLBACK_UFW_WAS_ACTIVE" == true ]]; then
      LC_ALL=C ufw reload >>"$log" 2>&1 || ((errors += 1))
    else
      LC_ALL=C ufw --force disable >>"$log" 2>&1 || ((errors += 1))
    fi
  fi
  if ! sync; then ((errors += 1)); fi
  if ((errors > 0)); then
    hardening_warn "Rollback unvollstaendig: $errors Wiederherstellungsschritt(e) sind fehlgeschlagen."
    return 1
  fi
}

finalize_rollback_success() {
  local transaction_id="$1" pending="" active=""
  if [[ -f "$HARDENING_PENDING_FILE" && ! -L "$HARDENING_PENDING_FILE" ]]; then
    pending="$(read_private_value "$HARDENING_PENDING_FILE")" || return 1
    [[ "$pending" == "$transaction_id" ]] || return 1
  fi
  if [[ -f "$ACTIVE_TRANSACTION_FILE" && ! -L "$ACTIVE_TRANSACTION_FILE" ]]; then
    active="$(read_private_value "$ACTIVE_TRANSACTION_FILE")" || return 1
    [[ "$active" == "$transaction_id" ]] || return 1
  fi
  # Keep both markers intact unless the guard can actually be disabled.
  if ! systemctl disable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1; then
    systemctl enable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 || true
    return 1
  fi
  if [[ -n "$pending" ]] && ! rm -f -- "$HARDENING_PENDING_FILE"; then
    systemctl enable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 || true
    return 1
  fi
  if [[ -n "$active" ]] && ! rm -f -- "$ACTIVE_TRANSACTION_FILE"; then
    write_private_value "$HARDENING_PENDING_FILE" "$transaction_id" || true
    systemctl enable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 || true
    return 1
  fi
  if ! sync; then
    write_private_value "$HARDENING_PENDING_FILE" "$transaction_id" || true
    systemctl enable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 || true
    return 1
  fi
  refresh_audit_status
}

rollback_transaction() {
  local transaction_id="$1" transaction_directory state
  policy_validate_transaction "$transaction_id" || return 1
  transaction_directory="$(transaction_directory "$transaction_id")"
  [[ -d "$transaction_directory" && ! -L "$transaction_directory" ]] || return 1
  state="$(transaction_state "$transaction_directory")" || return 1
  if [[ "$state" == rolled_back ]]; then
    finalize_rollback_success "$transaction_id"
    return 0
  fi
  preflight_rollback_transaction "$transaction_directory" "$state" || return 1
  write_transaction_state "$transaction_directory" rollback_in_progress || return 1
  sync || return 1
  if ! restore_host_configuration "$transaction_directory"; then
    # Deliberately retain the pending marker and timer. The next automatic
    # attempt accepts only exact post-apply or already restored backup states.
    return 1
  fi
  write_transaction_state "$transaction_directory" rolled_back || return 1
  sync || return 1
  finalize_rollback_success "$transaction_id" || return 1
}

rollback_on_failed_apply() {
  local status=$?
  trap - EXIT
  if ((ROLLBACK_ARMED == 1)) && [[ -n "$ROLLBACK_TRANSACTION" ]]; then
    rollback_transaction "$ROLLBACK_TRANSACTION" >/dev/null 2>&1 || true
  fi
  exit "$status"
}

audit_command() {
  exec "$HARDENING_AUDIT_COMMAND" "$@"
}

plan_command() {
  common_preflight
  parse_configuration_arguments "$@"
  configured_preflight
  local ufw_active=false reboot_required=false
  ufw_is_active && ufw_active=true
  [[ -f /run/reboot-required ]] && reboot_required=true
  command_json plan ready "${#CONFIG_SOURCES[@]}" true false "$reboot_required"
}

apply_command() {
  common_preflight
  parse_configuration_arguments "$@"
  hardening_secure_roots
  acquire_controller_lock
  [[ ! -e "$HARDENING_PENDING_FILE" && ! -L "$HARDENING_PENDING_FILE" ]] \
    || hardening_die "Eine unbestaetigte Host-Sicherheitstransaktion ist bereits aktiv."
  [[ ! -e "$ACTIVE_TRANSACTION_FILE" && ! -L "$ACTIVE_TRANSACTION_FILE" ]] \
    || hardening_die "Die aktive Host-Sicherheitspolicy muss vor einer neuen Anwendung ausdruecklich zurueckgerollt werden."
  configured_preflight

  local transaction_id transaction_directory created_epoch confirmation_not_before_epoch sources_content
  transaction_id="$(generate_transaction_id)"
  transaction_directory="$(transaction_directory "$transaction_id")"
  install -d -o root -g root -m 0700 -- "$transaction_directory"
  created_epoch="$(date --utc '+%s')"
  write_private_value "$transaction_directory/admin" "$CONFIG_ADMIN"
  write_private_value "$transaction_directory/ssh-port" "$CONFIG_SSH_PORT"
  write_private_value "$transaction_directory/client-ip" "$SESSION_CLIENT_IP"
  write_private_value "$transaction_directory/server-ip" "$SESSION_SERVER_IP"
  write_private_value "$transaction_directory/first-connection.sha256" "$SESSION_CONNECTION_FINGERPRINT"
  write_private_value "$transaction_directory/first-session.sha256" "$SESSION_FINGERPRINT"
  write_private_value "$transaction_directory/created-epoch" "$created_epoch"
  sources_content="$(printf '%s\n' "${CONFIG_SOURCES[@]}")"
  write_private_value "$transaction_directory/sources" "$sources_content"
  # A confirmed policy must be rolled back before a different policy can be applied.
  backup_host_configuration "$transaction_directory"
  write_apply_journal "$transaction_directory" prepared
  write_transaction_state "$transaction_directory" prepared

  # The rollback timer is armed before the first firewall, SSH or kernel mutation.
  start_rollback_guard "$transaction_id"
  ROLLBACK_ARMED=1
  ROLLBACK_TRANSACTION="$transaction_id"
  trap rollback_on_failed_apply EXIT

  write_apply_journal "$transaction_directory" ufw_in_progress
  apply_ufw_rules "$transaction_directory" "$CONFIG_SSH_PORT" "${CONFIG_SOURCES[@]}"
  local key
  for key in "${UFW_MANAGED_KEYS[@]}"; do
    record_intended_current_state "$transaction_directory" "$key" \
      || hardening_die "Der eigene UFW-Zwischenzustand konnte nicht nachgewiesen werden."
  done
  write_apply_journal "$transaction_directory" ufw_complete
  install_managed_templates "$transaction_directory"
  record_post_apply_state "$transaction_directory" \
    || hardening_die "Der manipulationssichere Nachweis des angewendeten Hostzustands konnte nicht gespeichert werden."
  write_apply_journal "$transaction_directory" complete
  # Confirmation must come from an SSH transport created after every managed
  # mutation and the durable post-apply record. TTY ctime has second precision,
  # therefore confirm deliberately requires a strictly later second.
  confirmation_not_before_epoch="$(date --utc '+%s')"
  write_private_value "$transaction_directory/confirmation-not-before-epoch" "$confirmation_not_before_epoch"
  write_transaction_state "$transaction_directory" pending_confirmation
  refresh_audit_status

  ROLLBACK_ARMED=0
  trap - EXIT
  printf '{"format":"grabenplaner-host-security-apply","schemaVersion":1,"state":"pending_confirmation","transactionId":"%s","sourceCount":%d,"clientMatched":true}\n' \
    "$transaction_id" "${#CONFIG_SOURCES[@]}"
}

load_transaction_session_policy() {
  local transaction_directory="$1"
  CONFIG_ADMIN="$(read_private_value "$transaction_directory/admin")"
  CONFIG_SSH_PORT="$(read_private_value "$transaction_directory/ssh-port")"
  assert_private_file "$transaction_directory/sources"
  mapfile -t CONFIG_SOURCES <"$transaction_directory/sources"
  [[ ${#CONFIG_SOURCES[@]} -gt 0 ]] || hardening_die "Die Transaktion enthaelt keine erlaubten Quellen."
  policy_validate_configuration "$CONFIG_ADMIN" "$CONFIG_SSH_PORT" || hardening_die "Die Transaktionspolicy ist ungueltig."
  policy_validate_sources "${CONFIG_SOURCES[@]}" || hardening_die "Die gespeicherten SSH-Quellnetze sind ungueltig."
}

confirm_command() {
  local transaction_id=""
  while (($#)); do
    case "$1" in
      --transaction)
        [[ -z "$transaction_id" && $# -ge 2 ]] || hardening_die "Die Transaktionsangabe ist ungueltig."
        transaction_id="$2"
        shift 2
        ;;
      --transaction=*)
        [[ -z "$transaction_id" && -n "${1#*=}" ]] || hardening_die "Die Transaktionsangabe ist ungueltig."
        transaction_id="${1#*=}"
        shift
        ;;
      *) hardening_die "Unbekannte Bestaetigungsoption." ;;
    esac
  done
  policy_validate_transaction "$transaction_id" || hardening_die "Die Transaktions-ID ist ungueltig."
  common_preflight
  acquire_controller_lock
  local pending transaction_directory first_connection first_session confirmation_not_before_epoch tty_epoch effective confirmation_complete=0
  pending="$(read_private_value "$HARDENING_PENDING_FILE")"
  [[ "$pending" == "$transaction_id" ]] || hardening_die "Diese Transaktion wartet nicht auf Bestaetigung."
  transaction_directory="$(transaction_directory "$transaction_id")"
  load_transaction_session_policy "$transaction_directory"
  require_live_ssh_session "$CONFIG_ADMIN" "$CONFIG_SSH_PORT" "${CONFIG_SOURCES[@]}"
  admin_key_sudo_preflight "$CONFIG_ADMIN"
  first_connection="$(read_private_value "$transaction_directory/first-connection.sha256")"
  policy_validate_transaction "$first_connection" \
    || hardening_die "Der gespeicherte SSH-Verbindungsnachweis ist ungueltig."
  ssh_connection_is_independent "$SESSION_CONNECTION_FINGERPRINT" "$first_connection" \
    || hardening_die "Die Bestaetigung muss ueber eine eigenstaendige neue SSH-Verbindung erfolgen."
  first_session="$(read_private_value "$transaction_directory/first-session.sha256")"
  policy_validate_transaction "$first_session" \
    || hardening_die "Der gespeicherte SSH-Sitzungsnachweis ist ungueltig."
  [[ "$SESSION_FINGERPRINT" != "$first_session" ]] || hardening_die "Die Bestaetigung muss aus einer zweiten SSH-Sitzung erfolgen."
  confirmation_not_before_epoch="$(read_private_value "$transaction_directory/confirmation-not-before-epoch")"
  tty_epoch="$(stat --format='%Z' -- "$SSH_TTY")"
  [[ "$confirmation_not_before_epoch" =~ ^[0-9]+$ && "$tty_epoch" =~ ^[0-9]+$ \
    && "$tty_epoch" -gt "$confirmation_not_before_epoch" ]] \
    || hardening_die "Die zweite SSH-Sitzung wurde nicht nach der Aenderung geoeffnet."
  sshd -t >/dev/null 2>"$transaction_directory/confirm-private.log" \
    || hardening_die "Die SSH-Konfiguration ist vor der Bestaetigung ungueltig."
  effective="$(sshd_effective_configuration "$CONFIG_ADMIN" "$SESSION_CLIENT_IP" "$SESSION_SERVER_IP" "$CONFIG_SSH_PORT" \
    "$transaction_directory/confirm-private.log")" \
    || hardening_die "Die effektive SSH-Konfiguration ist vor der Bestaetigung ungueltig."
  sshd_effective_has_exact_port "$effective" "$CONFIG_SSH_PORT" \
    || hardening_die "SSH verwendet vor der Bestaetigung nicht exakt den Port der bestaetigten Sitzung."
  sshd_require_hardened_effective_policy "$effective"
  [[ "$(transaction_state "$transaction_directory")" == pending_confirmation ]] \
    || hardening_die "Die Transaktion befindet sich nicht im erwarteten Bestaetigungszustand."
  preflight_rollback_transaction "$transaction_directory" pending_confirmation \
    || hardening_die "Die angewendete Host-Konfiguration wurde seit dem Apply veraendert."
  validate_effective_ufw_policy complete "$CONFIG_SSH_PORT" "${CONFIG_SOURCES[@]}" \
    || hardening_die "Die wirksame UFW-Policy ist vor der Bestaetigung nicht fail-closed."
  validate_effective_apt_configuration "$transaction_directory/confirm-private.log"
  validate_effective_sysctl_configuration \
    || hardening_die "Die wirksame sysctl-Policy weicht vor der Bestaetigung ab."
  validate_effective_journald_configuration \
    || hardening_die "Die wirksame Journal-Policy weicht vor der Bestaetigung ab."
  # Confirmation is committed crash-safely: active marker and confirmed state
  # reach disk first, then the pending marker is removed, and only afterwards
  # may the rollback timer be disabled.
  trap 'status=$?; if ((confirmation_complete == 0)) && [[ -f "$HARDENING_PENDING_FILE" ]]; then systemctl enable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 && sync || true; fi; exit "$status"' EXIT
  write_private_value "$ACTIVE_TRANSACTION_FILE" "$transaction_id"
  write_transaction_state "$transaction_directory" confirmed
  sync
  rm -f -- "$HARDENING_PENDING_FILE"
  sync
  systemctl disable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 || true
  sync
  confirmation_complete=1
  trap - EXIT
  refresh_audit_status
  command_json confirm confirmed "${#CONFIG_SOURCES[@]}" true false false
}

rollback_command() {
  local transaction_id=""
  while (($#)); do
    case "$1" in
      --transaction)
        [[ -z "$transaction_id" && $# -ge 2 ]] || hardening_die "Die Transaktionsangabe ist ungueltig."
        transaction_id="$2"
        shift 2
        ;;
      --transaction=*) transaction_id="${1#*=}"; shift ;;
      *) hardening_die "Unbekannte Rollback-Option." ;;
    esac
  done
  policy_validate_transaction "$transaction_id" || hardening_die "Die Transaktions-ID ist ungueltig."
  common_preflight
  acquire_controller_lock
  local pending="" active=""
  [[ -f "$HARDENING_PENDING_FILE" ]] && pending="$(read_private_value "$HARDENING_PENDING_FILE")"
  [[ -f "$ACTIVE_TRANSACTION_FILE" ]] && active="$(read_private_value "$ACTIVE_TRANSACTION_FILE")"
  if [[ -n "$pending" ]]; then
    [[ "$transaction_id" == "$pending" ]] \
      || hardening_die "Solange eine Bestaetigung aussteht, darf nur diese Transaktion zurueckgerollt werden."
  else
    [[ -n "$active" && "$transaction_id" == "$active" ]] \
      || hardening_die "Nur die aktive Transaktion darf zurueckgerollt werden."
    # Explicit rollback of a confirmed policy gets the same crash guard as an
    # apply. The marker remains armed unless every restore step succeeds.
    start_rollback_guard "$transaction_id" 0
  fi
  rollback_transaction "$transaction_id" \
    || hardening_die "Der Rollback ist unvollstaendig; Schutzmarker und automatischer Wiederholungsversuch bleiben aktiv."
  command_json rollback rolled_back 0 false false false
}

rollback_pending_command() {
  [[ "${1:-}" == "--automatic" && $# -eq 1 ]] || hardening_die "Rollback-pending ist ausschliesslich fuer den Sicherheitstimer vorgesehen."
  common_preflight
  if ! hardening_acquire_controller_lock automatic "$AUTOMATIC_ROLLBACK_LOCK_WAIT_SECONDS"; then
    hardening_warn "Der automatische Rollback wartet auf eine laufende Host-Sicherheitsoperation."
    return 1
  fi
  if [[ ! -f "$HARDENING_PENDING_FILE" || -L "$HARDENING_PENDING_FILE" ]]; then
    systemctl disable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 || true
    sync
    return 0
  fi
  local transaction_id transaction_directory deadline_epoch now_epoch
  transaction_id="$(read_private_value "$HARDENING_PENDING_FILE")"
  policy_validate_transaction "$transaction_id" || hardening_die "Die ausstehende Transaktion ist ungueltig."
  transaction_directory="$(transaction_directory "$transaction_id")"
  deadline_epoch="$(read_private_value "$transaction_directory/rollback-deadline-epoch")"
  now_epoch="$(date --utc '+%s')"
  [[ "$deadline_epoch" =~ ^[0-9]{10,}$ && "$now_epoch" =~ ^[0-9]{10,}$ ]] \
    || hardening_die "Die gespeicherte Rollback-Frist ist ungueltig."
  if ((now_epoch < deadline_epoch)); then
    command_json rollback-pending waiting 0 false true false
    return 0
  fi
  rollback_transaction "$transaction_id" || return 1
  command_json rollback-pending rolled_back 0 false false false
}

usage() {
  printf '%s\n' \
    "Usage:" \
    "  $CONTROLLER_NAME [audit [--write-status]]" \
    "  $CONTROLLER_NAME plan --admin USER --ssh-port PORT --source CIDR [--source CIDR ...]" \
    "  $CONTROLLER_NAME apply --admin USER --ssh-port PORT --source CIDR [--source CIDR ...]" \
    "  $CONTROLLER_NAME confirm --transaction 64HEX" \
    "  $CONTROLLER_NAME rollback --transaction 64HEX"
}

main() {
  local command="${1:-audit}"
  (($# == 0)) || shift
  case "$command" in
    audit) audit_command "$@" ;;
    plan) plan_command "$@" ;;
    apply) apply_command "$@" ;;
    confirm) confirm_command "$@" ;;
    rollback) rollback_command "$@" ;;
    rollback-pending) rollback_pending_command "$@" ;;
    --help|-h|help) usage ;;
    *) hardening_die "Unbekannter Host-Sicherheitsvorgang." ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

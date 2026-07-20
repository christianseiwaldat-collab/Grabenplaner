#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
readonly MODULE_ROOT="$(dirname -- "$SCRIPT_PATH")"
# shellcheck source=lib/hardening-common.sh
source "$MODULE_ROOT/lib/hardening-common.sh"

readonly STATUS_READER_GROUP="grabenplaner-monitor-status"
readonly GRABENPLANER_ENV_FILE="/etc/grabenplaner/grabenplaner.env"
readonly APT_PERIODIC_FILE="/etc/apt/apt.conf.d/60grabenplaner-auto-upgrades"
readonly APT_UNATTENDED_FILE="/etc/apt/apt.conf.d/60grabenplaner-unattended-upgrades"
readonly UFW_DEFAULT_FILE="/etc/default/ufw"
readonly JOURNALD_LEGACY_DROPIN="/etc/systemd/journald.conf.d/60-grabenplaner-journald.conf"
readonly JOURNALD_DROPIN="/etc/systemd/journald.conf.d/zz-grabenplaner-journald.conf"
readonly ACTIVE_TRANSACTION_FILE="$HARDENING_STATE_ROOT/active-transaction"
readonly POLICY_FILE="$MODULE_ROOT/lib/hardening-policy.js"

WRITE_STATUS=0
AUDIT_CHECKED_AT=""
ERROR_COUNT=0
WARNING_COUNT=0
CONFIGURED=false
PENDING_CONFIRMATION=false
TRANSACTION_POLICY_AVAILABLE=false
TRANSACTION_MARKER_PRESENT=false
TRANSACTION_ADMIN=""
TRANSACTION_CLIENT_IP=""
TRANSACTION_SERVER_IP=""
TRANSACTION_SSH_PORT=""
TRANSACTION_SOURCES=()
declare -A CHECK_VALUE=(
  [ssh]=false
  [firewall]=false
  [publicPorts]=false
  [automaticUpdates]=false
  [sysctl]=false
  [journald]=false
  [accountProtection]=false
  [secretFiles]=false
  [failedUnits]=false
  [timeSync]=false
)

usage() {
  cat <<'EOF'
Verwendung:
  sudo grabenplaner-host-security-test [--write-status]

Prueft die wirksame Host-Konfiguration ausschliesslich lesend. Mit
--write-status wird zusaetzlich eine streng begrenzte Statusdatei ohne Pfade,
Ports, Benutzer, IP-Adressen oder Freitext fuer Grabenplaner aktualisiert.
EOF
}

record_ok() {
  local key="$1"
  shift
  CHECK_VALUE["$key"]=true
  printf 'OK: %s\n' "$*"
}

record_warn() {
  local key="$1"
  shift
  CHECK_VALUE["$key"]=false
  WARNING_COUNT=$((WARNING_COUNT + 1))
  printf 'WARN: %s\n' "$*"
}

record_error() {
  local key="$1"
  shift
  CHECK_VALUE["$key"]=false
  ERROR_COUNT=$((ERROR_COUNT + 1))
  printf 'FEHLER: %s\n' "$*"
}

record_general_warning() {
  WARNING_COUNT=$((WARNING_COUNT + 1))
  printf 'WARN: %s\n' "$*"
}

record_general_error() {
  ERROR_COUNT=$((ERROR_COUNT + 1))
  printf 'FEHLER: %s\n' "$*"
}

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

private_regular_file() {
  local file="$1" metadata=""
  [[ -f "$file" && ! -L "$file" ]] || return 1
  metadata="$(stat -c '%u:%g:%a:%h' -- "$file" 2>/dev/null)" || return 1
  [[ "$metadata" == "0:0:600:1" ]]
}

root_readonly_config_file() {
  local file="$1" metadata=""
  [[ -f "$file" && ! -L "$file" ]] || return 1
  metadata="$(stat -c '%u:%g:%a:%h' -- "$file" 2>/dev/null)" || return 1
  [[ "$metadata" == "0:0:644:1" ]]
}

private_transaction_directory() {
  local directory="$1" metadata=""
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  metadata="$(stat -c '%u:%g:%a' -- "$directory" 2>/dev/null)" || return 1
  [[ "$metadata" == "0:0:700" ]]
}

read_private_scalar() {
  local file="$1" output_name="$2" lines=()
  private_regular_file "$file" || return 1
  mapfile -t lines <"$file" || return 1
  [[ ${#lines[@]} -eq 1 && -n "${lines[0]}" ]] || return 1
  printf -v "$output_name" '%s' "${lines[0]}"
}

validate_transaction_reference() {
  local reference_file="$1" expected_state="$2" output_name="$3"
  local reference_id="" transaction_directory state_file node
  read_private_scalar "$reference_file" reference_id || return 1
  node="$(hardening_node)" || return 1
  "$node" "$POLICY_FILE" validate-transaction "$reference_id" >/dev/null 2>&1 || return 1
  transaction_directory="$HARDENING_TRANSACTION_ROOT/$reference_id"
  private_transaction_directory "$transaction_directory" || return 1
  state_file="$transaction_directory/state.json"
  private_regular_file "$state_file" || return 1
  "$node" -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const keys = Object.keys(value).sort();
    const expectedKeys = ["format", "schemaVersion", "state", "updatedAt"].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || value.format !== "grabenplaner-host-security-transaction"
      || value.schemaVersion !== 1 || value.state !== process.argv[2]
      || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) process.exit(1);
  ' "$state_file" "$expected_state" >/dev/null 2>&1 || return 1
  printf -v "$output_name" '%s' "$reference_id"
}

load_transaction_policy() {
  local transaction_id="$1" transaction_directory admin_file client_file server_file port_file sources_file node
  local admin="" client_ip="" server_ip="" port="" sources=()
  transaction_directory="$HARDENING_TRANSACTION_ROOT/$transaction_id"
  admin_file="$transaction_directory/admin"
  client_file="$transaction_directory/client-ip"
  server_file="$transaction_directory/server-ip"
  port_file="$transaction_directory/ssh-port"
  sources_file="$transaction_directory/sources"
  read_private_scalar "$admin_file" admin || return 1
  read_private_scalar "$client_file" client_ip || return 1
  read_private_scalar "$server_file" server_ip || return 1
  read_private_scalar "$port_file" port || return 1
  private_regular_file "$sources_file" || return 1
  mapfile -t sources <"$sources_file" || return 1
  [[ ${#sources[@]} -gt 0 && ${#sources[@]} -le 64 ]] || return 1
  node="$(hardening_node)" || return 1
  "$node" -e '
    const fs = require("node:fs");
    const policy = require(process.argv[1]);
    const readScalar = (file) => fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
    const admin = readScalar(process.argv[2]);
    const clientIp = readScalar(process.argv[3]);
    const serverIp = readScalar(process.argv[4]);
    const port = readScalar(process.argv[5]);
    const sources = fs.readFileSync(process.argv[6], "utf8").split(/\r?\n/).filter((value, index, all) => value || index < all.length - 1);
    if (!policy.isValidAdminUsername(admin) || !policy.isValidPort(port)
      || sources.length < 1 || sources.length > 64) process.exit(1);
    policy.parseIpAddress(clientIp);
    policy.parseIpAddress(serverIp);
    for (const source of sources) policy.parseCidr(source);
    if (!policy.validateSession({ clientIp, allowedSources: sources }).clientMatched) process.exit(1);
  ' "$POLICY_FILE" "$admin_file" "$client_file" "$server_file" "$port_file" "$sources_file" >/dev/null 2>&1 || return 1
  TRANSACTION_ADMIN="$admin"
  TRANSACTION_CLIENT_IP="$client_ip"
  TRANSACTION_SERVER_IP="$server_ip"
  TRANSACTION_SSH_PORT="$port"
  TRANSACTION_SOURCES=("${sources[@]}")
  TRANSACTION_POLICY_AVAILABLE=true
}

discover_transaction_configuration() {
  local pending_exists=false active_exists=false transaction_id=""
  [[ -e "$HARDENING_PENDING_FILE" || -L "$HARDENING_PENDING_FILE" ]] && pending_exists=true
  [[ -e "$ACTIVE_TRANSACTION_FILE" || -L "$ACTIVE_TRANSACTION_FILE" ]] && active_exists=true
  if [[ "$pending_exists" == true || "$active_exists" == true ]]; then
    TRANSACTION_MARKER_PRESENT=true
  fi

  if [[ "$pending_exists" == true ]]; then
    if validate_transaction_reference "$HARDENING_PENDING_FILE" pending_confirmation transaction_id \
      && load_transaction_policy "$transaction_id"; then
      CONFIGURED=true
      PENDING_CONFIRMATION=true
      record_general_warning "Eine sicher geladene Host-Sicherheitstransaktion wartet noch auf Bestaetigung."
    else
      record_general_error "Die ausstehende Host-Sicherheitstransaktion ist unvollstaendig oder unsicher."
    fi
    return
  fi

  if [[ "$active_exists" == true ]]; then
    if validate_transaction_reference "$ACTIVE_TRANSACTION_FILE" confirmed transaction_id \
      && load_transaction_policy "$transaction_id"; then
      CONFIGURED=true
    else
      record_general_error "Die aktive Host-Sicherheitstransaktion ist unvollstaendig oder unsicher."
    fi
    return
  fi

  record_general_warning "Das Host-Hardening wurde noch nicht angewendet."
}

check_ssh() {
  local sshd_binary="" effective="" expected
  if [[ -x /usr/sbin/sshd ]]; then
    sshd_binary=/usr/sbin/sshd
  elif command -v sshd >/dev/null 2>&1; then
    sshd_binary="$(command -v sshd)"
  fi
  if [[ -z "$sshd_binary" ]]; then
    record_error ssh "Die wirksame SSH-Konfiguration konnte nicht gelesen werden."
    return
  fi
  if [[ "$TRANSACTION_POLICY_AVAILABLE" == true ]]; then
    if ! effective="$(LC_ALL=C "$sshd_binary" -T -C \
      "user=$TRANSACTION_ADMIN,addr=$TRANSACTION_CLIENT_IP,laddr=$TRANSACTION_SERVER_IP,lport=$TRANSACTION_SSH_PORT" \
      2>/dev/null)"; then
      record_error ssh "Die transaktionsgebundene SSH-Konfiguration konnte nicht gelesen werden."
      return
    fi
    if ! awk -v expected="$TRANSACTION_SSH_PORT" '
      $1 == "port" { count += 1; if (NF != 2 || $2 != expected) invalid = 1 }
      END { exit(count == 1 && !invalid ? 0 : 1) }
    ' <<<"$effective"; then
      record_error ssh "SSH verwendet nicht exakt den transaktionsgebundenen Port."
      return
    fi
  elif [[ "$TRANSACTION_MARKER_PRESENT" == true ]]; then
    record_error ssh "Die gespeicherte SSH-Pruefpolicy ist unvollstaendig oder unsicher."
    return
  elif ! effective="$(LC_ALL=C "$sshd_binary" -T 2>/dev/null)"; then
    record_error ssh "Die wirksame SSH-Konfiguration konnte nicht gelesen werden."
    return
  fi
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
    if ! grep -Fqx -- "$expected" <<<"${effective,,}"; then
      record_error ssh "Die wirksame SSH-Richtlinie entspricht nicht dem Sicherheitsprofil."
      return
    fi
  done
  record_ok ssh "SSH verwendet die erwartete schluesselbasierte Sicherheitsrichtlinie."
}

validate_transaction_ufw_policy() {
  local added="$1" status="$2" defaults node
  [[ "$TRANSACTION_POLICY_AVAILABLE" == true ]] || return 1
  root_readonly_config_file "$UFW_DEFAULT_FILE" || return 1
  defaults="$(<"$UFW_DEFAULT_FILE")" || return 1
  node="$(hardening_node)" || return 1
  printf '%s\0%s\0%s' "$added" "$status" "$defaults" | "$node" -e '
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
    ufwDefaults: input.subarray(second + 1).toString("utf8"),
    sshPort: process.argv[2],
    allowedSources: process.argv.slice(3),
    requireComplete: true,
  });
} catch { process.exit(1); }
' "$POLICY_FILE" "$TRANSACTION_SSH_PORT" "${TRANSACTION_SOURCES[@]}"
}

internal_port_is_loopback_only() {
  local output=""
  command -v ss >/dev/null 2>&1 || return 1
  output="$(LC_ALL=C ss -H -ltn 2>/dev/null)" || return 1
  awk '
    $1 == "LISTEN" {
      localAddress = $4
      if (localAddress ~ /:3000$/) {
        found = 1
        if (localAddress != "127.0.0.1:3000" && localAddress != "[::1]:3000") unsafe = 1
      }
    }
    END { exit (found && !unsafe) ? 0 : 1 }
  ' <<<"$output"
}

check_firewall() {
  local output="" added="" firewall_ok=false ports_ok=false
  if ! command -v ufw >/dev/null 2>&1 \
    || ! added="$(LC_ALL=C ufw show added 2>/dev/null)" \
    || ! output="$(LC_ALL=C ufw status verbose 2>/dev/null)"; then
    record_error firewall "Der Firewall-Status konnte nicht gelesen werden."
    record_error publicPorts "Die oeffentlichen und internen Portregeln konnten nicht geprueft werden."
    return
  fi
  if validate_transaction_ufw_policy "$added" "$output"; then
    firewall_ok=true
  fi
  if [[ "$firewall_ok" == true ]]; then
    record_ok firewall "Die Host-Firewall ist aktiv."
  else
    record_error firewall "Die Host-Firewall oder eine transaktionsgebundene SSH-Regel weicht ab."
  fi
  if [[ "$firewall_ok" == true ]] && internal_port_is_loopback_only; then
    ports_ok=true
  fi
  if [[ "$ports_ok" == true ]]; then
    record_ok publicPorts "Die Webports sind freigegeben und der interne App-Port bleibt geschlossen."
  else
    record_error publicPorts "Firewall oder Listener verletzen die Trennung zwischen Web- und internem App-Port."
  fi
}

check_automatic_updates() {
  local config="" origin base=0 apps=0 infra=0 timer
  local -a origins=()
  if ! command -v apt-config >/dev/null 2>&1 || ! config="$(LC_ALL=C apt-config dump 2>/dev/null)"; then
    record_error automaticUpdates "Die automatische Update-Konfiguration konnte nicht gelesen werden."
    return
  fi
  if grep -Fqx 'APT::Periodic::Update-Package-Lists "1";' <<<"$config" \
    && grep -Fqx 'APT::Periodic::Unattended-Upgrade "1";' <<<"$config" \
    && grep -Fqx 'Unattended-Upgrade::Automatic-Reboot "false";' <<<"$config" \
    && grep -Fqx 'Unattended-Upgrade::Remove-Unused-Dependencies "false";' <<<"$config" \
    && root_readonly_config_file "$APT_PERIODIC_FILE" \
    && root_readonly_config_file "$APT_UNATTENDED_FILE"; then
    if grep -Eq '^Unattended-Upgrade::Origins-Pattern::' <<<"$config"; then
      record_error automaticUpdates "Automatische Sicherheitsaktualisierungen erlauben eine Origins-Pattern-Ausnahme."
      return
    fi
    mapfile -t origins < <(awk -F '"' '/^Unattended-Upgrade::Allowed-Origins::[[:space:]]/ { print $2 }' <<<"$config")
    if [[ ${#origins[@]} -ne 3 ]]; then
      record_error automaticUpdates "Automatische Sicherheitsaktualisierungen verwenden nicht exakt drei Security-/ESM-Quellen."
      return
    fi
    for origin in "${origins[@]}"; do
      case "$origin" in
        '${distro_id}:${distro_codename}-security'|Ubuntu:"${VERSION_CODENAME:-}"-security) ((base += 1)) ;;
        '${distro_id}ESMApps:${distro_codename}-apps-security'|UbuntuESMApps:"${VERSION_CODENAME:-}"-apps-security) ((apps += 1)) ;;
        '${distro_id}ESM:${distro_codename}-infra-security'|UbuntuESM:"${VERSION_CODENAME:-}"-infra-security) ((infra += 1)) ;;
        *) record_error automaticUpdates "Automatische Sicherheitsaktualisierungen enthalten eine nicht freigegebene Quelle."; return ;;
      esac
    done
    if [[ "$base" != 1 || "$apps" != 1 || "$infra" != 1 ]]; then
      record_error automaticUpdates "Security-/ESM-Quellen sind unvollstaendig oder doppelt."
      return
    fi
    for timer in apt-daily.timer apt-daily-upgrade.timer; do
      if ! systemctl is-enabled --quiet "$timer" || ! systemctl is-active --quiet "$timer"; then
        record_error automaticUpdates "Ein erforderlicher APT-Sicherheitstimer ist nicht aktiviert und aktiv."
        return
      fi
    done
    record_ok automaticUpdates "Automatische Sicherheitsaktualisierungen sind eingerichtet."
  else
    record_error automaticUpdates "Automatische Sicherheitsaktualisierungen sind nicht vollstaendig aktiv."
  fi
}

check_sysctl() {
  local template="$MODULE_ROOT/templates/60-grabenplaner-sysctl.conf"
  local line key expected actual sysctl_ok=true
  if ! command -v sysctl >/dev/null 2>&1 || [[ ! -f "$template" || -L "$template" ]]; then
    record_error sysctl "Die wirksamen Kernel-Sicherheitswerte konnten nicht geprueft werden."
    return
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(trim_value "$line")"
    [[ -n "$line" ]] || continue
    [[ "$line" == *"="* ]] || { sysctl_ok=false; break; }
    key="$(trim_value "${line%%=*}")"
    expected="$(trim_value "${line#*=}")"
    if ! actual="$(sysctl -n "$key" 2>/dev/null)"; then
      sysctl_ok=false
      break
    fi
    actual="$(trim_value "$actual")"
    [[ "$actual" == "$expected" ]] || { sysctl_ok=false; break; }
  done <"$template"
  if [[ "$sysctl_ok" == true ]]; then
    record_ok sysctl "Die wirksamen Kernel-Sicherheitswerte entsprechen dem Profil."
  else
    record_error sysctl "Mindestens ein wirksamer Kernel-Sicherheitswert weicht ab."
  fi
}

check_journald() {
  local template="$MODULE_ROOT/templates/60-grabenplaner-journald.conf"
  local effective="" node journald_ok=true
  if ! command -v systemd-analyze >/dev/null 2>&1 \
    || [[ ! -f "$template" || -L "$template" ]] \
    || [[ -e "$JOURNALD_LEGACY_DROPIN" || -L "$JOURNALD_LEGACY_DROPIN" ]] \
    || ! root_readonly_config_file "$JOURNALD_DROPIN" \
    || ! effective="$(LC_ALL=C SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat systemd-analyze cat-config systemd/journald.conf 2>/dev/null)"; then
    record_error journald "Die wirksame Journal-Konfiguration konnte nicht gelesen werden."
    return
  fi
  node="$(hardening_node)" || journald_ok=false
  if [[ "$journald_ok" == true ]] && ! printf '%s\0%s' "$effective" "$(<"$template")" | "$node" -e '
const fs = require("node:fs");
const policy = require(process.argv[1]);
const input = fs.readFileSync(0);
const separator = input.indexOf(0);
if (separator < 0) process.exit(1);
try {
  policy.validateJournaldConfiguration({
    mergedConfig: input.subarray(0, separator).toString("utf8"),
    template: input.subarray(separator + 1).toString("utf8"),
    managedPath: process.argv[2],
  });
} catch { process.exit(1); }
' "$POLICY_FILE" "$JOURNALD_DROPIN"; then
    journald_ok=false
  fi
  if [[ "$journald_ok" == true ]] && systemctl is-active --quiet systemd-journald.service; then
    record_ok journald "Die wirksame Journal-Aufbewahrung entspricht dem Profil."
  else
    record_error journald "Die wirksame Journal-Aufbewahrung weicht vom Profil ab."
  fi
}

account_is_protected() {
  local account="$1" entry shell groups
  entry="$(getent passwd "$account" 2>/dev/null)" || return 1
  shell="${entry##*:}"
  [[ "$shell" == "/usr/sbin/nologin" || "$shell" == "/bin/false" ]] || return 1
  groups=" $(id -nG "$account" 2>/dev/null) " || return 1
  [[ "$groups" != *" sudo "* && "$groups" != *" adm "* ]]
}

check_accounts() {
  local caddy_groups="" runtime_groups="" build_groups=""
  if ! account_is_protected grabenplaner || ! account_is_protected grabenplaner-build; then
    record_error accountProtection "Die Dienstkonten sind nicht vollstaendig geschuetzt."
    return
  fi
  runtime_groups=" $(id -nG grabenplaner 2>/dev/null) " || {
    record_error accountProtection "Die Laufzeit-Dienstgruppen konnten nicht geprueft werden."
    return
  }
  build_groups=" $(id -nG grabenplaner-build 2>/dev/null) " || {
    record_error accountProtection "Die Build-Dienstgruppen konnten nicht geprueft werden."
    return
  }
  if [[ "$runtime_groups" == *" grabenplaner-build "* || "$build_groups" == *" grabenplaner "* ]]; then
    record_error accountProtection "Build- und Laufzeitdienstkonten sind nicht ausreichend getrennt."
    return
  fi
  if getent passwd caddy >/dev/null 2>&1; then
    caddy_groups=" $(id -nG caddy 2>/dev/null) " || {
      record_error accountProtection "Die Trennung des Webdienstkontos konnte nicht geprueft werden."
      return
    }
    if [[ "$caddy_groups" == *" grabenplaner "* || "$caddy_groups" == *" grabenplaner-build "* ]]; then
      record_error accountProtection "Die Dienstkonten sind nicht ausreichend voneinander getrennt."
      return
    fi
  fi
  record_ok accountProtection "Dienstkonten und Berechtigungsgrenzen sind geschuetzt."
}

check_secret_files() {
  local metadata=""
  if [[ -f "$GRABENPLANER_ENV_FILE" && ! -L "$GRABENPLANER_ENV_FILE" ]] \
    && metadata="$(stat -c '%U:%G:%a:%h' -- "$GRABENPLANER_ENV_FILE" 2>/dev/null)" \
    && [[ "$metadata" == "root:root:600:1" ]]; then
    record_ok secretFiles "Die geheime Laufzeitkonfiguration ist root-only geschuetzt."
  else
    record_error secretFiles "Die geheime Laufzeitkonfiguration hat unsichere Dateirechte."
  fi
}

check_failed_units() {
  local failed=""
  if ! failed="$(LC_ALL=C systemctl --failed --no-legend --plain 2>/dev/null)"; then
    record_warn failedUnits "Fehlgeschlagene Systemdienste konnten nicht abgefragt werden."
  elif [[ -z "$failed" ]]; then
    record_ok failedUnits "Keine fehlgeschlagenen Systemdienste erkannt."
  else
    record_warn failedUnits "Mindestens ein Systemdienst ist fehlgeschlagen."
  fi
}

check_time_sync() {
  local synchronized=""
  if command -v timedatectl >/dev/null 2>&1 \
    && synchronized="$(timedatectl show --property=NTPSynchronized --value 2>/dev/null)" \
    && [[ "$synchronized" == "yes" || "$synchronized" == "true" ]]; then
    record_ok timeSync "Die Systemzeit ist synchronisiert."
  else
    record_warn timeSync "Die Synchronisierung der Systemzeit ist nicht bestaetigt."
  fi
}

write_status_file() {
  local state="$1" configured="$2" pending="$3" reboot_required="$4" checked_at="$5"
  local checked_at_epoch node reader_group=root reader_gid=0 file_mode=0600 directory_mode=0700 temporary="" metadata
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Statuspruefung."
  checked_at_epoch="$($node -e 'const value=Date.parse(process.argv[1]); if (!Number.isFinite(value)) process.exit(1); process.stdout.write(String(value));' "$checked_at")" \
    || hardening_die "Der Audit-Zeitstempel ist ungueltig."
  if getent group "$STATUS_READER_GROUP" >/dev/null 2>&1; then
    reader_group="$STATUS_READER_GROUP"
    reader_gid="$(getent group "$STATUS_READER_GROUP" | awk -F: 'NR == 1 { print $3 }')"
    [[ "$reader_gid" =~ ^[0-9]+$ ]] || hardening_die "Die Status-Lesegruppe ist ungueltig."
    file_mode=0640
    directory_mode=0710
  fi

  hardening_acquire_status_lock 120 \
    || hardening_die "Ein paralleler Host-Sicherheitsaudit blockiert die Statusaktualisierung."

  if [[ -e "$HARDENING_STATE_ROOT" || -L "$HARDENING_STATE_ROOT" ]]; then
    [[ -d "$HARDENING_STATE_ROOT" && ! -L "$HARDENING_STATE_ROOT" ]] \
      || hardening_die "Die Host-Sicherheitsstatusablage ist unsicher."
    metadata="$(stat -c '%u:%g:%a' -- "$HARDENING_STATE_ROOT")"
    [[ "$metadata" == "0:0:700" || "$metadata" == "0:${reader_gid}:710" ]] \
      || hardening_die "Die Host-Sicherheitsstatusablage hat unsichere Dateirechte."
  fi
  install -d -o root -g "$reader_group" -m "$directory_mode" -- "$HARDENING_STATE_ROOT"

  if [[ -e "$HARDENING_STATUS_FILE" || -L "$HARDENING_STATUS_FILE" ]]; then
    [[ -f "$HARDENING_STATUS_FILE" && ! -L "$HARDENING_STATUS_FILE" ]] \
      || hardening_die "Die Host-Sicherheitsstatusdatei ist unsicher."
    metadata="$(stat -c '%u:%g:%a:%h' -- "$HARDENING_STATUS_FILE")"
    [[ "$metadata" == "0:0:600:1" || "$metadata" == "0:${reader_gid}:640:1" ]] \
      || hardening_die "Die Host-Sicherheitsstatusdatei hat unsichere Dateirechte."
  fi

  temporary="$(mktemp "$HARDENING_STATE_ROOT/.status.XXXXXXXX")"
  if ! printf '%s\n' \
    '{' \
    '  "format": "grabenplaner-host-security-status",' \
    '  "schemaVersion": 1,' \
    "  \"checkedAt\": \"$checked_at\"," \
    "  \"state\": \"$state\"," \
    "  \"configured\": $configured," \
    "  \"pendingConfirmation\": $pending," \
    "  \"rebootRequired\": $reboot_required," \
    '  "checks": {' \
    "    \"ssh\": ${CHECK_VALUE[ssh]}," \
    "    \"firewall\": ${CHECK_VALUE[firewall]}," \
    "    \"publicPorts\": ${CHECK_VALUE[publicPorts]}," \
    "    \"automaticUpdates\": ${CHECK_VALUE[automaticUpdates]}," \
    "    \"sysctl\": ${CHECK_VALUE[sysctl]}," \
    "    \"journald\": ${CHECK_VALUE[journald]}," \
    "    \"accountProtection\": ${CHECK_VALUE[accountProtection]}," \
    "    \"secretFiles\": ${CHECK_VALUE[secretFiles]}," \
    "    \"failedUnits\": ${CHECK_VALUE[failedUnits]}," \
    "    \"timeSync\": ${CHECK_VALUE[timeSync]}" \
    '  }' \
    '}' >"$temporary"; then
    rm -f -- "$temporary"
    hardening_die "Der Host-Sicherheitsstatus konnte nicht geschrieben werden."
  fi
  if ! chown root:"$reader_group" "$temporary" || ! chmod "$file_mode" "$temporary" || ! sync -f "$temporary"; then
    rm -f -- "$temporary"
    hardening_die "Der Host-Sicherheitsstatus konnte nicht sicher vorbereitet werden."
  fi

  # The timestamp represents the start of the audit. A slower, older audit must
  # never replace a status produced by a run that started later.
  if [[ -f "$HARDENING_STATUS_FILE" && ! -L "$HARDENING_STATUS_FILE" ]] \
    && "$node" - "$HARDENING_STATUS_FILE" "$checked_at_epoch" <<'NODE'
const fs = require("node:fs");
try {
  const current = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const currentEpoch = Date.parse(current.checkedAt);
  const candidateEpoch = Number(process.argv[3]);
  process.exit(Number.isFinite(currentEpoch) && currentEpoch >= candidateEpoch ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
  then
    rm -f -- "$temporary"
    return 0
  fi

  if ! mv -fT -- "$temporary" "$HARDENING_STATUS_FILE"; then
    rm -f -- "$temporary"
    hardening_die "Der Host-Sicherheitsstatus konnte nicht atomar ersetzt werden."
  fi
  sync -f "$HARDENING_STATUS_FILE"
  sync -f "$HARDENING_STATE_ROOT"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write-status)
      [[ $WRITE_STATUS -eq 0 ]] || { usage >&2; exit 2; }
      WRITE_STATUS=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

hardening_require_root
for command_name in awk chmod chown date flock getent grep id install mktemp mv readlink stat sync systemctl; do
  hardening_require_command "$command_name"
done
hardening_validate_os
hardening_assert_installed_contract

AUDIT_CHECKED_AT="$(date --utc '+%Y-%m-%dT%H:%M:%S.%3NZ')"

discover_transaction_configuration
check_ssh
check_firewall
check_automatic_updates
check_sysctl
check_journald
check_accounts
check_secret_files
check_failed_units
check_time_sync

reboot_required=false
if [[ -e /var/run/reboot-required ]]; then
  reboot_required=true
  record_general_warning "Ein Neustart des Servers ist erforderlich."
else
  printf 'OK: Kein ausstehender Serverneustart erkannt.\n'
fi

state=ok
if [[ $ERROR_COUNT -gt 0 ]]; then
  state=error
elif [[ $WARNING_COUNT -gt 0 ]]; then
  state=warning
fi

if [[ $WRITE_STATUS -eq 1 ]]; then
  write_status_file "$state" "$CONFIGURED" "$PENDING_CONFIRMATION" "$reboot_required" "$AUDIT_CHECKED_AT"
  printf 'Ergebnis: %s (%d Fehler, %d Warnungen).\n' "$state" "$ERROR_COUNT" "$WARNING_COUNT"
  exit 0
fi

printf 'Ergebnis: %s (%d Fehler, %d Warnungen).\n' "$state" "$ERROR_COUNT" "$WARNING_COUNT"
[[ $ERROR_COUNT -eq 0 && $WARNING_COUNT -eq 0 ]]

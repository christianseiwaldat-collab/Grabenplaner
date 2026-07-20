#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
readonly SOURCE_MODULE_ROOT="$(dirname -- "$SCRIPT_PATH")"
# shellcheck source=lib/hardening-common.sh
source "$SOURCE_MODULE_ROOT/lib/hardening-common.sh"

readonly SYSTEMD_ROOT="/etc/systemd/system"
readonly HARDENING_UNINSTALL_COMMAND="/usr/local/sbin/grabenplaner-host-security-uninstall"

SOURCE_CONTRACT_FILE=""
STAGED_CONTRACT_FILE=""
STAGED_MODULE_ROOT=""
FRESH_MODULE=0
MODULE_VERIFIED=0

cleanup() {
  local exit_code=$?
  local unit_pair source_name unit_name link_pair link_name link_target
  [[ -z "$SOURCE_CONTRACT_FILE" || ! -e "$SOURCE_CONTRACT_FILE" ]] || rm -f -- "$SOURCE_CONTRACT_FILE"
  [[ -z "$STAGED_CONTRACT_FILE" || ! -e "$STAGED_CONTRACT_FILE" ]] || rm -f -- "$STAGED_CONTRACT_FILE"
  [[ -z "$STAGED_MODULE_ROOT" || ! -e "$STAGED_MODULE_ROOT" ]] || rm -rf -- "$STAGED_MODULE_ROOT"
  if [[ $exit_code -ne 0 && $FRESH_MODULE -eq 1 && $MODULE_VERIFIED -eq 0 \
    && "$HARDENING_MODULE_ROOT" == "/opt/grabenplaner-hardening/module" ]]; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl stop "$HARDENING_AUDIT_SERVICE" >/dev/null 2>&1 || true
      systemctl disable --now "$HARDENING_AUDIT_TIMER" >/dev/null 2>&1 || true
      systemctl disable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 || true
    fi
    for unit_pair in \
      "grabenplaner-host-security-audit.service.in:$HARDENING_AUDIT_SERVICE" \
      "grabenplaner-host-security-audit.timer.in:$HARDENING_AUDIT_TIMER" \
      "grabenplaner-host-security-rollback.service.in:$HARDENING_ROLLBACK_SERVICE" \
      "grabenplaner-host-security-rollback.timer.in:$HARDENING_ROLLBACK_TIMER"; do
      source_name="${unit_pair%%:*}"
      unit_name="${unit_pair#*:}"
      if [[ -f "$SYSTEMD_ROOT/$unit_name" && ! -L "$SYSTEMD_ROOT/$unit_name" \
        && -f "$HARDENING_MODULE_ROOT/systemd/$source_name" && ! -L "$HARDENING_MODULE_ROOT/systemd/$source_name" ]] \
        && cmp -s -- "$HARDENING_MODULE_ROOT/systemd/$source_name" "$SYSTEMD_ROOT/$unit_name"; then
        rm -f -- "$SYSTEMD_ROOT/$unit_name"
      fi
    done
    for link_pair in \
      "$HARDENING_COMMAND:$HARDENING_MODULE_ROOT/grabenplaner-host-security.sh" \
      "$HARDENING_AUDIT_COMMAND:$HARDENING_MODULE_ROOT/test-grabenplaner-host-hardening.sh" \
      "$HARDENING_UNINSTALL_COMMAND:$HARDENING_MODULE_ROOT/uninstall-grabenplaner-host-hardening.sh"; do
      link_name="${link_pair%%:*}"
      link_target="${link_pair#*:}"
      if [[ -L "$link_name" && "$(readlink -f -- "$link_name" 2>/dev/null || true)" == "$(readlink -f -- "$link_target" 2>/dev/null || true)" ]]; then
        rm -f -- "$link_name"
      fi
    done
    command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload >/dev/null 2>&1 || true
    rm -rf -- "$HARDENING_MODULE_ROOT"
    rm -f -- "$HARDENING_INSTALLED_CONTRACT"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Verwendung:
  sudo ./install-grabenplaner-host-hardening.sh

Installiert ausschliesslich das versionierte Hardening-Werkzeug. Bestehende
SSH-, Firewall-, APT-, Kernel- und Journal-Einstellungen werden dabei nicht
veraendert. Aktiviert wird nur der taegliche, lesende Sicherheits-Audit.
EOF
}

install_command_link() {
  local target="$1" link_path="$2" current temporary
  [[ -f "$target" && ! -L "$target" ]] || hardening_die "Ein Hardening-Befehlsziel fehlt oder ist unsicher."
  if [[ -L "$link_path" ]]; then
    current="$(readlink -f -- "$link_path" 2>/dev/null || true)"
    [[ "$current" == "$(readlink -f -- "$target")" ]] \
      || hardening_die "Ein vorhandener Befehlslink zeigt auf ein fremdes Ziel."
    return 0
  fi
  [[ ! -e "$link_path" ]] || hardening_die "Ein vorhandener Befehl wuerde ueberschrieben."
  temporary="${link_path}.new.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || hardening_die "Ein temporaerer Befehlslink ist bereits belegt."
  ln -s -- "$target" "$temporary"
  chown -h root:root "$temporary"
  mv -- "$temporary" "$link_path"
}

install_systemd_unit() {
  local source_name="$1" unit_name="$2"
  hardening_atomic_install \
    "$HARDENING_MODULE_ROOT/systemd/$source_name" \
    "$SYSTEMD_ROOT/$unit_name" 0644
}

preflight_existing_unit() {
  local source_name="$1" unit_name="$2" installed fragment=""
  local predecessor_expected="$3"
  installed="$SYSTEMD_ROOT/$unit_name"
  fragment="$(systemctl show --property=FragmentPath --value "$unit_name" 2>/dev/null || true)"
  if [[ "$predecessor_expected" == true ]]; then
    [[ -f "$installed" && ! -L "$installed" \
      && "$(stat -c '%u:%g:%a:%h' -- "$installed")" == "0:0:644:1" \
      && "$fragment" == "$installed" \
      && -f "$HARDENING_MODULE_ROOT/systemd/$source_name" \
      && ! -L "$HARDENING_MODULE_ROOT/systemd/$source_name" ]] \
      && cmp -s -- "$HARDENING_MODULE_ROOT/systemd/$source_name" "$installed" \
      || hardening_die "Eine vorhandene Hardening-Systemd-Einheit ist fremd oder veraendert."
  else
    [[ ! -e "$installed" && ! -L "$installed" && -z "$fragment" ]] \
      || hardening_die "Eine gleichnamige fremde Systemd-Einheit verhindert die Installation."
  fi
}

preflight_existing_link() {
  local target="$1" link_path="$2" predecessor_expected="$3" resolved=""
  if [[ "$predecessor_expected" == true ]]; then
    [[ -L "$link_path" && "$(stat -c '%u:%g' -- "$link_path")" == "0:0" ]] \
      || hardening_die "Ein vorhandener Hardening-Befehlslink fehlt oder ist fremd."
    resolved="$(readlink -f -- "$link_path" 2>/dev/null || true)"
    [[ -n "$resolved" && "$resolved" == "$(readlink -f -- "$target")" ]] \
      || hardening_die "Ein vorhandener Hardening-Befehlslink zeigt auf ein fremdes Ziel."
  else
    [[ ! -e "$link_path" && ! -L "$link_path" ]] \
      || hardening_die "Ein gleichnamiger fremder Befehl verhindert die Installation."
  fi
}

preflight_existing_installation() {
  local predecessor_expected=false module_present=false receipt_present=false
  [[ -e "$HARDENING_MODULE_ROOT" || -L "$HARDENING_MODULE_ROOT" ]] && module_present=true
  [[ -e "$HARDENING_INSTALLED_CONTRACT" || -L "$HARDENING_INSTALLED_CONTRACT" ]] && receipt_present=true
  if [[ "$module_present" == true || "$receipt_present" == true ]]; then
    [[ "$module_present" == true && "$receipt_present" == true ]] \
      || hardening_die "Eine unvollstaendige Hardening-Vorgaengerinstallation wurde gefunden."
    hardening_assert_installed_contract
    "$node" -e '
      const fs = require("node:fs");
      const installed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const source = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      if (JSON.stringify(installed) !== JSON.stringify(source)) process.exit(1);
    ' "$HARDENING_INSTALLED_CONTRACT" "$SOURCE_CONTRACT_FILE" \
      || hardening_die "Das installierte Hardening-Modul weicht vom freigegebenen Quellvertrag ab."
    predecessor_expected=true
  fi

  preflight_existing_unit grabenplaner-host-security-audit.service.in "$HARDENING_AUDIT_SERVICE" "$predecessor_expected"
  preflight_existing_unit grabenplaner-host-security-audit.timer.in "$HARDENING_AUDIT_TIMER" "$predecessor_expected"
  preflight_existing_unit grabenplaner-host-security-rollback.service.in "$HARDENING_ROLLBACK_SERVICE" "$predecessor_expected"
  preflight_existing_unit grabenplaner-host-security-rollback.timer.in "$HARDENING_ROLLBACK_TIMER" "$predecessor_expected"
  preflight_existing_link "$HARDENING_MODULE_ROOT/grabenplaner-host-security.sh" "$HARDENING_COMMAND" "$predecessor_expected"
  preflight_existing_link "$HARDENING_MODULE_ROOT/test-grabenplaner-host-hardening.sh" "$HARDENING_AUDIT_COMMAND" "$predecessor_expected"
  preflight_existing_link "$HARDENING_MODULE_ROOT/uninstall-grabenplaner-host-hardening.sh" "$HARDENING_UNINSTALL_COMMAND" "$predecessor_expected"
}

verify_initial_status() {
  local status_group="grabenplaner-monitor-status" expected_file expected_directory
  [[ -f "$HARDENING_STATUS_FILE" && ! -L "$HARDENING_STATUS_FILE" ]] \
    || hardening_die "Der erste Host-Sicherheitsstatus fehlt oder ist unsicher."
  if getent group "$status_group" >/dev/null 2>&1; then
    expected_file="root:${status_group}:640:1"
    expected_directory="root:${status_group}:710"
  else
    expected_file="root:root:600:1"
    expected_directory="root:root:700"
  fi
  [[ "$(stat -c '%U:%G:%a:%h' -- "$HARDENING_STATUS_FILE")" == "$expected_file" \
    && "$(stat -c '%U:%G:%a' -- "$HARDENING_STATE_ROOT")" == "$expected_directory" ]] \
    || hardening_die "Der erste Host-Sicherheitsstatus hat unsichere Dateirechte."
  "$node" -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const top = ["checks", "checkedAt", "configured", "format", "pendingConfirmation", "rebootRequired", "schemaVersion", "state"].sort();
    const checks = ["accountProtection", "automaticUpdates", "failedUnits", "firewall", "journald", "publicPorts", "secretFiles", "ssh", "sysctl", "timeSync"].sort();
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(top)
      || value.format !== "grabenplaner-host-security-status" || value.schemaVersion !== 1
      || !["ok", "warning", "error"].includes(value.state)
      || !Number.isFinite(Date.parse(value.checkedAt))
      || ![value.configured, value.pendingConfirmation, value.rebootRequired].every((item) => typeof item === "boolean")
      || !value.checks || JSON.stringify(Object.keys(value.checks).sort()) !== JSON.stringify(checks)
      || checks.some((key) => typeof value.checks[key] !== "boolean" && value.checks[key] !== null)) process.exit(1);
  ' "$HARDENING_STATUS_FILE" >/dev/null \
    || hardening_die "Der erste Host-Sicherheitsstatus entspricht nicht dem freigegebenen Schema."
}

copy_manifested_module() {
  local node="$1" contract_file="$2" relative source destination mode
  while IFS= read -r -d '' relative; do
    [[ "$relative" != /* && "$relative" != *".."* ]] \
      || hardening_die "Der Modulvertrag enthaelt einen unsicheren Pfad."
    source="$SOURCE_MODULE_ROOT/$relative"
    destination="$STAGED_MODULE_ROOT/$relative"
    [[ -f "$source" && ! -L "$source" ]] \
      || hardening_die "Eine manifestierte Hardening-Datei fehlt oder ist unsicher."
    install -d -o root -g root -m 0755 -- "$(dirname -- "$destination")"
    case "$relative" in
      *.sh) mode=0755 ;;
      *) mode=0644 ;;
    esac
    install -o root -g root -m "$mode" -- "$source" "$destination"
  done < <("$node" -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const item of value.files) process.stdout.write(`${item.path}\0`);
  ' "$contract_file")
}

[[ $# -eq 0 ]] || {
  if [[ $# -eq 1 && "$1" == "--help" ]]; then
    usage
    exit 0
  fi
  usage >&2
  exit 2
}

hardening_require_root
hardening_validate_os
for command_name in chown chmod cmp dirname flock getent install ln mktemp mv readlink rm stat systemctl; do
  hardening_require_command "$command_name"
done
node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Modulpruefung."

[[ -f "$SOURCE_MODULE_ROOT/module-schema.json" && ! -L "$SOURCE_MODULE_ROOT/module-schema.json" \
  && -f "$SOURCE_MODULE_ROOT/lib/hardening-contract.js" && ! -L "$SOURCE_MODULE_ROOT/lib/hardening-contract.js" ]] \
  || hardening_die "Der Hardening-Quellvertrag ist unvollstaendig."

# Der Vertrag wird vor jeder Mutation vollstaendig berechnet. Dadurch fehlen im
# Staging weder Dateien, noch koennen nicht manifestierte Dateien mitkopiert werden.
SOURCE_CONTRACT_FILE="$(mktemp)"
"$node" "$SOURCE_MODULE_ROOT/lib/hardening-contract.js" contract "$SOURCE_MODULE_ROOT" \
  >"$SOURCE_CONTRACT_FILE" \
  || hardening_die "Der Hardening-Quellvertrag ist ungueltig oder unvollstaendig."

hardening_acquire_controller_lock fail-fast 0 \
  || hardening_die "Eine andere Host-Sicherheitsoperation ist bereits aktiv."
preflight_existing_installation
hardening_secure_roots
[[ ! -e "$HARDENING_PENDING_FILE" && ! -L "$HARDENING_PENDING_FILE" ]] \
  || hardening_die "Eine Hardening-Transaktion ist noch offen; die Installation bleibt unveraendert."

STAGED_MODULE_ROOT="$(mktemp -d /opt/grabenplaner-hardening/.module.XXXXXXXX)"
chmod 0700 "$STAGED_MODULE_ROOT"
chown root:root "$STAGED_MODULE_ROOT"
copy_manifested_module "$node" "$SOURCE_CONTRACT_FILE"
chmod 0755 "$STAGED_MODULE_ROOT"

STAGED_CONTRACT_FILE="$(mktemp)"
"$node" "$STAGED_MODULE_ROOT/lib/hardening-contract.js" contract "$STAGED_MODULE_ROOT" \
  >"$STAGED_CONTRACT_FILE"
"$node" -e '
  const fs = require("node:fs");
  const left = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const right = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (JSON.stringify(left) !== JSON.stringify(right)) process.exit(1);
' "$SOURCE_CONTRACT_FILE" "$STAGED_CONTRACT_FILE" \
  || hardening_die "Das kopierte Hardening-Modul weicht vom Quellvertrag ab."

if [[ -e "$HARDENING_MODULE_ROOT" || -L "$HARDENING_MODULE_ROOT" ]]; then
  [[ -d "$HARDENING_MODULE_ROOT" && ! -L "$HARDENING_MODULE_ROOT" ]] \
    || hardening_die "Die vorhandene Hardening-Modulwurzel ist unsicher."
  hardening_assert_installed_contract
  "$node" -e '
    const fs = require("node:fs");
    const installed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const source = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (JSON.stringify(installed) !== JSON.stringify(source)) process.exit(1);
  ' "$HARDENING_INSTALLED_CONTRACT" "$SOURCE_CONTRACT_FILE" \
    || hardening_die "Ein anderes Hardening-Modul ist bereits installiert; zuerst bewusst deinstallieren."
  rm -rf -- "$STAGED_MODULE_ROOT"
  STAGED_MODULE_ROOT=""
else
  mv -- "$STAGED_MODULE_ROOT" "$HARDENING_MODULE_ROOT"
  STAGED_MODULE_ROOT=""
  FRESH_MODULE=1
  hardening_atomic_install "$SOURCE_CONTRACT_FILE" "$HARDENING_INSTALLED_CONTRACT" 0600
  hardening_assert_installed_contract
fi

install_command_link "$HARDENING_MODULE_ROOT/grabenplaner-host-security.sh" "$HARDENING_COMMAND"
install_command_link "$HARDENING_MODULE_ROOT/test-grabenplaner-host-hardening.sh" "$HARDENING_AUDIT_COMMAND"
install_command_link "$HARDENING_MODULE_ROOT/uninstall-grabenplaner-host-hardening.sh" "$HARDENING_UNINSTALL_COMMAND"

install_systemd_unit \
  grabenplaner-host-security-audit.service.in "$HARDENING_AUDIT_SERVICE"
install_systemd_unit \
  grabenplaner-host-security-audit.timer.in "$HARDENING_AUDIT_TIMER"
install_systemd_unit \
  grabenplaner-host-security-rollback.service.in "$HARDENING_ROLLBACK_SERVICE"
install_systemd_unit \
  grabenplaner-host-security-rollback.timer.in "$HARDENING_ROLLBACK_TIMER"

systemctl daemon-reload
if systemctl is-enabled --quiet "$HARDENING_ROLLBACK_TIMER" 2>/dev/null; then
  hardening_die "Der Rollback-Timer ist ohne offene Transaktion aktiviert; Installation wird nicht fortgesetzt."
fi
systemctl enable --now "$HARDENING_AUDIT_TIMER"
systemctl is-enabled --quiet "$HARDENING_AUDIT_TIMER" \
  || hardening_die "Der taegliche Sicherheits-Audit wurde nicht aktiviert."
systemctl is-active --quiet "$HARDENING_AUDIT_TIMER" \
  || hardening_die "Der taegliche Sicherheits-Audit ist nicht aktiv."
systemctl start "$HARDENING_AUDIT_SERVICE" \
  || hardening_die "Der erste Host-Sicherheits-Audit konnte nicht abgeschlossen werden."
verify_initial_status

hardening_assert_installed_contract
MODULE_VERIFIED=1
hardening_info "Hardening-Werkzeuge installiert; Host-Richtlinien wurden nicht veraendert."
hardening_info "Aktiv ist ausschliesslich der taegliche, lesende Sicherheits-Audit."

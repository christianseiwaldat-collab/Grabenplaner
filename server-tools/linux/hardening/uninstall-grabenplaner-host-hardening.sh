#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
readonly MODULE_ROOT="$(dirname -- "$SCRIPT_PATH")"
# shellcheck source=lib/hardening-common.sh
source "$MODULE_ROOT/lib/hardening-common.sh"

readonly SYSTEMD_ROOT="/etc/systemd/system"
readonly HARDENING_UNINSTALL_COMMAND="/usr/local/sbin/grabenplaner-host-security-uninstall"
readonly ACTIVE_TRANSACTION_FILE="$HARDENING_STATE_ROOT/active-transaction"

usage() {
  cat <<'EOF'
Verwendung:
  sudo grabenplaner-host-security-uninstall

Entfernt das Grabenplaner-Hardening-Werkzeug und seine Systemd-Einheiten.
Bereits angewendete SSH-, Firewall-, APT-, Kernel- und Journal-Richtlinien
bleiben absichtlich bestehen und werden nicht stillschweigend zurueckgesetzt.
EOF
}

assert_matching_unit() {
  local source_name="$1" unit_name="$2" installed="$SYSTEMD_ROOT/$unit_name" fragment=""
  fragment="$(systemctl show --property=FragmentPath --value "$unit_name" 2>/dev/null || true)"
  if [[ -f "$installed" && ! -L "$installed" \
    && "$(stat -c '%u:%g:%a:%h' -- "$installed")" == "0:0:644:1" \
    && "$fragment" == "$installed" \
    && -f "$HARDENING_MODULE_ROOT/systemd/$source_name" \
    && ! -L "$HARDENING_MODULE_ROOT/systemd/$source_name" ]] \
    && cmp -s -- "$HARDENING_MODULE_ROOT/systemd/$source_name" "$installed"; then
    return 0
  else
    hardening_die "Eine Hardening-Systemd-Einheit fehlt oder wurde veraendert; Deinstallation abgebrochen."
  fi
}

assert_matching_link() {
  local target="$1" link_path="$2" resolved=""
  [[ -L "$link_path" && "$(stat -c '%u:%g' -- "$link_path")" == "0:0" ]] \
    || hardening_die "Ein Hardening-Befehlslink fehlt oder wurde veraendert; Deinstallation abgebrochen."
  resolved="$(readlink -f -- "$link_path" 2>/dev/null || true)"
  [[ "$resolved" == "$(readlink -f -- "$target" 2>/dev/null || true)" && -n "$resolved" ]] \
    || hardening_die "Ein Hardening-Befehlslink zeigt auf ein fremdes Ziel; Deinstallation abgebrochen."
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
for command_name in cmp dirname flock install readlink rm stat systemctl; do
  hardening_require_command "$command_name"
done

[[ "$HARDENING_MODULE_ROOT" == "/opt/grabenplaner-hardening/module" \
  && "$HARDENING_CONFIG_ROOT" == "/etc/grabenplaner-hardening" \
  && "$HARDENING_STATE_ROOT" == "/var/lib/grabenplaner-host-security" ]] \
  || hardening_die "Die Hardening-Pfade entsprechen nicht dem festen Installationsvertrag."

hardening_acquire_controller_lock fail-fast 0 \
  || hardening_die "Eine andere Host-Sicherheitsoperation ist bereits aktiv."
[[ ! -e "$HARDENING_PENDING_FILE" && ! -L "$HARDENING_PENDING_FILE" ]] \
  || hardening_die "Eine Hardening-Transaktion wartet auf Bestaetigung oder Rollback; Deinstallation verweigert."
[[ ! -e "$ACTIVE_TRANSACTION_FILE" && ! -L "$ACTIVE_TRANSACTION_FILE" ]] \
  || hardening_die "Aktives Host-Hardening muss zuerst explizit mit dem Controller zurueckgerollt werden."

hardening_assert_installed_contract

# Vor dem ersten stop/remove muessen alle installierten Einheiten und Links
# exakt dem verifizierten Modul entsprechen. Drift fuehrt zu einem Vollabbruch.
assert_matching_unit \
  grabenplaner-host-security-audit.service.in "$HARDENING_AUDIT_SERVICE"
assert_matching_unit \
  grabenplaner-host-security-audit.timer.in "$HARDENING_AUDIT_TIMER"
assert_matching_unit \
  grabenplaner-host-security-rollback.service.in "$HARDENING_ROLLBACK_SERVICE"
assert_matching_unit \
  grabenplaner-host-security-rollback.timer.in "$HARDENING_ROLLBACK_TIMER"
assert_matching_link "$HARDENING_MODULE_ROOT/grabenplaner-host-security.sh" "$HARDENING_COMMAND"
assert_matching_link "$HARDENING_MODULE_ROOT/test-grabenplaner-host-hardening.sh" "$HARDENING_AUDIT_COMMAND"
assert_matching_link "$HARDENING_MODULE_ROOT/uninstall-grabenplaner-host-hardening.sh" "$HARDENING_UNINSTALL_COMMAND"

# Nur die eigenen Zeitgeber und Dienste werden beendet. Host-Richtlinien wie
# SSH, UFW, APT, sysctl und journald werden bewusst nicht veraendert.
systemctl disable --now "$HARDENING_AUDIT_TIMER" >/dev/null 2>&1 \
  || hardening_die "Der Audit-Timer konnte nicht sicher beendet werden."
systemctl stop "$HARDENING_AUDIT_SERVICE" >/dev/null 2>&1 \
  || hardening_die "Der Audit-Dienst konnte nicht sicher beendet werden."
systemctl disable --now "$HARDENING_ROLLBACK_TIMER" >/dev/null 2>&1 \
  || hardening_die "Der Rollback-Timer konnte nicht sicher beendet werden."
systemctl stop "$HARDENING_ROLLBACK_SERVICE" >/dev/null 2>&1 \
  || hardening_die "Der Rollback-Dienst konnte nicht sicher beendet werden."

rm -f -- \
  "$SYSTEMD_ROOT/$HARDENING_AUDIT_SERVICE" \
  "$SYSTEMD_ROOT/$HARDENING_AUDIT_TIMER" \
  "$SYSTEMD_ROOT/$HARDENING_ROLLBACK_SERVICE" \
  "$SYSTEMD_ROOT/$HARDENING_ROLLBACK_TIMER"
systemctl daemon-reload

rm -f -- "$HARDENING_COMMAND" "$HARDENING_AUDIT_COMMAND" "$HARDENING_UNINSTALL_COMMAND"

# Der Modulvertrag wurde unmittelbar davor verifiziert, und der Pfad ist oben
# auf den festen Installationsort begrenzt. Transaktionen und Status bleiben als
# Audit-Nachweis erhalten; nur Werkzeug und Installationsbeleg werden entfernt.
rm -rf -- "$HARDENING_MODULE_ROOT"
rm -f -- "$HARDENING_INSTALLED_CONTRACT"

hardening_info "Hardening-Werkzeuge wurden entfernt."
hardening_info "Eine bestaetigte Hardening-Transaktion war nicht mehr aktiv."
hardening_warn "Manuell verwaltete Host-Richtlinien wurden durch die Deinstallation nicht veraendert."
hardening_warn "Gesicherte Transaktionen und Audit-Status wurden nicht geloescht."

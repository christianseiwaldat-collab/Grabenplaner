#!/usr/bin/env bash

readonly HARDENING_MODULE_ROOT="/opt/grabenplaner-hardening/module"
readonly HARDENING_CONFIG_ROOT="/etc/grabenplaner-hardening"
readonly HARDENING_STATE_ROOT="/var/lib/grabenplaner-host-security"
readonly HARDENING_TRANSACTION_ROOT="$HARDENING_STATE_ROOT/transactions"
readonly HARDENING_STATUS_FILE="$HARDENING_STATE_ROOT/status.json"
readonly HARDENING_INSTALLED_CONTRACT="$HARDENING_CONFIG_ROOT/installed-contract.json"
readonly HARDENING_PENDING_FILE="$HARDENING_STATE_ROOT/pending-transaction"
readonly HARDENING_COMMAND="/usr/local/sbin/grabenplaner-host-security"
readonly HARDENING_AUDIT_COMMAND="/usr/local/sbin/grabenplaner-host-security-test"
readonly HARDENING_AUDIT_SERVICE="grabenplaner-host-security-audit.service"
readonly HARDENING_AUDIT_TIMER="grabenplaner-host-security-audit.timer"
readonly HARDENING_ROLLBACK_SERVICE="grabenplaner-host-security-rollback.service"
readonly HARDENING_ROLLBACK_TIMER="grabenplaner-host-security-rollback.timer"
readonly HARDENING_CONTROLLER_LOCK="/run/grabenplaner-host-security/controller.lock"
readonly HARDENING_STATUS_LOCK="/run/grabenplaner-host-security/status.lock"
HARDENING_CONTROLLER_LOCK_FD=""
HARDENING_STATUS_LOCK_FD=""

hardening_log() {
  local level="$1"
  shift
  printf '%s [%s] %s\n' "$(date --utc '+%Y-%m-%dT%H:%M:%SZ')" "$level" "$*" >&2
}

hardening_info() { hardening_log INFO "$@"; }
hardening_warn() { hardening_log WARN "$@"; }
hardening_die() { hardening_log ERROR "$*"; exit 1; }

hardening_require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || hardening_die "Dieser Vorgang muss als root ausgefuehrt werden (z. B. mit sudo)."
}

hardening_require_command() {
  command -v "$1" >/dev/null 2>&1 || hardening_die "Erforderliches Programm fehlt: $1"
}

hardening_acquire_controller_lock() {
  local mode="${1:-fail-fast}" timeout_seconds="${2:-0}" lock_parent lock_mode controller_fd
  [[ "$mode" == "fail-fast" || "$mode" == "automatic" ]] || {
    hardening_warn "Unbekannter Sperrmodus: $mode"
    return 2
  }
  [[ "$timeout_seconds" =~ ^[0-9]+$ && "$timeout_seconds" -le 300 ]] || {
    hardening_warn "Die Sperrwartezeit muss zwischen 0 und 300 Sekunden liegen."
    return 2
  }
  [[ -z "$HARDENING_CONTROLLER_LOCK_FD" ]] || return 0
  hardening_require_command flock
  hardening_require_command stat
  lock_parent="$(dirname -- "$HARDENING_CONTROLLER_LOCK")"
  if [[ ! -e "$lock_parent" && ! -L "$lock_parent" ]]; then
    install -d -o root -g root -m 0755 -- "$lock_parent"
  fi
  [[ -d "$lock_parent" && ! -L "$lock_parent" && "$(stat -c '%u:%g' -- "$lock_parent")" == "0:0" ]] \
    || hardening_die "Das Host-Sicherheits-Sperrverzeichnis ist unsicher."
  lock_mode="$(stat -c '%a' -- "$lock_parent")"
  (( (8#$lock_mode & 022) == 0 )) \
    || hardening_die "Das Host-Sicherheits-Sperrverzeichnis ist unzulaessig beschreibbar."
  if [[ ! -e "$HARDENING_CONTROLLER_LOCK" && ! -L "$HARDENING_CONTROLLER_LOCK" ]]; then
    # noclobber uses an exclusive create and never replaces an inode another
    # controller may already be about to lock.
    (umask 077; set -o noclobber; : >"$HARDENING_CONTROLLER_LOCK") 2>/dev/null || true
  fi
  [[ -f "$HARDENING_CONTROLLER_LOCK" && ! -L "$HARDENING_CONTROLLER_LOCK" \
    && "$(stat -c '%u:%g:%a:%h' -- "$HARDENING_CONTROLLER_LOCK")" == "0:0:600:1" ]] \
    || hardening_die "Die Host-Sicherheits-Sperrdatei ist unsicher."
  exec {controller_fd}<>"$HARDENING_CONTROLLER_LOCK"
  if [[ "$mode" == "automatic" ]]; then
    if ! flock --wait "$timeout_seconds" "$controller_fd"; then
      exec {controller_fd}>&-
      return 1
    fi
  elif ! flock --nonblock "$controller_fd"; then
    exec {controller_fd}>&-
    return 1
  fi
  HARDENING_CONTROLLER_LOCK_FD="$controller_fd"
}

hardening_acquire_status_lock() {
  local timeout_seconds="${1:-120}" lock_parent lock_mode status_fd
  [[ "$timeout_seconds" =~ ^[0-9]+$ && "$timeout_seconds" -le 300 ]] || {
    hardening_warn "Die Status-Sperrwartezeit muss zwischen 0 und 300 Sekunden liegen."
    return 2
  }
  [[ -z "$HARDENING_STATUS_LOCK_FD" ]] || return 0
  hardening_require_command flock
  hardening_require_command stat
  lock_parent="$(dirname -- "$HARDENING_STATUS_LOCK")"
  if [[ ! -e "$lock_parent" && ! -L "$lock_parent" ]]; then
    install -d -o root -g root -m 0755 -- "$lock_parent"
  fi
  [[ -d "$lock_parent" && ! -L "$lock_parent" && "$(stat -c '%u:%g' -- "$lock_parent")" == "0:0" ]] \
    || hardening_die "Das Host-Sicherheits-Sperrverzeichnis ist unsicher."
  lock_mode="$(stat -c '%a' -- "$lock_parent")"
  (( (8#$lock_mode & 022) == 0 )) \
    || hardening_die "Das Host-Sicherheits-Sperrverzeichnis ist unzulaessig beschreibbar."
  if [[ ! -e "$HARDENING_STATUS_LOCK" && ! -L "$HARDENING_STATUS_LOCK" ]]; then
    (umask 077; set -o noclobber; : >"$HARDENING_STATUS_LOCK") 2>/dev/null || true
  fi
  [[ -f "$HARDENING_STATUS_LOCK" && ! -L "$HARDENING_STATUS_LOCK" \
    && "$(stat -c '%u:%g:%a:%h' -- "$HARDENING_STATUS_LOCK")" == "0:0:600:1" ]] \
    || hardening_die "Die Host-Sicherheits-Statussperre ist unsicher."
  exec {status_fd}<>"$HARDENING_STATUS_LOCK"
  if ! flock --wait "$timeout_seconds" "$status_fd"; then
    exec {status_fd}>&-
    return 1
  fi
  HARDENING_STATUS_LOCK_FD="$status_fd"
}

hardening_node() {
  if [[ -x /usr/bin/node ]]; then
    printf '%s\n' /usr/bin/node
  elif command -v node >/dev/null 2>&1; then
    readlink -f -- "$(command -v node)"
  else
    return 1
  fi
}

hardening_validate_os() {
  [[ -r /etc/os-release ]] || hardening_die "Die Betriebssystemkennung /etc/os-release fehlt."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || hardening_die "Unterstuetzt wird ausschliesslich Ubuntu Server."
  case "${VERSION_ID:-}" in
    24.04|26.04) ;;
    *) hardening_die "Unterstuetzt werden Ubuntu 24.04 LTS und 26.04 LTS; gefunden wurde ${VERSION_ID:-unbekannt}." ;;
  esac
  [[ "$(uname -m)" == "x86_64" ]] || hardening_die "Das Sicherheitsmodul ist fuer x86_64 vorgesehen."
}

hardening_assert_installed_contract() {
  local node
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Modulpruefung."
  [[ -f "$HARDENING_MODULE_ROOT/lib/hardening-contract.js" && ! -L "$HARDENING_MODULE_ROOT/lib/hardening-contract.js" ]] \
    || hardening_die "Die installierte Vertragspruefung fehlt."
  "$node" "$HARDENING_MODULE_ROOT/lib/hardening-contract.js" verify-installed \
    "$HARDENING_MODULE_ROOT" "$HARDENING_INSTALLED_CONTRACT" >/dev/null \
    || hardening_die "Das installierte Host-Sicherheitsmodul ist veraendert oder unvollstaendig."
}

hardening_validate_transaction_id() {
  local node
  node="$(hardening_node)" || hardening_die "Node.js fehlt fuer die Transaktionspruefung."
  "$node" "$HARDENING_MODULE_ROOT/lib/hardening-policy.js" validate-transaction "$1" >/dev/null \
    || hardening_die "Die Hardening-Transaktions-ID ist ungueltig."
}

hardening_secure_roots() {
  local root metadata group_entry status_gid=""
  for root in /opt/grabenplaner-hardening "$HARDENING_CONFIG_ROOT" "$HARDENING_STATE_ROOT" "$HARDENING_TRANSACTION_ROOT"; do
    if [[ ! -e "$root" && ! -L "$root" ]]; then
      case "$root" in
        /opt/grabenplaner-hardening) install -d -o root -g root -m 0755 -- "$root" ;;
        *) install -d -o root -g root -m 0700 -- "$root" ;;
      esac
    fi
    [[ -d "$root" && ! -L "$root" ]] || hardening_die "Ein Host-Sicherheitsverzeichnis ist unsicher: $root"
  done

  [[ "$(stat -c '%u:%g:%a' -- /opt/grabenplaner-hardening)" == "0:0:755" ]] \
    || hardening_die "Die Hardening-Programmablage ist unsicher."
  [[ "$(stat -c '%u:%g:%a' -- "$HARDENING_CONFIG_ROOT")" == "0:0:700" ]] \
    || hardening_die "Die Hardening-Konfigurationsablage ist unsicher."
  [[ "$(stat -c '%u:%g:%a' -- "$HARDENING_TRANSACTION_ROOT")" == "0:0:700" ]] \
    || hardening_die "Die Hardening-Transaktionsablage ist unsicher."

  metadata="$(stat -c '%u:%g:%a' -- "$HARDENING_STATE_ROOT")"
  if [[ "$metadata" != "0:0:700" ]]; then
    group_entry="$(getent group grabenplaner-monitor-status 2>/dev/null || true)"
    IFS=: read -r _ _ status_gid _ <<<"$group_entry"
    [[ -n "$status_gid" && "$metadata" == "0:${status_gid}:710" ]] \
      || hardening_die "Die Host-Sicherheitsstatusablage ist unsicher."
  fi
}

hardening_transaction_directory() {
  local transaction_id="$1"
  hardening_validate_transaction_id "$transaction_id"
  printf '%s/%s\n' "$HARDENING_TRANSACTION_ROOT" "$transaction_id"
}

hardening_atomic_install() {
  local source="$1" destination="$2" mode="$3" parent temporary parent_mode
  parent="$(dirname -- "$destination")"
  if [[ -e "$parent" || -L "$parent" ]]; then
    [[ -d "$parent" && ! -L "$parent" && "$(stat --format='%u' -- "$parent")" == "0" ]] \
      || hardening_die "Das Zielverzeichnis fuer eine Host-Konfiguration ist unsicher."
    parent_mode="$(stat --format='%a' -- "$parent")"
    (( (8#$parent_mode & 022) == 0 )) \
      || hardening_die "Das Zielverzeichnis fuer eine Host-Konfiguration ist beschreibbar fuer unberechtigte Benutzer."
  else
    install -d -o root -g root -m 0755 "$parent"
  fi
  temporary="$(mktemp "$parent/.grabenplaner-hardening.XXXXXXXX")"
  install -o root -g root -m "$mode" -- "$source" "$temporary"
  mv -f -- "$temporary" "$destination"
}

hardening_atomic_private_write() {
  local destination="$1" content="$2" parent temporary parent_mode
  parent="$(dirname -- "$destination")"
  [[ -d "$parent" && ! -L "$parent" && "$(stat --format='%u' -- "$parent")" == "0" ]] \
    || hardening_die "Das Zielverzeichnis fuer private Host-Sicherheitsdaten ist unsicher."
  parent_mode="$(stat --format='%a' -- "$parent")"
  (( (8#$parent_mode & 022) == 0 )) \
    || hardening_die "Das Zielverzeichnis fuer private Host-Sicherheitsdaten ist unzulaessig beschreibbar."
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" \
      && "$(stat --format='%u:%g:%a:%h' -- "$destination")" == "0:0:600:1" ]] \
      || hardening_die "Eine private Host-Sicherheitsdatei ist unsicher."
  fi
  temporary="$(mktemp "$parent/.grabenplaner-private.XXXXXXXX")"
  printf '%s\n' "$content" >"$temporary"
  chown root:root -- "$temporary"
  chmod 0600 -- "$temporary"
  mv -f -- "$temporary" "$destination"
  sync
}

hardening_systemd_unit_exists() {
  systemctl show --property=LoadState --value "$1" 2>/dev/null | grep -qxv not-found
}

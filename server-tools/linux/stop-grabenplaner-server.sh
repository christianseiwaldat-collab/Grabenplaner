#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_SOURCE="${BASH_SOURCE[0]}"
readonly EXPECTED_COMMAND_TARGET="/opt/grabenplaner/app/server-tools/linux/stop-grabenplaner-server.sh"
SCRIPT_PATH="$(readlink -f -- "$SCRIPT_SOURCE" 2>/dev/null || true)"
[[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] \
  || { printf '%s\n' "Das Wartungsskript konnte nicht sicher aufgeloest werden." >&2; exit 1; }
[[ ! -L "$SCRIPT_SOURCE" || "$SCRIPT_PATH" == "$EXPECTED_COMMAND_TARGET" ]] \
  || { printf '%s\n' "Der Wartungsbefehl zeigt nicht auf die erwartete Grabenplaner-Installation." >&2; exit 1; }
readonly SCRIPT_PATH
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

service="$GP_DEFAULT_SERVICE"
timeout_seconds=120
internal_live_url="http://127.0.0.1:3000/api/health/live"

while (($#)); do
  case "$1" in
    --service) service="${2:?Wert fuer --service fehlt}"; shift 2 ;;
    --timeout) timeout_seconds="${2:?Wert fuer --timeout fehlt}"; shift 2 ;;
    --internal-live-url) internal_live_url="${2:?Wert fuer --internal-live-url fehlt}"; shift 2 ;;
    -h|--help)
      printf '%s\n' "Verwendung: sudo ./stop-grabenplaner-server.sh [--service UNIT] [--timeout SEKUNDEN]"
      exit 0
      ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

[[ "$timeout_seconds" =~ ^[0-9]+$ ]] && (( timeout_seconds >= 5 && timeout_seconds <= 600 )) \
  || gp_die "--timeout muss zwischen 5 und 600 Sekunden liegen."
[[ "$internal_live_url" == http://127.0.0.1:*/* ]] || gp_die "Der interne Healthcheck muss auf 127.0.0.1 zeigen."

gp_require_root
gp_require_command systemctl
gp_require_command curl
gp_acquire_maintenance_lock
gp_stop_service "$service" "$timeout_seconds"

deadline=$((SECONDS + 10))
while (( SECONDS < deadline )); do
  if ! curl --silent --max-time 2 --output /dev/null -- "$internal_live_url"; then
    gp_info "$service wurde kontrolliert beendet; der interne Listener ist geschlossen."
    exit 0
  fi
  sleep 1
done
gp_die "$service ist inaktiv, aber der interne Listener antwortet weiterhin. Bitte auf einen fremden Prozess pruefen."

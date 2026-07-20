#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_SOURCE="${BASH_SOURCE[0]}"
readonly EXPECTED_COMMAND_TARGET="/opt/grabenplaner/app/server-tools/linux/monitor/run-grabenplaner-monitor.sh"
SCRIPT_PATH="$(readlink -f -- "$SCRIPT_SOURCE" 2>/dev/null || true)"
[[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] \
  || { printf '%s\n' "Das Wartungsskript konnte nicht sicher aufgeloest werden." >&2; exit 1; }
[[ ! -L "$SCRIPT_SOURCE" || "$SCRIPT_PATH" == "$EXPECTED_COMMAND_TARGET" ]] \
  || { printf '%s\n' "Der Wartungsbefehl zeigt nicht auf die erwartete Grabenplaner-Installation." >&2; exit 1; }
readonly SCRIPT_PATH
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

readonly STATUS_ROOT="/var/lib/grabenplaner-monitor"
readonly STATUS_FILE="$STATUS_ROOT/status.json"
readonly STATUS_GROUP="grabenplaner-monitor-status"
readonly RUNTIME_ROOT="/run/grabenplaner-monitor"
readonly TEST_COMMAND="/opt/grabenplaner/app/server-tools/linux/test-grabenplaner-server.sh"
readonly STATUS_HELPER="$SCRIPT_DIR/lib/monitor-status.js"
readonly APP_SERVICE="grabenplaner.service"

node="/usr/bin/node"
while (($#)); do
  case "$1" in
    --node) node="${2:?Wert fuer --node fehlt}"; shift 2 ;;
    -h|--help)
      printf '%s\n' "Verwendung: sudo run-grabenplaner-monitor.sh [--node /usr/bin/node]"
      exit 0
      ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

status_gid=""
check_output=""
check_error=""
error_recorded=0

record_generic_error() {
  local previous_status=$?
  trap - ERR
  if (( error_recorded == 0 )) && [[ -x "$node" && -f "$STATUS_HELPER" && ! -L "$STATUS_HELPER" && "$status_gid" =~ ^[0-9]+$ ]]; then
    "$node" "$STATUS_HELPER" --status-file "$STATUS_FILE" --status-gid "$status_gid" \
      error --code MONITOR_RUN_FAILED >/dev/null 2>&1 || true
  fi
  exit "$previous_status"
}

cleanup() {
  [[ -z "$check_output" ]] || rm -f -- "$check_output"
  [[ -z "$check_error" ]] || rm -f -- "$check_error"
}

trap record_generic_error ERR
trap cleanup EXIT

gp_require_root
for command_name in curl flock getent install mktemp readlink rm stat systemctl; do gp_require_command "$command_name"; done
node="$(gp_existing_file "$node" "Node.js")"
[[ -f "$TEST_COMMAND" && ! -L "$TEST_COMMAND" && -x "$TEST_COMMAND" ]] || gp_die "Das feste Serverpruefwerkzeug fehlt."
[[ -f "$STATUS_HELPER" && ! -L "$STATUS_HELPER" ]] || gp_die "Der feste Monitorstatus-Helfer fehlt."

status_gid="$(getent group "$STATUS_GROUP" | awk -F: '{print $3}')"
[[ "$status_gid" =~ ^[0-9]+$ ]] || gp_die "Die Monitor-Statusgruppe fehlt."
[[ -d "$STATUS_ROOT" && ! -L "$STATUS_ROOT" \
  && "$(stat --format='%u:%g:%a' -- "$STATUS_ROOT")" == "0:$status_gid:750" ]] \
  || gp_die "Der Monitorstatusordner ist unsicher."

if [[ -e "$RUNTIME_ROOT" || -L "$RUNTIME_ROOT" ]]; then
  [[ -d "$RUNTIME_ROOT" && ! -L "$RUNTIME_ROOT" && "$(stat --format='%u:%g:%a' -- "$RUNTIME_ROOT")" == "0:0:700" ]] \
    || gp_die "Das private Monitor-Laufzeitverzeichnis ist unsicher."
else
  install -d -m 0700 -o root -g root -- "$RUNTIME_ROOT"
fi
exec 8<>"$RUNTIME_ROOT/monitor.lock"
chmod 0600 -- "$RUNTIME_ROOT/monitor.lock"
flock --nonblock 8 || exit 0

# Eine freigegebene Wartung darf niemals durch die Selbstheilung gekreuzt werden.
gp_prepare_runtime_directory "$GP_DEFAULT_RUNTIME_DIR" >/dev/null
if [[ -e "$GP_DEFAULT_MAINTENANCE_LOCK" || -L "$GP_DEFAULT_MAINTENANCE_LOCK" ]]; then
  [[ -f "$GP_DEFAULT_MAINTENANCE_LOCK" && ! -L "$GP_DEFAULT_MAINTENANCE_LOCK" \
    && "$(stat --format='%u:%g' -- "$GP_DEFAULT_MAINTENANCE_LOCK")" == "0:0" ]] \
    || gp_die "Die Wartungssperre ist unsicher."
else
  install -m 0600 -o root -g root /dev/null "$GP_DEFAULT_MAINTENANCE_LOCK"
fi
exec 7<>"$GP_DEFAULT_MAINTENANCE_LOCK"
if ! flock --nonblock 7; then
  gp_info "Die Serverpruefung wird waehrend der kontrollierten Wartung ausgelassen."
  exit 0
fi

check_output="$(mktemp --tmpdir="$RUNTIME_ROOT" checks.XXXXXXXX)"
check_error="$(mktemp --tmpdir="$RUNTIME_ROOT" errors.XXXXXXXX)"
chmod 0600 -- "$check_output" "$check_error"

test_exit=0
if "$TEST_COMMAND" --node "$node" --monitor-mode >"$check_output" 2>"$check_error"; then
  test_exit=0
else
  test_exit=$?
fi

decision="$($node "$STATUS_HELPER" --status-file "$STATUS_FILE" --status-gid "$status_gid" \
  evaluate --output-file "$check_output" --test-exit "$test_exit")"
restart_eligible="$($node -e '
const value=JSON.parse(process.argv[1]);
if(typeof value.restartEligible!=="boolean")process.exit(1);
process.stdout.write(value.restartEligible?"1":"0");
' "$decision")"
check_complete="$($node -e '
const value=JSON.parse(process.argv[1]);
if(typeof value.complete!=="boolean")process.exit(1);
process.stdout.write(value.complete?"1":"0");
' "$decision")"

if [[ "$check_complete" != "1" ]]; then
  error_recorded=1
  gp_warn "Die Serverpruefung lieferte keinen vollstaendigen, freigegebenen Status."
  exit 1
fi

if [[ "$restart_eligible" != "1" ]]; then
  error_recorded=1
  gp_info "Die periodische Serverpruefung wurde mit begrenztem Status abgeschlossen."
  exit 0
fi

"$node" "$STATUS_HELPER" --status-file "$STATUS_FILE" --status-gid "$status_gid" restart-attempt >/dev/null
restart_successful=0
if systemctl restart "$APP_SERVICE"; then
  gp_load_env_file "$GP_DEFAULT_ENV_FILE"
  port="${PORT:-3000}"
  if [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) \
    && gp_wait_ready "http://127.0.0.1:${port}/api/health/live" 60; then
    restart_successful=1
  fi
fi
"$node" "$STATUS_HELPER" --status-file "$STATUS_FILE" --status-gid "$status_gid" \
  restart-result --successful "$restart_successful" >/dev/null
error_recorded=1
if (( restart_successful == 0 )); then
  gp_warn "Der begrenzte automatische Wiederanlauf war nicht erfolgreich."
  exit 1
fi
gp_info "Der Grabenplaner antwortet nach dem begrenzten automatischen Wiederanlauf wieder."

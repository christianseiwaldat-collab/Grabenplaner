#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "${CODESPACES:-}" != "true" ]]; then
  echo "Fehler: Diese Startdatei darf nur in GitHub Codespaces ausgeführt werden." >&2
  exit 1
fi

if [[ ! "${CODESPACE_NAME:-}" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]]; then
  echo "Fehler: CODESPACE_NAME fehlt oder enthält unerwartete Zeichen." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
STATE_ROOT="/workspaces/.grabenplaner-codespaces/${CODESPACE_NAME}"
PID_FILE="${STATE_ROOT}/runner.pid"
READY_FILE="${STATE_ROOT}/ready.json"
LOG_FILE="${STATE_ROOT}/codespaces-runner.log"
LAUNCH_LOCK_FILE="${STATE_ROOT}/post-start.lock"
FORWARDING_DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
PUBLIC_URL="https://${CODESPACE_NAME}-3000.${FORWARDING_DOMAIN}"

mkdir -p -- "${STATE_ROOT}"
chmod 700 -- "${STATE_ROOT}"
touch -- "${LOG_FILE}"
chmod 600 -- "${LOG_FILE}"
touch -- "${LAUNCH_LOCK_FILE}"
chmod 600 -- "${LAUNCH_LOCK_FILE}"
exec 9>"${LAUNCH_LOCK_FILE}"
if ! flock -w 130 9; then
  echo "Fehler: Ein paralleler Codespaces-Start wurde nicht rechtzeitig abgeschlossen." >&2
  exit 1
fi

runner_is_alive() {
  local pid="$1"
  local command_line=""
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  [[ -r "/proc/${pid}/cmdline" ]] || return 1
  command_line="$(tr '\0' ' ' < "/proc/${pid}/cmdline")"
  [[ "${command_line}" == *"scripts/codespaces-runner.js"* ]]
}

print_summary() {
  printf '\n%s\n' "======================================================================"
  printf '%s\n' "ACHTUNG: Diese Codespaces-Instanz ist nur für Demo- und Testdaten."
  printf '%s\n' "Keine echten Personal-, Gesundheits- oder Produktivdaten verwenden."
  printf '%s\n' "URL (privater Port): ${PUBLIC_URL}"
  printf '%s\n' "Zugangsdaten: ${STATE_ROOT}/secrets.json"
  printf '%s\n' "Protokoll: ${LOG_FILE}"
  printf '%s\n\n' "======================================================================"
}

RUNNER_PID=""
if [[ -f "${PID_FILE}" ]]; then
  RUNNER_PID="$(tr -d '[:space:]' < "${PID_FILE}")"
  if runner_is_alive "${RUNNER_PID}"; then
    if [[ -f "${READY_FILE}" ]]; then
      print_summary
      exit 0
    fi
  else
    rm -f -- "${PID_FILE}" "${READY_FILE}"
    RUNNER_PID=""
  fi
fi

if [[ -z "${RUNNER_PID}" ]]; then
  rm -f -- "${READY_FILE}"
  cd -- "${REPOSITORY_ROOT}"
  # Codespaces beendet nach dem Lifecycle-Hook dessen Prozessgruppe. Eine
  # eigene Sitzung hält den Runner davon unabhängig dauerhaft am Leben.
  nohup setsid -f node "${REPOSITORY_ROOT}/scripts/codespaces-runner.js" >> "${LOG_FILE}" 2>&1 < /dev/null
  for _ in $(seq 1 40); do
    if [[ -f "${PID_FILE}" ]]; then
      RUNNER_PID="$(tr -d '[:space:]' < "${PID_FILE}")"
      runner_is_alive "${RUNNER_PID}" && break
    fi
    RUNNER_PID=""
    sleep 0.25
  done
fi

for _ in $(seq 1 120); do
  if ! runner_is_alive "${RUNNER_PID}"; then
    ACTIVE_PID=""
    if [[ -f "${PID_FILE}" ]]; then
      ACTIVE_PID="$(tr -d '[:space:]' < "${PID_FILE}")"
    fi
    if runner_is_alive "${ACTIVE_PID}"; then
      RUNNER_PID="${ACTIVE_PID}"
    else
      echo "Der Codespaces-Runner ist beim Start fehlgeschlagen:" >&2
      tail -n 40 -- "${LOG_FILE}" >&2 || true
      exit 1
    fi
  fi
  if [[ -f "${READY_FILE}" ]]; then
    print_summary
    exit 0
  fi
  sleep 1
done

echo "Der Codespaces-Runner wurde nicht innerhalb von 120 Sekunden bereit." >&2
tail -n 40 -- "${LOG_FILE}" >&2 || true
exit 1

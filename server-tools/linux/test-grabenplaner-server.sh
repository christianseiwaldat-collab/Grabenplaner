#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

env_file="$GP_DEFAULT_ENV_FILE"
app_arg=""
data_arg=""
database_arg=""
backup_arg=""
public_url_arg=""
node_arg=""
service="$GP_DEFAULT_SERVICE"
caddy_service="$GP_DEFAULT_CADDY_SERVICE"
caddyfile="/etc/caddy/Caddyfile"
maximum_backup_age_hours=6
minimum_certificate_days=14
monitor_mode=0
monitor_timer="grabenplaner-monitor.timer"
monitor_status_file="/var/lib/grabenplaner-monitor/status.json"
monitor_status_group="grabenplaner-monitor-status"

while (($#)); do
  case "$1" in
    --env-file) env_file="${2:?Wert fuer --env-file fehlt}"; shift 2 ;;
    --app-dir) app_arg="${2:?Wert fuer --app-dir fehlt}"; shift 2 ;;
    --data-dir) data_arg="${2:?Wert fuer --data-dir fehlt}"; shift 2 ;;
    --database) database_arg="${2:?Wert fuer --database fehlt}"; shift 2 ;;
    --backup-dir) backup_arg="${2:?Wert fuer --backup-dir fehlt}"; shift 2 ;;
    --public-url) public_url_arg="${2:?Wert fuer --public-url fehlt}"; shift 2 ;;
    --node) node_arg="${2:?Wert fuer --node fehlt}"; shift 2 ;;
    --service) service="${2:?Wert fuer --service fehlt}"; shift 2 ;;
    --caddy-service) caddy_service="${2:?Wert fuer --caddy-service fehlt}"; shift 2 ;;
    --caddyfile) caddyfile="${2:?Wert fuer --caddyfile fehlt}"; shift 2 ;;
    --maximum-backup-age-hours) maximum_backup_age_hours="${2:?Wert fehlt}"; shift 2 ;;
    --minimum-certificate-days) minimum_certificate_days="${2:?Wert fehlt}"; shift 2 ;;
    --monitor-mode) monitor_mode=1; shift ;;
    -h|--help)
      printf '%s\n' "Verwendung: sudo ./test-grabenplaner-server.sh [--public-url https://...] [weitere Optionen]"
      exit 0
      ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

[[ "$maximum_backup_age_hours" =~ ^[0-9]+$ ]] && (( maximum_backup_age_hours >= 1 && maximum_backup_age_hours <= 168 )) \
  || gp_die "Das maximale Backupalter muss zwischen 1 und 168 Stunden liegen."
[[ "$minimum_certificate_days" =~ ^[0-9]+$ ]] && (( minimum_certificate_days >= 1 && minimum_certificate_days <= 365 )) \
  || gp_die "Die Zertifikatsreserve muss zwischen 1 und 365 Tagen liegen."

gp_require_root
for command_name in curl openssl systemctl stat find sort date df caddy readlink getent; do gp_require_command "$command_name"; done
gp_load_env_file "$env_file"

app_dir="$(gp_existing_directory "${app_arg:-$GP_DEFAULT_APP_DIR}" "App-Ordner")"
data_dir="$(gp_existing_directory "${data_arg:-${GRABENPLANER_DATA_DIR:-$GP_DEFAULT_DATA_DIR}}" "Datenordner")"
database="$(gp_existing_file "${database_arg:-${DB_PATH:-$data_dir/data/dienstplan.db}}" "SQLite-Datenbank")"
backup_dir="$(gp_existing_directory "${backup_arg:-${BACKUP_DIR:-$GP_DEFAULT_BACKUP_DIR}}" "Backupordner")"
public_url="${public_url_arg:-${GRABENPLANER_PUBLIC_URL:-}}"
port="${PORT:-3000}"
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || gp_die "PORT ist ungueltig."
internal_live_url="http://127.0.0.1:$port/api/health/live"
internal_ready_url="http://127.0.0.1:$port/api/health/ready"
if [[ -n "$node_arg" ]]; then node="$(gp_existing_file "$node_arg" "Node.js")"; else gp_require_command node; node="$(command -v node)"; fi
gp_validate_https_url "$node" "$public_url" || gp_die "GRABENPLANER_PUBLIC_URL muss eine reine HTTPS-Ursprungsadresse sein."
public_ready_url="${public_url%/}/api/health/ready"
caddyfile="$(gp_existing_file "$caddyfile" "Caddyfile")"

failures=0
check_ok() { printf 'OK\t%s\t%s\n' "$1" "$2"; }
check_fail() { printf 'FEHLER\t%s\t%s\n' "$1" "$2"; failures=$((failures + 1)); }

for unit in "$service" "$caddy_service" "$monitor_timer"; do
  if gp_systemd_unit_exists "$unit" && systemctl is-active --quiet "$unit"; then
    check_ok "Dienst $unit" "aktiv"
  else
    check_fail "Dienst $unit" "nicht aktiv oder nicht installiert"
  fi
done

monitor_status_gid="$(getent group "$monitor_status_group" | awk -F: '{print $3}')"
monitor_status_helper="$app_dir/server-tools/linux/monitor/lib/monitor-status.js"
if [[ "$monitor_status_gid" =~ ^[0-9]+$ && -f "$monitor_status_file" && ! -L "$monitor_status_file" \
  && "$(stat --format='%u:%g:%a:%h' -- "$monitor_status_file")" == "0:$monitor_status_gid:640:1" \
  && -f "$monitor_status_helper" && ! -L "$monitor_status_helper" ]] \
  && "$node" "$monitor_status_helper" --status-file "$monitor_status_file" --status-gid "$monitor_status_gid" inspect >/dev/null 2>&1; then
  check_ok "Monitor-Statusschutz" "root-verwaltet und schemafest"
else
  check_fail "Monitor-Statusschutz" "fehlt oder ist nicht sicher lesbar"
fi

if gp_url_reports_ready "$internal_live_url" 8; then check_ok "Interne Liveness" "$internal_live_url"; else check_fail "Interne Liveness" "nicht erreichbar"; fi
if gp_url_reports_ready "$internal_ready_url" 8; then check_ok "Interne Readiness" "$internal_ready_url"; else check_fail "Interne Readiness" "nicht bereit"; fi
if gp_url_reports_ready "$public_ready_url" 15; then check_ok "Oeffentliche HTTPS-Readiness" "$public_ready_url"; else check_fail "Oeffentliche HTTPS-Readiness" "nicht bereit"; fi

headers_file="$(mktemp --tmpdir grabenplaner-headers.XXXXXX)"
scanner_probe="$(mktemp --tmpdir grabenplaner-scanner.XXXXXX)"
cleanup() { rm -f -- "$headers_file" "$scanner_probe"; }
trap cleanup EXIT

if curl --fail --silent --show-error --max-time 15 --dump-header "$headers_file" --output /dev/null -- "$public_ready_url"; then
  if grep -Eqi '^Strict-Transport-Security:[[:space:]]*.*max-age=' "$headers_file"; then check_ok "HSTS" "gesetzt"; else check_fail "HSTS" "Header fehlt"; fi
  if grep -Eqi '^Content-Security-Policy:' "$headers_file"; then check_ok "Content-Security-Policy" "gesetzt"; else check_fail "Content-Security-Policy" "Header fehlt"; fi
  if grep -Eqi '^X-Content-Type-Options:[[:space:]]*nosniff' "$headers_file"; then check_ok "X-Content-Type-Options" "nosniff"; else check_fail "X-Content-Type-Options" "Header fehlt oder ist falsch"; fi
  if grep -Eqi '^Referrer-Policy:' "$headers_file"; then check_ok "Referrer-Policy" "gesetzt"; else check_fail "Referrer-Policy" "Header fehlt"; fi
else
  check_fail "HSTS" "Antwort konnte nicht gelesen werden"
  check_fail "Content-Security-Policy" "Antwort konnte nicht gelesen werden"
  check_fail "X-Content-Type-Options" "Antwort konnte nicht gelesen werden"
  check_fail "Referrer-Policy" "Antwort konnte nicht gelesen werden"
fi

readarray -t public_endpoint < <("$node" - "$public_url" <<'NODE'
const url = new URL(process.argv[2]);
process.stdout.write(`${url.hostname}\n${url.port || "443"}\n`);
NODE
)
certificate_host="${public_endpoint[0]:-}"
certificate_port="${public_endpoint[1]:-443}"
if [[ -n "$certificate_host" ]] && timeout 20 openssl s_client -connect "$certificate_host:$certificate_port" -servername "$certificate_host" </dev/null 2>/dev/null \
  | openssl x509 -noout -checkend "$((minimum_certificate_days * 86400))" >/dev/null 2>&1; then
  check_ok "TLS-Zertifikat" "mindestens $minimum_certificate_days Tage gueltig"
else
  check_fail "TLS-Zertifikat" "ungueltig, nicht erreichbar oder laeuft zu frueh ab"
fi

database_check="$("$node" - "$database" <<'NODE' 2>&1
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const result = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
  if (result.length !== 1 || result[0] !== "ok") throw new Error(result.join("; "));
  process.stdout.write("ok");
} finally { db.close(); }
NODE
)" || true
if [[ "$database_check" == "ok" ]]; then check_ok "SQLite quick_check" "ok"; else check_fail "SQLite quick_check" "fehlgeschlagen"; fi

latest_marker="$(find "$backup_dir" -maxdepth 1 -type f -name 'dienstplan-*.complete.json' -printf '%T@ %p\n' | sort --numeric-sort --reverse | head --lines 1 | cut --delimiter=' ' --fields=2-)"
if [[ -n "$latest_marker" ]]; then
  latest_snapshot="$(basename -- "$latest_marker" .complete.json)"
  latest_backup="$backup_dir/$latest_snapshot.db"
  paired_amu="$backup_dir/$latest_snapshot.amu"
  age_seconds=$(( $(date +%s) - $(stat --format='%Y' -- "$latest_marker") ))
  if (( age_seconds < -300 )); then
    check_fail "Backup-Aktualitaet" "Zeitstempel liegt unplausibel in der Zukunft"
  elif (( age_seconds <= maximum_backup_age_hours * 3600 )); then
    (( age_seconds < 0 )) && age_seconds=0
    check_ok "Backup-Aktualitaet" "$(basename -- "$latest_backup"), $((age_seconds / 3600))h alt"
  else
    check_fail "Backup-Aktualitaet" "aelter als ${maximum_backup_age_hours}h"
  fi
  verifier="$app_dir/server-tools/linux/lib/verify-backup.js"
  amu_module="$app_dir/lib/amu-storage.js"
  if [[ -f "$verifier" && -f "$amu_module" && -f "$latest_backup" && -d "$paired_amu" ]] \
    && "$node" "$verifier" "$latest_backup" "$paired_amu" "$amu_module" "$latest_marker" >/dev/null; then
    check_ok "Backup DB-/Dokumentkopplung" "Manifest, Hashes und Referenzen stimmen"
  else
    check_fail "Backup DB-/Dokumentkopplung" "Integritaetspruefung fehlgeschlagen"
  fi
else
  check_fail "Backup-Aktualitaet" "kein lokaler Sicherungspunkt vorhanden"
fi

printf 'Grabenplaner scanner readiness probe\n' >"$scanner_probe"
scanner_result="$("$node" - "$app_dir/lib/amu-storage.js" "$scanner_probe" <<'NODE' 2>/dev/null
const [modulePath, probe] = process.argv.slice(2);
const { scanWithAvailableEngine } = require(modulePath);
scanWithAvailableEngine(probe, { requireScanner: true })
  .then((result) => { if (!result.available || !result.clean) process.exit(1); process.stdout.write(result.engine || "bereit"); })
  .catch(() => process.exit(1));
NODE
)" || true
if [[ -n "$scanner_result" ]]; then check_ok "AUM-Virenscanner" "$scanner_result"; else check_fail "AUM-Virenscanner" "ClamAV nicht betriebsbereit"; fi

if caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null 2>&1; then check_ok "Caddy-Konfiguration" "gueltig"; else check_fail "Caddy-Konfiguration" "Validierung fehlgeschlagen"; fi

if [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == "1" && "$monitor_mode" -eq 1 ]]; then
  offsite_status_file="/var/lib/grabenplaner-offsite/status.json"
  offsite_status_group="grabenplaner-offsite-status"
  offsite_status_reader="$app_dir/lib/offsite-backup-status.js"
  offsite_status_gid="$(getent group "$offsite_status_group" | awk -F: '{print $3}')"
  offsite_timer_ok=1
  for offsite_timer in grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer; do
    if ! systemctl is-enabled --quiet "$offsite_timer" || ! systemctl is-active --quiet "$offsite_timer"; then
      offsite_timer_ok=0
    fi
  done
  offsite_status_current=0
  if [[ "$offsite_status_gid" =~ ^[0-9]+$ && -f "$offsite_status_file" && ! -L "$offsite_status_file" \
    && "$(stat --format='%u:%g:%a:%h' -- "$offsite_status_file")" == "0:$offsite_status_gid:640:1" \
    && -f "$offsite_status_reader" && ! -L "$offsite_status_reader" ]] \
    && "$node" - "$offsite_status_reader" "$offsite_status_file" <<'NODE' >/dev/null 2>&1
const [readerPath, statusPath] = process.argv.slice(2);
const { readOffsiteBackupStatus } = require(readerPath);
const diagnostics = readOffsiteBackupStatus({ configured: true, statusPath });
if (!diagnostics.statusAvailable || diagnostics.state !== "ok" || diagnostics.blocksMainReadiness !== false) process.exit(1);
NODE
  then
    offsite_status_current=1
  fi
  if (( offsite_timer_ok == 1 && offsite_status_current == 1 )); then
    check_ok "Offsite-Sicherung" "lokaler Status und Timer sind aktuell"
  else
    check_fail "Offsite-Sicherung" "lokaler Status oder Timer erfordert Aufmerksamkeit"
  fi
elif [[ "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == "1" ]]; then
  offsite_test_command="/usr/local/sbin/grabenplaner-offsite-test"
  if [[ "${GRABENPLANER_OFFSITE_STATUS_FILE:-}" != "/var/lib/grabenplaner-offsite/status.json" ]]; then
    check_fail "Offsite-Sicherung" "Konfiguration unvollstaendig"
  elif [[ ! -x "$offsite_test_command" ]]; then
    check_fail "Offsite-Sicherung" "eingerichteter Selbsttest fehlt"
  elif [[ "$(readlink -f -- "$offsite_test_command")" != "/opt/grabenplaner-offsite/module/test-grabenplaner-offsite.sh" ]]; then
    check_fail "Offsite-Sicherung" "Selbsttest hat kein freigegebenes Ziel"
  elif "$offsite_test_command" >/dev/null 2>&1; then
    check_ok "Offsite-Sicherung" "eingerichtet und Selbsttest erfolgreich"
  else
    check_fail "Offsite-Sicherung" "eingerichteter Selbsttest fehlgeschlagen"
  fi
else
  check_ok "Offsite-Sicherung" "nicht eingerichtet"
fi

available_kib="$(df --output=avail "$data_dir" | tail --lines 1 | tr -d '[:space:]')"
if [[ "$available_kib" =~ ^[0-9]+$ ]] && (( available_kib >= 1048576 )); then
  check_ok "Freier Datenspeicher" "$((available_kib / 1024)) MiB"
else
  check_fail "Freier Datenspeicher" "weniger als 1 GiB frei"
fi

if (( failures > 0 )); then
  gp_warn "$failures Serverpruefung(en) sind fehlgeschlagen."
  exit 1
fi
gp_info "Alle Serverpruefungen waren erfolgreich."

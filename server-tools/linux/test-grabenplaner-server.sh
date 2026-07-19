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
for command_name in curl openssl systemctl stat find sort date df caddy; do gp_require_command "$command_name"; done
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

for unit in "$service" "$caddy_service"; do
  if gp_systemd_unit_exists "$unit" && systemctl is-active --quiet "$unit"; then
    check_ok "Dienst $unit" "aktiv"
  else
    check_fail "Dienst $unit" "nicht aktiv oder nicht installiert"
  fi
done

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
  check_fail "HTTPS-Sicherheitsheader" "Antwort konnte nicht gelesen werden"
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

latest_backup="$(find "$backup_dir" -maxdepth 1 -type f -name 'dienstplan-*.db' -printf '%T@ %p\n' | sort --numeric-sort --reverse | head --lines 1 | cut --delimiter=' ' --fields=2-)"
if [[ -n "$latest_backup" ]]; then
  age_seconds=$(( $(date +%s) - $(stat --format='%Y' -- "$latest_backup") ))
  if (( age_seconds <= maximum_backup_age_hours * 3600 )); then
    check_ok "Backup-Aktualitaet" "$(basename -- "$latest_backup"), $((age_seconds / 3600))h alt"
  else
    check_fail "Backup-Aktualitaet" "aelter als ${maximum_backup_age_hours}h"
  fi
  paired_amu="${latest_backup%.db}.amu"
  verifier="$app_dir/server-tools/linux/lib/verify-backup.js"
  amu_module="$app_dir/lib/amu-storage.js"
  if [[ -f "$verifier" && -f "$amu_module" && -d "$paired_amu" ]] \
    && "$node" "$verifier" "$latest_backup" "$paired_amu" "$amu_module" >/dev/null; then
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

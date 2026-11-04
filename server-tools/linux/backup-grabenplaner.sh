#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly PATH
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH COREPACK_INTEGRITY_KEYS LD_PRELOAD LD_LIBRARY_PATH OPENSSL_CONF OPENSSL_MODULES

readonly SCRIPT_SOURCE="${BASH_SOURCE[0]}"
readonly EXPECTED_COMMAND_TARGET="/opt/grabenplaner/app/server-tools/linux/backup-grabenplaner.sh"
SCRIPT_PATH="$(readlink -f -- "$SCRIPT_SOURCE" 2>/dev/null || true)"
[[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] \
  || { printf '%s\n' "Das Wartungsskript konnte nicht sicher aufgeloest werden." >&2; exit 1; }
[[ ! -L "$SCRIPT_SOURCE" || "$SCRIPT_PATH" == "$EXPECTED_COMMAND_TARGET" ]] \
  || { printf '%s\n' "Der Wartungsbefehl zeigt nicht auf die erwartete Grabenplaner-Installation." >&2; exit 1; }
readonly SCRIPT_PATH
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
/usr/bin/python3 -I - "$SCRIPT_PATH" "$SCRIPT_DIR/lib/common.sh" "$SCRIPT_DIR/lib/postgresql-maintenance.sh" <<'PY' \
  || { printf '%s\n' 'Der Sicherungseinstieg ist nicht root-geschuetzt.' >&2; exit 1; }
import os, stat, sys
from pathlib import Path
assert os.geteuid() == 0
for name in sys.argv[1:]:
    file = Path(name)
    info = file.lstat()
    assert file.resolve() == file and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    for item in (file, *file.parents):
        info = item.lstat()
        assert info.st_uid == 0 and not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022 == 0
PY
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Verwendung: sudo ./backup-grabenplaner.sh [Optionen]

  --env-file PFAD       Geschuetzte Server-Umgebungsdatei
  --app-dir PFAD        Installierte App (Standard: /opt/grabenplaner/app)
  --data-dir PFAD       Geschuetzte Daten (Standard: /var/lib/grabenplaner)
  --database PFAD       Gepruefter PostgreSQL-Paaranker
  --backup-dir PFAD     Lokales Sicherungsziel (Standard: BACKUP_DIR)
  --keep ANZAHL         Anzahl lokaler Sicherungspunkte (1..1000)
  --service UNIT        systemd-App-Unit
  --node PFAD           Node.js-Programm
  --defer-archive       Interner Updater-Auftrag: frischen Punkt pruefen,
                       Archivabschluss vormerken (geerbte Wartungssperre).
  --finish-deferred    Nur vorgemerkte Archive abschliessen, ohne Dienststopp
                       oder neuen Punkt (geerbte Wartungssperre).
  --preserve-existing-backups
                       Interne Runtime-Migration: vorhandene Punkte erhalten
                       (geerbte FD9-Wartungssperre und ausdruecklich --keep 1000).
EOF
}

env_file="$GP_DEFAULT_ENV_FILE"
app_arg=""
data_arg=""
database_arg=""
backup_arg=""
keep_arg=""
service="$GP_DEFAULT_SERVICE"
node_arg=""
service_user="$GP_DEFAULT_SERVICE_USER"
service_group="$GP_DEFAULT_SERVICE_GROUP"
lock_already_held=0
preserve_existing_backups=0
defer_archive=0
finish_deferred=0

while (($#)); do
  case "$1" in
    --env-file) env_file="${2:?Wert fuer --env-file fehlt}"; shift 2 ;;
    --app-dir) app_arg="${2:?Wert fuer --app-dir fehlt}"; shift 2 ;;
    --data-dir) data_arg="${2:?Wert fuer --data-dir fehlt}"; shift 2 ;;
    --database) database_arg="${2:?Wert fuer --database fehlt}"; shift 2 ;;
    --backup-dir) backup_arg="${2:?Wert fuer --backup-dir fehlt}"; shift 2 ;;
    --keep) keep_arg="${2:?Wert fuer --keep fehlt}"; shift 2 ;;
    --service) service="${2:?Wert fuer --service fehlt}"; shift 2 ;;
    --node) node_arg="${2:?Wert fuer --node fehlt}"; shift 2 ;;
    --service-user) service_user="${2:?Wert fuer --service-user fehlt}"; shift 2 ;;
    --service-group) service_group="${2:?Wert fuer --service-group fehlt}"; shift 2 ;;
    --lock-already-held) lock_already_held=1; shift ;;
    --preserve-existing-backups) preserve_existing_backups=1; shift ;;
    --defer-archive) defer_archive=1; shift ;;
    --finish-deferred) finish_deferred=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done

gp_require_root
gp_require_command realpath
gp_require_command flock
gp_require_command sha256sum
gp_require_command runuser
gp_require_command getent
gp_load_env_file "$env_file"
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH COREPACK_INTEGRITY_KEYS LD_PRELOAD LD_LIBRARY_PATH OPENSSL_CONF OPENSSL_MODULES

[[ "${DB_PROVIDER:-}" == postgresql ]] \
  || gp_die 'Dieser GP-Stand sichert ausschliesslich PostgreSQL-Paare. Altsicherungen nur mit der Offline-Wiederherstellungskapsel pruefen.'
(( defer_archive == 0 )) \
  || gp_die 'SQLite-Archivoptionen sind in diesem Serverstand nicht mehr verfuegbar.'
# shellcheck source=server-tools/linux/lib/postgresql-maintenance.sh
source "$SCRIPT_DIR/lib/postgresql-maintenance.sh"
gp_postgresql_backup

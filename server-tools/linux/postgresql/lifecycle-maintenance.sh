#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly APP=/opt/grabenplaner/app
readonly CONFIG=/etc/grabenplaner/postgresql-operations.json
readonly STATE=/var/lib/grabenplaner-postgresql/operations
readonly ANCHOR=/var/lib/grabenplaner/data/postgresql-pair.json
readonly NODE=/usr/bin/node
readonly ACTION="${1:-}"
readonly REQUEST_ID="${2:-}"
[[ $EUID == 0 && $# == 2 && "$ACTION" =~ ^(backup|restart|shutdown|vps-reboot)$
   && "$REQUEST_ID" =~ ^[0-9a-f-]{36}$ ]] || exit 64
source "$APP/server-tools/linux/lib/common.sh"
[[ "$(readlink -f -- /proc/$$/fd/3 2>/dev/null || true)" == "$GP_DEFAULT_MAINTENANCE_LOCK" ]] || exit 73
flock --nonblock 3 || exit 73
exec 9>&3
[[ -f "$ANCHOR" && ! -L "$ANCHOR" ]] || exit 65
"$NODE" "$APP/server-tools/linux/lib/postgresql-operations.js" check-paths "$CONFIG" /var/lib/grabenplaner /var/backups/grabenplaner-postgresql >/dev/null
systemctl is-active --quiet grabenplaner.service || exit 69
# The root command owns the existing backup lease until its verified sequence
# completes. PostgreSQL operations never call the legacy SQLite backup path.
gp_begin_backup_ownership "$ANCHOR" "$NODE" "$APP/lib/backup-maintenance.js" 9 4
exec "$NODE" "$APP/server-tools/linux/postgresql/lifecycle-run.js" "$ACTION" "$REQUEST_ID"

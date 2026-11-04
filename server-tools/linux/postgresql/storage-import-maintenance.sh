#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
readonly APP=/opt/grabenplaner/app
[[ $EUID == 0 && $# == 1 ]] || exit 64
source "$APP/server-tools/linux/lib/common.sh"
[[ "$(readlink -f -- /proc/$$/fd/3)" == "$GP_DEFAULT_MAINTENANCE_LOCK" ]] || exit 73
flock --nonblock 3 || exit 73
exec 9>&3
/usr/bin/node -e 'require(process.argv[1]).validateRequest(JSON.parse(process.argv[2]))' "$APP/lib/vps-storage-contract.js" "$1"
gp_begin_backup_ownership /var/lib/grabenplaner/data/postgresql-pair.json /usr/bin/node "$APP/lib/backup-maintenance.js" 9 4
exec /usr/bin/node "$APP/server-tools/linux/postgresql/storage-import-run.js" "$1"

#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly APP=/opt/grabenplaner/app
readonly NODE=/usr/bin/node
[[ $EUID == 0 && $# == 2 && "${1:-}" =~ ^(prepare|execute)$ && "${2:-}" =~ ^[a-f0-9]{64}$ ]] || {
  printf '%s\n' 'Usage: sudo migrate-grabenplaner-postgresql.sh prepare|execute VERIFIED_PACKAGE_MANIFEST_SHA256' >&2
  exit 64
}
[[ "$(readlink -f -- "${BASH_SOURCE[0]}")" == "$APP/server-tools/linux/postgresql/migrate-grabenplaner-postgresql.sh" ]] || exit 65
source "$APP/server-tools/linux/lib/common.sh"
gp_acquire_maintenance_lock
if [[ "$1" == execute ]]; then
  # Source ownership prevents a second lifecycle backup while the final return
  # point is captured under this same lock. No host reboot is part of migration.
  gp_begin_backup_ownership /var/lib/grabenplaner/data/dienstplan.db "$NODE" "$APP/lib/backup-maintenance.js" 9 4
fi
exec "$NODE" "$APP/server-tools/linux/postgresql/migration-host.js" "$1" "$2"

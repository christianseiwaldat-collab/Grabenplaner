#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID == 0 && $# == 0 ]] || exit 64
readonly APP=/opt/grabenplaner/app
source "$APP/server-tools/linux/lib/common.sh"
# A failed request must never interfere with another owned maintenance window.
[[ -f "$GP_DEFAULT_MAINTENANCE_LOCK" && ! -L "$GP_DEFAULT_MAINTENANCE_LOCK" \
  && "$(stat -c '%u:%g:%a:%h' "$GP_DEFAULT_MAINTENANCE_LOCK")" == 0:0:600:1 ]] || exit 65
exec 9<>"$GP_DEFAULT_MAINTENANCE_LOCK"
flock --nonblock 9 || exit 0
/usr/bin/node "$APP/server-tools/linux/postgresql/lifecycle-status.js" recovery-required || exit 0
if ! systemctl is-active --quiet grabenplaner.service; then
  systemctl start grabenplaner.service
fi

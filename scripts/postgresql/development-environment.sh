#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/gpadmin/grabenplaner-pg-migration-20260912
data="$base/data"
bin=/usr/lib/postgresql/18/bin
[[ "$(id -un)" == gpadmin ]] || { echo 'Dedicated development owner required' >&2; exit 1; }
[[ "$(realpath "$base")" == "$base" && "$(realpath "$data")" == "$data" ]] || exit 1
[[ "$(cat "$base/ownership-marker")" == grabenplaner-postgresql-migration-development-v1 ]] || exit 1
[[ "$(cat "$data/PG_VERSION")" == 18 ]] || exit 1
[[ "$("$bin/postgres" -D "$data" -C port)" == 55482 ]] || exit 1
[[ "$("$bin/postgres" -D "$data" -C listen_addresses)" == 127.0.0.1 ]] || exit 1
running=false
if [[ -f "$data/postmaster.pid" ]]; then
  mapfile -t pidlines < "$data/postmaster.pid"
  [[ "${pidlines[0]}" =~ ^[0-9]+$ && "${pidlines[1]}" == "$data" && "${pidlines[3]}" == 55482 ]] || exit 1
  [[ "$(readlink -f "/proc/${pidlines[0]}/exe")" == "$bin/postgres" ]] || { echo 'Unexpected or stale development process identity' >&2; exit 1; }
  running=true
fi
case "${1:-status}" in
  status) printf 'Dedicated development PostgreSQL running=%s port=55482\n' "$running" ;;
  start)
    if [[ "$running" == false ]]; then nice -n 15 "$bin/pg_ctl" -D "$data" -l "$base/server.log" -w start; fi
    ;;
  stop)
    if [[ "$running" == true ]]; then "$bin/pg_ctl" -D "$data" -m fast -w stop; fi
    ;;
  *) echo 'Expected status, start or stop' >&2; exit 1 ;;
esac

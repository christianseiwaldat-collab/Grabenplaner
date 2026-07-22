#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly smoke_root="/var/lib/grabenplaner-offsite/application-smoke"
readonly data_root="$smoke_root/data-root"
readonly database="$data_root/data/dienstplan.db"
readonly helper="/opt/grabenplaner-offsite/module/lib/application-smoke.js"

[[ "${EUID:-$(id -u)}" -ne 0 ]] || exit 1
[[ "$#" -eq 0 && -d "$smoke_root" && ! -L "$smoke_root" \
  && -d "$data_root" && ! -L "$data_root" && -d "$(dirname -- "$database")" \
  && -f "$database" && ! -L "$database" && -f "$helper" && ! -L "$helper" \
  && -x /usr/bin/node ]] || exit 1

exec /usr/bin/node "$helper"

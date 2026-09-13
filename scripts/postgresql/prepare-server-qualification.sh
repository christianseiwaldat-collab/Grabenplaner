#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/home/gpadmin/grabenplaner-pg-migration-20260912
target="$base/qualification"
[[ "$(id -un)" == gpadmin && "$(realpath "$base")" == "$base" ]] || exit 1
[[ "$(cat "$base/ownership-marker")" == grabenplaner-postgresql-migration-development-v1 ]] || exit 1
if [[ -e "$target" ]]; then
  [[ "$(realpath "$target")" == "$target" && "$(cat "$target/ownership-marker")" == postgresql-block-8-qualification ]] || exit 1
else
  mkdir "$target"
  printf '%s\n' postgresql-block-8-qualification > "$target/ownership-marker"
fi
tar -xzf "$base/qualification-source.tgz" -C "$target" --no-same-owner
if [[ ! -e "$target/node_modules" ]]; then
  # Copy package dependencies only, reading the existing installation. Never
  # change the productive checkout, its permissions, environment or services.
  sudo -n tar -C /opt/grabenplaner/app -cf - node_modules | tar -C "$target" -xf - --no-same-owner
fi
mkdir -p "$target/tmp"
cd "$target"
node -e 'for (const p of ["pg","pdfkit","better-sqlite3"]) require.resolve(p); console.log("Isolated qualification dependencies ready")'

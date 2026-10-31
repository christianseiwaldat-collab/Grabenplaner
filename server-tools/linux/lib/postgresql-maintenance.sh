#!/usr/bin/env bash
# Loaded by the existing root-only backup wrapper after its argument parser.
gp_postgresql_backup() {
  local app_dir data_dir backup_dir node keep anchor operation_config helper inherited_maintenance_fd=9 privileged_node backup_action=backup
  app_dir="$(gp_existing_directory "${app_arg:-$GP_DEFAULT_APP_DIR}" 'App-Ordner')"
  data_dir="$(gp_existing_directory "${data_arg:-${GRABENPLANER_DATA_DIR:-$GP_DEFAULT_DATA_DIR}}" 'Datenordner')"
  backup_dir="$(gp_existing_directory "${backup_arg:-${BACKUP_DIR:-/var/backups/grabenplaner-postgresql}}" 'PostgreSQL-Sicherungsordner')"
  if [[ -n "$node_arg" ]]; then node="$(gp_existing_file "$node_arg" 'Node.js')"; else gp_require_command node; node="$(command -v node)"; fi
  keep="${keep_arg:-${GRABENPLANER_BACKUP_RETENTION_DAYS:-20}}"
  [[ "$keep" =~ ^[0-9]+$ ]] && (( keep>=1 && keep<=1000 )) || gp_die 'Die PostgreSQL-Aufbewahrung ist ungueltig.'
  if (( preserve_existing_backups == 1 )); then
    (( lock_already_held == 1 && finish_deferred == 0 && defer_archive == 0 )) \
      && [[ "$keep_arg" == 1000 ]] \
      || gp_die 'Der erhaltende Sicherungsauftrag benoetigt die geerbte Wartungssperre und ausdruecklich --keep 1000.'
    backup_action=backup-preserve
  fi
  anchor="$data_dir/data/postgresql-pair.json"
  [[ -z "$database_arg" || "$database_arg" == "$anchor" ]] || gp_die 'Die PostgreSQL-Sicherung akzeptiert nur den konfigurierten Paarbezug.'
  [[ -f "$anchor" && ! -L "$anchor" ]] || gp_die 'Der PostgreSQL-Paarbezug fehlt.'
  operation_config=/etc/grabenplaner/postgresql-operations.json
  helper="$app_dir/server-tools/linux/lib/postgresql-operations.js"
  [[ -f "$helper" && ! -L "$helper" ]] || gp_die 'Der PostgreSQL-Betriebsadapter fehlt.'
  privileged_node="$(gp_assert_root_node "$node")" || gp_die 'Die privilegierte Node-Laufzeit ist nicht root-geschuetzt.'
  gp_pg_backup_node() {
    /usr/bin/env -i PATH="$(dirname -- "$privileged_node"):/usr/sbin:/usr/bin:/sbin:/bin" \
      HOME=/root LANG=C.UTF-8 NODE_ENV=production "$privileged_node" --no-global-search-paths "$@"
  }
  # Establish source and dependency ownership without executing their verifier.
  /usr/bin/python3 -I - "$app_dir" <<'PY' \
    || gp_die 'Der App- und Abhaengigkeitsbaum ist nicht root-geschuetzt.'
import os, stat, sys
from pathlib import Path
root = Path(sys.argv[1])
assert os.geteuid() == 0 and root.resolve() == root
for item in (root, *root.parents):
    info = item.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0
for directory, folders, files in os.walk(root, followlinks=False):
    for name in (*folders, *files):
        item = Path(directory) / name
        info = item.lstat()
        assert item.resolve() == item and info.st_uid == 0 and info.st_mode & 0o022 == 0
        assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1
assert (root / 'node_modules').is_dir()
PY
  gp_pg_backup_node "$helper" check-paths "$operation_config" "$data_dir" "$backup_dir" >/dev/null || gp_die 'Der PostgreSQL-Betriebsbezug stimmt nicht.'
  gp_require_systemd_unit "$service"
  [[ "$service" == grabenplaner.service ]] || gp_die 'Der PostgreSQL-Betriebsvertrag gehoert zum GP-Dienst.'
  if (( lock_already_held == 1 )); then
    if (( preserve_existing_backups == 0 )) && [[ "$(readlink -f -- /proc/$$/fd/6 2>/dev/null || true)" == "$GP_DEFAULT_MAINTENANCE_LOCK" ]]; then inherited_maintenance_fd=6; fi
    [[ "$(readlink -f -- /proc/$$/fd/$inherited_maintenance_fd 2>/dev/null || true)" == "$GP_DEFAULT_MAINTENANCE_LOCK" ]] \
      && flock --nonblock "$inherited_maintenance_fd" || gp_die 'Die uebernommene Wartungssperre fehlt.'
  else gp_acquire_maintenance_lock; fi
  if (( finish_deferred == 0 )); then
    [[ "$(systemctl show "$service" --property=MainPID --value)" == 0 ]] && ! systemctl is-active --quiet "$service" \
      || gp_die 'Die GP-Schreibvorgaenge muessen vor der gekoppelten Sicherung beendet sein.'
  fi
  gp_acquire_backup_workspace_lock "$anchor" gp_pg_backup_node "$app_dir/lib/backup-workspace.js"
  if (( finish_deferred == 1 )); then
    gp_pg_backup_node "$helper" prune "$operation_config" "$keep"
    return
  fi
  # Dumps are compressed natively; the expensive retention/restore passes run
  # from the nightly workflow. Every invocation still creates a fresh pair.
  gp_pg_backup_node "$helper" "$backup_action" "$operation_config"
}

#!/usr/bin/env bash
# Loaded by the existing root-only backup wrapper after its argument parser.
gp_postgresql_backup() {
  local app_dir data_dir backup_dir node keep anchor operation_config helper inherited_maintenance_fd=9
  app_dir="$(gp_existing_directory "${app_arg:-$GP_DEFAULT_APP_DIR}" 'App-Ordner')"
  data_dir="$(gp_existing_directory "${data_arg:-${GRABENPLANER_DATA_DIR:-$GP_DEFAULT_DATA_DIR}}" 'Datenordner')"
  backup_dir="$(gp_existing_directory "${backup_arg:-${BACKUP_DIR:-/var/backups/grabenplaner-postgresql}}" 'PostgreSQL-Sicherungsordner')"
  if [[ -n "$node_arg" ]]; then node="$(gp_existing_file "$node_arg" 'Node.js')"; else gp_require_command node; node="$(command -v node)"; fi
  keep="${keep_arg:-${GRABENPLANER_BACKUP_RETENTION_DAYS:-20}}"
  [[ "$keep" =~ ^[0-9]+$ ]] && (( keep>=1 && keep<=1000 )) || gp_die 'Die PostgreSQL-Aufbewahrung ist ungueltig.'
  anchor="$data_dir/data/postgresql-pair.json"
  [[ -z "$database_arg" || "$database_arg" == "$anchor" ]] || gp_die 'Die PostgreSQL-Sicherung akzeptiert nur den konfigurierten Paarbezug.'
  [[ -f "$anchor" && ! -L "$anchor" ]] || gp_die 'Der PostgreSQL-Paarbezug fehlt.'
  operation_config=/etc/grabenplaner/postgresql-operations.json
  helper="$app_dir/server-tools/linux/lib/postgresql-operations.js"
  [[ -f "$helper" && ! -L "$helper" ]] || gp_die 'Der PostgreSQL-Betriebsadapter fehlt.'
  "$node" "$helper" check-paths "$operation_config" "$data_dir" "$backup_dir" >/dev/null || gp_die 'Der PostgreSQL-Betriebsbezug stimmt nicht.'
  gp_require_systemd_unit "$service"
  [[ "$service" == grabenplaner.service ]] || gp_die 'Der PostgreSQL-Betriebsvertrag gehoert zum GP-Dienst.'
  if (( lock_already_held == 1 )); then
    if [[ "$(readlink -f -- /proc/$$/fd/6 2>/dev/null || true)" == "$GP_DEFAULT_MAINTENANCE_LOCK" ]]; then inherited_maintenance_fd=6; fi
    [[ "$(readlink -f -- /proc/$$/fd/$inherited_maintenance_fd 2>/dev/null || true)" == "$GP_DEFAULT_MAINTENANCE_LOCK" ]] \
      && flock --nonblock "$inherited_maintenance_fd" || gp_die 'Die uebernommene Wartungssperre fehlt.'
  else gp_acquire_maintenance_lock; fi
  if (( finish_deferred == 0 )); then
    [[ "$(systemctl show "$service" --property=MainPID --value)" == 0 ]] && ! systemctl is-active --quiet "$service" \
      || gp_die 'Die GP-Schreibvorgaenge muessen vor der gekoppelten Sicherung beendet sein.'
  fi
  gp_acquire_backup_workspace_lock "$anchor" "$node" "$app_dir/lib/backup-workspace.js"
  if (( finish_deferred == 1 )); then
    "$node" "$helper" prune "$operation_config" "$keep"
    return
  fi
  # Dumps are compressed natively; the expensive retention/restore passes run
  # from the nightly workflow. Every invocation still creates a fresh pair.
  "$node" "$helper" backup "$operation_config"
}

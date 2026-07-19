#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Verwendung: sudo ./backup-grabenplaner.sh [Optionen]

  --env-file PFAD       Geschuetzte Server-Umgebungsdatei
  --app-dir PFAD        Installierte App (Standard: /opt/grabenplaner/app)
  --data-dir PFAD       Geschuetzte Daten (Standard: /var/lib/grabenplaner)
  --database PFAD       SQLite-Datei (Standard: DB_PATH bzw. data/dienstplan.db)
  --backup-dir PFAD     Lokales Sicherungsziel (Standard: BACKUP_DIR)
  --keep ANZAHL         Anzahl lokaler Sicherungspunkte (1..1000)
  --service UNIT        systemd-App-Unit
  --node PFAD           Node.js-Programm
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

app_dir="$(gp_existing_directory "${app_arg:-$GP_DEFAULT_APP_DIR}" "App-Ordner")"
data_dir="$(gp_existing_directory "${data_arg:-${GRABENPLANER_DATA_DIR:-$GP_DEFAULT_DATA_DIR}}" "Datenordner")"
database="$(gp_existing_file "${database_arg:-${DB_PATH:-$data_dir/data/dienstplan.db}}" "SQLite-Datenbank")"
backup_dir="$(gp_safe_absolute_path "${backup_arg:-${BACKUP_DIR:-$GP_DEFAULT_BACKUP_DIR}}" "Backupordner")"
amu_dir="$(gp_existing_directory "$data_dir/private/amu" "Geschuetzter Dokumentordner")"
keep="${keep_arg:-${GRABENPLANER_BACKUP_KEEP:-30}}"
[[ "$keep" =~ ^[0-9]+$ ]] && (( keep >= 1 && keep <= 1000 )) || gp_die "--keep muss zwischen 1 und 1000 liegen."

if [[ -n "$node_arg" ]]; then
  node="$(gp_existing_file "$node_arg" "Node.js")"
else
  gp_require_command node
  node="$(command -v node)"
fi
"$node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)' \
  || gp_die "Node.js >=22.13.0 wird fuer das verifizierte SQLite-Backup benoetigt."
getent passwd "$service_user" >/dev/null || gp_die "Dienstbenutzer fehlt: $service_user"
getent group "$service_group" >/dev/null || gp_die "Dienstgruppe fehlt: $service_group"

gp_require_systemd_unit "$service"
if systemctl is-active --quiet "$service"; then
  gp_die "$service muss fuer dieses externe Sicherungswerkzeug beendet sein. Der laufende Dienst erstellt seine eigenen konsistenten Sicherungen."
fi
(( lock_already_held == 1 )) || gp_acquire_maintenance_lock

database_dir="$(dirname -- "$database")"
gp_path_is_same_or_child "$database" "$data_dir" || gp_die "Die SQLite-Datenbank muss innerhalb des geschuetzten Datenordners liegen."
gp_path_is_same_or_child "$amu_dir" "$data_dir" || gp_die "Der Dokumentordner muss innerhalb des geschuetzten Datenordners liegen."
gp_assert_separate_trees "$backup_dir" "$data_dir" "Backup- und Datenordner"
gp_assert_separate_trees "$backup_dir" "$app_dir" "Backup- und App-Ordner"
gp_assert_separate_trees "$app_dir" "$data_dir" "App- und Datenordner"

database_lock_module="$app_dir/lib/database-lock.js"
amu_module="$app_dir/lib/amu-storage.js"
helper="$app_dir/server-tools/linux/lib/backup-snapshot.js"
for required in "$database_lock_module" "$amu_module" "$helper"; do
  [[ -f "$required" && ! -L "$required" ]] || gp_die "Backupmodul fehlt: $required"
done

install -d -m 0750 -o "$service_user" -g "$service_group" -- "$backup_dir"
timestamp="$(date --utc '+%Y-%m-%dT%H-%M-%S-%3N')"
snapshot="dienstplan-$timestamp"
target_database="$backup_dir/$snapshot.db"
target_amu="$backup_dir/$snapshot.amu"
partial_database="$backup_dir/.$snapshot-$$.partial.db"
partial_amu="$backup_dir/.$snapshot-$$.partial.amu"
result_file="$backup_dir/.$snapshot-$$.result.json"
snapshot_committed=0

cleanup() {
  rm -f -- "$partial_database" "$result_file"
  if [[ -d "$partial_amu" && ! -L "$partial_amu" ]]; then rm -rf -- "$partial_amu"; fi
  if (( snapshot_committed == 0 )); then
    rm -f -- "$target_database"
    if [[ -d "$target_amu" && ! -L "$target_amu" ]]; then rm -rf -- "$target_amu"; fi
  fi
}
trap cleanup EXIT

gp_info "Erstelle gekoppelten und verifizierten SQLite-/Dokumentsicherungspunkt."
if ! (cd -- "$data_dir" && runuser --user "$service_user" -- env -i PATH="/usr/local/bin:/usr/bin:/bin" NODE_ENV=production \
  "$node" "$helper" \
  "$database" "$partial_database" "$database_lock_module" "$amu_module" \
  "$amu_dir" "$partial_amu" "$(basename -- "$target_database")") >"$result_file"; then
  gp_die "Der gekoppelte Sicherungspunkt konnte nicht erstellt werden."
fi
[[ -s "$partial_database" && -d "$partial_amu" && -f "$partial_amu/manifest.json" ]] \
  || gp_die "Der Sicherungshelfer lieferte keinen vollstaendigen Sicherungspunkt."

mv -- "$partial_amu" "$target_amu"
mv -- "$partial_database" "$target_database"
chown "$service_user:$service_group" -- "$target_database"
chmod 0640 -- "$target_database"
chown -R "$service_user:$service_group" -- "$target_amu"
find "$target_amu" -type d -exec chmod 0750 -- {} +
find "$target_amu" -type f -exec chmod 0640 -- {} +
snapshot_committed=1

mapfile -t old_backups < <(
  find "$backup_dir" -maxdepth 1 -type f -name 'dienstplan-*.db' -printf '%T@ %p\n' \
    | sort --numeric-sort --reverse \
    | tail --lines "+$((keep + 1))" \
    | cut --delimiter=' ' --fields=2-
)
for old_database in "${old_backups[@]}"; do
  [[ -n "$old_database" ]] || continue
  gp_path_is_same_or_child "$old_database" "$backup_dir" || gp_die "Aufbewahrungspfad verlaesst den Backupordner: $old_database"
  old_amu="${old_database%.db}.amu"
  rm -f -- "$old_database"
  if [[ -d "$old_amu" && ! -L "$old_amu" ]]; then
    gp_path_is_same_or_child "$old_amu" "$backup_dir" || gp_die "Dokument-Backup verlaesst den Backupordner: $old_amu"
    rm -rf -- "$old_amu"
  elif [[ -e "$old_amu" ]]; then
    gp_warn "Unzulaessiger gekoppelter Pfad wurde nicht entfernt: $old_amu"
  fi
done

verification_json="$(cat -- "$result_file")"
"$node" - "$target_database" "$target_amu" "$verification_json" <<'NODE'
const [database, documents, raw] = process.argv.slice(2);
const verification = JSON.parse(raw);
process.stdout.write(`${JSON.stringify({
  ok: true,
  path: database,
  amuBackup: documents,
  sha256: verification.databaseSha256,
  protectedFiles: verification.fileCount,
  requiredStorageKeys: verification.requiredStorageKeys,
  createdAt: new Date().toISOString(),
})}\n`);
NODE
gp_info "Sicherungspunkt erstellt: $(basename -- "$target_database")"

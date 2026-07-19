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
runtime_directory="$(gp_prepare_runtime_directory)"
snapshot="dienstplan-$timestamp-$("$node" -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"
target_database="$backup_dir/$snapshot.db"
target_amu="$backup_dir/$snapshot.amu"
target_marker="$backup_dir/$snapshot.complete.json"
staging_directory="$(mktemp --directory --tmpdir="$runtime_directory" backup-stage.XXXXXXXX)"
result_file="$(mktemp --tmpdir="$runtime_directory" backup-result.XXXXXXXX)"
marker_file="$(mktemp --tmpdir="$runtime_directory" backup-marker.XXXXXXXX)"
chown "$service_user:$service_group" -- "$staging_directory"
chmod 0750 -- "$staging_directory"
chmod 0600 -- "$result_file" "$marker_file"
partial_database="$staging_directory/$snapshot.db"
partial_amu="$staging_directory/$snapshot.amu"
snapshot_committed=0

cleanup() {
  if [[ -f "$result_file" && ! -L "$result_file" ]]; then rm -f -- "$result_file"; fi
  if [[ -f "$marker_file" && ! -L "$marker_file" ]]; then rm -f -- "$marker_file"; fi
  if [[ -d "$staging_directory" && ! -L "$staging_directory" ]] \
    && gp_path_is_same_or_child "$staging_directory" "$runtime_directory"; then
    rm -rf -- "$staging_directory"
  fi
  if (( snapshot_committed == 0 )); then
    if [[ -f "$target_marker" && ! -L "$target_marker" ]]; then rm -f -- "$target_marker"; fi
    if [[ -f "$target_database" && ! -L "$target_database" ]]; then rm -f -- "$target_database"; fi
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

mv -T -- "$partial_amu" "$target_amu"
mv -T -- "$partial_database" "$target_database"
chown "$service_user:$service_group" -- "$target_database"
chmod 0640 -- "$target_database"
chown -R "$service_user:$service_group" -- "$target_amu"
find "$target_amu" -type d -exec chmod 0750 -- {} +
find "$target_amu" -type f -exec chmod 0640 -- {} +

verification_json="$(cat -- "$result_file")"
"$node" - "$marker_file" "$snapshot" "$target_database" "$target_amu" "$verification_json" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [file, snapshot, databasePath, documentsPath, raw] = process.argv.slice(2);
const verification = JSON.parse(raw);
const databaseStat = fs.lstatSync(databasePath);
const manifestPath = path.join(documentsPath, "manifest.json");
const manifestStat = fs.lstatSync(manifestPath);
const sha256File = (target) => crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()
  || !Number.isSafeInteger(verification.fileCount) || verification.fileCount < 0
  || sha256File(databasePath) !== verification.databaseSha256) throw new Error("Der Sicherungsbeleg konnte nicht sicher erzeugt werden.");
const committedAt = new Date().toISOString();
fs.writeFileSync(file, `${JSON.stringify({
  format: "grabenplaner-backup-commit",
  schemaVersion: 1,
  snapshot,
  committedAt,
  database: { fileName: path.basename(databasePath), sha256: verification.databaseSha256, bytes: databaseStat.size },
  protectedDocuments: {
    directoryName: path.basename(documentsPath),
    files: verification.fileCount,
    manifestFileName: "manifest.json",
    manifestSha256: sha256File(manifestPath),
    manifestBytes: manifestStat.size,
  },
  verification: { status: "verified", verifiedAt: committedAt },
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
NODE
chown "root:$service_group" -- "$marker_file"
chmod 0640 -- "$marker_file"
mv -T -- "$marker_file" "$target_marker"
verifier="$app_dir/server-tools/linux/lib/verify-backup.js"
"$node" "$verifier" "$target_database" "$target_amu" "$amu_module" "$target_marker" >/dev/null \
  || gp_die "Der veroeffentlichte Sicherungspunkt konnte nicht erneut verifiziert werden."
snapshot_committed=1
pruner="$app_dir/server-tools/linux/lib/prune-backups.js"
[[ -f "$pruner" && ! -L "$pruner" ]] || gp_die "Das vertrauenswuerdige Aufbewahrungsmodul fehlt."
"$node" "$pruner" "$backup_dir" "$keep" "$verifier" "$amu_module" >/dev/null \
  || gp_die "Die verifizierte Backup-Aufbewahrung konnte nicht sicher ausgefuehrt werden."
"$node" - "$target_database" "$target_amu" "$target_marker" "$verification_json" <<'NODE'
const [database, documents, marker, raw] = process.argv.slice(2);
const verification = JSON.parse(raw);
process.stdout.write(`${JSON.stringify({
  ok: true,
  path: database,
  amuBackup: documents,
  commitMarker: marker,
  sha256: verification.databaseSha256,
  protectedFiles: verification.fileCount,
  requiredStorageKeys: verification.requiredStorageKeys,
  createdAt: new Date().toISOString(),
})}\n`);
NODE
gp_info "Sicherungspunkt erstellt: $(basename -- "$target_database")"

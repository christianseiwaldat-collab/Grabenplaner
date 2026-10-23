#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly PATH
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_ICU_DATA NODE_V8_COVERAGE NODE_REDIRECT_WARNINGS NODE_TLS_REJECT_UNAUTHORIZED BASH_ENV ENV CDPATH COREPACK_INTEGRITY_KEYS OPENSSL_CONF OPENSSL_MODULES LD_PRELOAD LD_LIBRARY_PATH

# Explicit PostgreSQL-only Core 5 -> 6 / Offsite 12 -> 13 maintenance.
# Core 5 with external module 13 is only a paused, locked transition state.
# The old app tree and all PostgreSQL data are retained for the normal updater
# rollback. An unsuccessful pre-commit transition restores exact module 12 and
# the rendered bootstrap command before releasing the previous timer states.
readonly SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_PATH="$(readlink -f -- "$SCRIPT_SOURCE" 2>/dev/null || true)"
[[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] \
  || { printf '%s\n' 'Das Runtime-v6-Migrationsskript ist ungueltig.' >&2; exit 1; }
readonly SCRIPT_PATH
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# Root must not execute an entrypoint or shared verifier from an account-writable
# source directory. Package bytes are checked independently after extraction.
for trusted_source_file in "$SCRIPT_PATH" "$SCRIPT_DIR/lib/common.sh"; do
  [[ -f "$trusted_source_file" && ! -L "$trusted_source_file" \
    && "$(stat --format='%u:%h' -- "$trusted_source_file")" == '0:1' ]] \
    || { printf '%s\n' 'Der Wartungseinstieg ist nicht root-geschuetzt.' >&2; exit 1; }
  trusted_source_parent="$trusted_source_file"
  while :; do
    [[ ! -L "$trusted_source_parent" && "$(stat --format='%u' -- "$trusted_source_parent")" == 0 ]] \
      || { printf '%s\n' 'Der Wartungspfad ist nicht root-geschuetzt.' >&2; exit 1; }
    trusted_source_mode="$(stat --format='%a' -- "$trusted_source_parent")"
    (( (8#$trusted_source_mode & 022) == 0 )) \
      || { printf '%s\n' 'Der Wartungspfad ist fremdschreibbar.' >&2; exit 1; }
    [[ "$trusted_source_parent" != / ]] || break
    trusted_source_parent="$(dirname -- "$trusted_source_parent")"
  done
done
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
readonly APP_DIR=/opt/grabenplaner/app
readonly ENV_FILE=/etc/grabenplaner/grabenplaner.env
readonly DATA_DIR=/var/lib/grabenplaner
readonly OFFSITE_MODULE=/opt/grabenplaner-offsite/module
readonly OFFSITE_RECEIPT=/etc/grabenplaner/offsite/installed-contract.json
readonly BOOTSTRAP_COMMAND=/usr/local/sbin/grabenplaner-bootstrap-admin
readonly MAX_EXPANDED_BYTES=4294967296
package_arg='' sha256_arg='' sha256_file_arg='' node_arg='' pnpm_arg=''
health_timeout=1500
while (($#)); do
  case "$1" in
    --package) package_arg="${2:?Paket fehlt}"; shift 2 ;;
    --sha256) sha256_arg="${2:?SHA256 fehlt}"; shift 2 ;;
    --sha256-file) sha256_file_arg="${2:?SHA256-Datei fehlt}"; shift 2 ;;
    --node) node_arg="${2:?Node.js fehlt}"; shift 2 ;;
    --pnpm) pnpm_arg="${2:?pnpm fehlt}"; shift 2 ;;
    --health-timeout) health_timeout="${2:?Timeout fehlt}"; shift 2 ;;
    --help|-h)
      printf '%s\n' 'sudo migrate-grabenplaner-runtime-v6.sh --package /absolut/server.zip --sha256 HEX [--node /absolut/node] [--pnpm /absolut/pnpm]'
      printf '%s\n' 'Explizite Core-5-zu-6-/Offsite-12-zu-13-Wartung fuer einen bereits verifizierten produktiven PostgreSQL-Paarbetrieb; kein Datenbankwechsel und kein Host-Neustart.'
      exit 0 ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done
gp_require_root
for command_name in awk bash chown chmod clamscan cmp cp curl date du find flock getent grep install mkdir mktemp mv readlink realpath rm rmdir runuser sha256sum stat systemctl uname unzip; do
  gp_require_command "$command_name"
done
[[ "$(uname -m)" == x86_64 && -x /usr/bin/python3 ]] || gp_die 'Linux x86_64 und /usr/bin/python3 sind erforderlich.'
[[ -n "$package_arg" && ( -z "$sha256_arg" || -z "$sha256_file_arg" ) ]] || gp_die 'Ein Paket und genau eine SHA256-Quelle sind erforderlich.'
[[ "$health_timeout" =~ ^[0-9]+$ ]] && (( health_timeout >= 30 && health_timeout <= 1500 )) || gp_die 'Ungueltiges Health-Timeout.'
if [[ -n "$node_arg" ]]; then node="$(gp_existing_file "$node_arg" 'Node.js')"; else gp_require_command node; node="$(readlink -f -- "$(command -v node)")"; fi
node="$(gp_assert_root_node "$node")" || gp_die 'Die privilegierte Node-Laufzeit ist nicht root-geschuetzt.'
root_node() { /usr/bin/env -i PATH="$PATH" LANG=C.UTF-8 HOME=/root NODE_ENV=production "$node" --no-global-search-paths "$@"; }
root_node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13)||process.arch!=="x64")process.exit(1)' || gp_die 'Node.js >=22.13.0 x64 wird benoetigt.'
package="$(gp_existing_file "$package_arg" 'Migrationspaket')"
[[ "$package" == *.zip ]] || gp_die 'Ein offizielles Linux-Server-ZIP wird benoetigt.'
if [[ -n "$sha256_file_arg" ]]; then sha256_file="$(gp_existing_file "$sha256_file_arg" 'SHA256-Datei')"; sha256_arg="$(awk 'NR==1 {print $1;exit}' "$sha256_file")";
elif [[ -z "$sha256_arg" ]]; then sha256_file="$(gp_existing_file "$package.sha256" 'SHA256-Datei')"; sha256_arg="$(awk 'NR==1 {print $1;exit}' "$sha256_file")"; fi
gp_validate_sha256 "$sha256_arg"
sha256_arg="${sha256_arg,,}"
gp_load_env_file "$ENV_FILE"
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_ICU_DATA NODE_V8_COVERAGE NODE_REDIRECT_WARNINGS NODE_TLS_REJECT_UNAUTHORIZED BASH_ENV ENV CDPATH COREPACK_INTEGRITY_KEYS OPENSSL_CONF OPENSSL_MODULES LD_PRELOAD LD_LIBRARY_PATH
[[ "${DB_PROVIDER:-}" == postgresql && "${NODE_ENV:-}" == production \
  && "${GRABENPLANER_OPERATION_MODE:-}" == server && "${GRABENPLANER_DEPLOYMENT_KIND:-}" == production \
  && "${GRABENPLANER_DATA_DIR:-}" == "$DATA_DIR" && "${DB_PATH:-}" == "$DATA_DIR/data/postgresql-pair.json" \
  && "${GRABENPLANER_OFFSITE_CONFIGURED:-0}" == 1 && -z "${GRABENPLANER_BOOTSTRAP_TOKEN:-}" ]] \
  || gp_die 'Diese Migration verlangt einen abgeschlossenen produktiven PostgreSQL-Paarbetrieb mit Offsite12.'
app_dir="$(gp_existing_directory "$APP_DIR" 'Bestehende App')"
public_url="${GRABENPLANER_PUBLIC_URL:-}"
port="${PORT:-3000}"
gp_validate_https_url root_node "$public_url" || gp_die 'Ungueltige produktive HTTPS-Adresse.'
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || gp_die 'Ungueltiger interner Port.'
preflight_args=(--node "$node")
if [[ -n "$pnpm_arg" ]]; then
  gp_assert_root_package_manager "$pnpm_arg" >/dev/null || gp_die 'Die Paketmanager-Distribution ist nicht root-geschuetzt.'
elif command -v pnpm >/dev/null 2>&1; then
  gp_assert_root_package_manager "$(command -v pnpm)" >/dev/null || gp_die 'Die Paketmanager-Distribution ist nicht root-geschuetzt.'
elif command -v corepack >/dev/null 2>&1; then
  gp_assert_root_package_manager "$(command -v corepack)" pnpm >/dev/null || gp_die 'Die Corepack-Distribution ist nicht root-geschuetzt.'
else gp_die 'Weder pnpm noch Corepack/pnpm ist vorhanden.'; fi
[[ -z "$pnpm_arg" ]] || preflight_args+=(--pnpm "$pnpm_arg")
bash "$SCRIPT_DIR/preflight-grabenplaner-deploy.sh" "${preflight_args[@]}" >/dev/null || gp_die 'Der verpflichtende read-only Deploy-Vorabcheck ist nicht gruen.'
env_sha256_before="$(gp_sha256 "$ENV_FILE")"
internal_ready_url="http://127.0.0.1:$port/api/health/ready"
public_ready_url="${public_url%/}/api/health/ready"
app_parent="$(dirname -- "$app_dir")"
work_root="$(mktemp --directory --tmpdir="$app_parent" .runtime-v6-migration.XXXXXXXX)"
chown root:root -- "$work_root"; chmod 0711 -- "$work_root"
staged_package="$work_root/package.zip"
extract_root="$work_root/untrusted-extract"
rollback_root="$work_root/rollback"
mkdir -m 0700 -- "$extract_root" "$rollback_root"
updater_commit_marker="$work_root/updater-commit.json"
transition_file="$work_root/transition.json"
module_phase=0 bootstrap_changed=0 transition_complete=0 interrupted=0 timers_paused=0 rollback_failed=0
offsite_timer_names=(grabenplaner-offsite-assurance.timer grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer)
offsite_timer_was_active=(0 0 0 0)
restore_timer_states() {
  local index actual expected failures=0
  for index in "${!offsite_timer_names[@]}"; do
    expected=inactive
    if (( offsite_timer_was_active[index] == 1 )); then
      expected=active
      systemctl start "${offsite_timer_names[index]}" >/dev/null 2>&1 || failures=1
    else
      systemctl stop "${offsite_timer_names[index]}" >/dev/null 2>&1 || failures=1
    fi
    actual="$(systemctl show "${offsite_timer_names[index]}" --property=ActiveState --value)" || failures=1
    [[ "$actual" == "$expected" ]] || failures=1
  done
  (( failures == 0 )) || return 1
  timers_paused=0
}
install_atomic_root_file() {
  local source="$1" target="$2" permissions="$3" pending
  [[ "$target" == "$BOOTSTRAP_COMMAND" || "$target" == "$OFFSITE_RECEIPT" ]] || return 1
  pending="$(mktemp "$(dirname -- "$target")/.runtime-v6-file.XXXXXXXX")" || return 1
  install -m "$permissions" -o root -g root -- "$source" "$pending" || return 1
  root_node - "$pending" <<'NODE' || return 1
const fs=require('node:fs');const fd=fs.openSync(process.argv[2],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.nlink!==1)throw Error('Unsafe pending file');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
  mv -T -- "$pending" "$target" || return 1
  root_node - "$(dirname -- "$target")" <<'NODE'
const fs=require('node:fs');const fd=fs.openSync(process.argv[2],fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
}
commit_is_valid() {
  [[ -f "$updater_commit_marker" && ! -L "$updater_commit_marker" ]] || return 1
  root_node - "$updater_commit_marker" "${candidate_version:-}" "$sha256_arg" <<'NODE'
const fs=require('node:fs');const [file,version,sha]=process.argv.slice(2),s=fs.lstatSync(file),v=JSON.parse(fs.readFileSync(file,'utf8'));
if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||(s.mode&0o777)!==0o600||v.format!=='grabenplaner-update-commit'||v.schemaVersion!==1||v.status!=='committed'||v.installedVersion!==version||v.packageSha256!==sha||!Number.isFinite(Date.parse(v.committedAt)))process.exit(1);
NODE
}
restore_predecessor_module() {
  # The updater must already have restored the exact old app. Never install
  # module12 over a committed/uncertain Core6 or roll PostgreSQL writes back.
  root_node "$extract_root/server-tools/linux/lib/runtime-v6-transition.js" verify "$app_dir" "$extract_root" >/dev/null || return 1
  if (( module_phase >= 1 )); then
    if [[ -d "$rollback_root/module12" && ! -L "$rollback_root/module12" ]]; then
      if [[ -e "$OFFSITE_MODULE" || -L "$OFFSITE_MODULE" ]]; then
        [[ -d "$OFFSITE_MODULE" && ! -L "$OFFSITE_MODULE" && ! -e "$rollback_root/rejected-module13" ]] || return 1
        mv -T -- "$OFFSITE_MODULE" "$rollback_root/rejected-module13" || return 1
      fi
      mv -T -- "$rollback_root/module12" "$OFFSITE_MODULE" || return 1
    fi
    install_atomic_root_file "$rollback_root/installed-contract12.json" "$OFFSITE_RECEIPT" 0600 || return 1
    module_phase=0
  fi
  if (( bootstrap_changed == 1 )); then
    install_atomic_root_file "$rollback_root/bootstrap-admin" "$BOOTSTRAP_COMMAND" 0750 || return 1
    bootstrap_changed=0
  fi
  cmp --silent -- "$rollback_root/installed-contract12.json" "$OFFSITE_RECEIPT" || return 1
  root_node "$app_dir/server-tools/linux/offsite/lib/offsite-contract.js" verify-installed-bound "$OFFSITE_MODULE" "$OFFSITE_RECEIPT" >/dev/null || return 1
  [[ "$(gp_sha256 "$ENV_FILE")" == "$env_sha256_before" ]] || return 1
  systemctl is-active --quiet grabenplaner.service || return 1
  gp_wait_ready "$internal_ready_url" "$health_timeout" && gp_wait_ready "$public_ready_url" "$health_timeout" || return 1
  "$app_dir/server-tools/linux/test-grabenplaner-server.sh" --node "$node" --deploy-mode \
    --env-file "$ENV_FILE" --app-dir "$app_dir" --data-dir "$DATA_DIR" --database "$DATA_DIR/data/postgresql-pair.json" \
    --backup-dir "$BACKUP_DIR" --public-url "$public_url" >/dev/null
}
cleanup() {
  local code=$?
  trap - EXIT
  if (( interrupted == 1 )); then
    printf '%s\n' 'Unterbrochene Core-/Modulmigration. Keine Timerfreigabe, keine vermutete Rueckkehr; erhaltene Dateien und App-Commit manuell pruefen.' >"$work_root/INTERRUPTED-ACTION-REQUIRED"
    gp_warn "Diagnose und Rueckkehrpunkte bleiben erhalten: $work_root"
    exit "$code"
  fi
  if (( code != 0 )); then
    if commit_is_valid; then
      printf '%s\n' 'Die App ist bereits committed; kein Teilrollback von App, Daten oder Offsite-Modul.' >"$work_root/POST-UPDATE-ACTION-REQUIRED"
      rollback_failed=1
    elif (( module_phase != 0 || bootstrap_changed == 1 )); then
      if ! restore_predecessor_module; then
        printf '%s\n' 'Die genaue Rueckkehr zu Core5/Offsite12 konnte nicht bestaetigt werden. Alle Rueckkehrpunkte und pausierten Timer bleiben erhalten.' >"$work_root/ROLLBACK-ACTION-REQUIRED"
        rollback_failed=1
      fi
    fi
  fi
  if (( timers_paused == 1 && rollback_failed == 0 )); then
    if ! restore_timer_states; then
      printf '%s\n' 'Die vorherigen Timerzustaende konnten nicht vollstaendig wiederhergestellt und verifiziert werden.' >"$work_root/TIMER-ACTION-REQUIRED"
      code=2
    fi
  fi
  if (( code == 0 && transition_complete == 1 )); then
    [[ -d "$work_root" && ! -L "$work_root" && "$work_root" == "$app_parent/".runtime-v6-migration.* ]] \
      && rm -rf --one-file-system -- "$work_root"
  else gp_warn "Migrationsnachweise bleiben erhalten: $work_root"; fi
  (( rollback_failed == 0 )) || code=2
  exit "$code"
}
trap cleanup EXIT
trap 'interrupted=1; exit 143' TERM
trap 'interrupted=1; exit 130' INT

install -m 0600 -o root -g root -- "$package" "$staged_package"
[[ "$(gp_sha256 "$staged_package")" == "$sha256_arg" ]] || gp_die 'Das Paket entspricht nicht dem freigegebenen SHA256.'
zip_summary="$(unzip -Z -t "$staged_package")" || gp_die "Das ZIP-Zentralverzeichnis ist unlesbar."
entry_count="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ {print $1; exit}')"
expanded_bytes="$(printf '%s\n' "$zip_summary" | awk '/files?, .* bytes uncompressed/ {print $3; exit}')"
[[ "$entry_count" =~ ^[0-9]+$ && "$expanded_bytes" =~ ^[0-9]+$ ]] \
  || gp_die "Die ZIP-Groessenangaben sind ungueltig."
(( entry_count > 0 && entry_count <= 100000 && expanded_bytes <= MAX_EXPANDED_BYTES )) \
  || gp_die "Das Migrationspaket ist leer oder zu gross."
zip_listing="$(unzip -Z -l "$staged_package")" || gp_die "Die ZIP-Dateitypen sind unlesbar."
parsed_modes=0
while IFS= read -r mode; do
  ((parsed_modes += 1))
  case "${mode:0:1}" in -|d) ;; *) gp_die "Links und Spezialdateien sind im Migrationspaket nicht erlaubt." ;; esac
done < <(printf '%s\n' "$zip_listing" | awk '$1 ~ /^[-dlbcps]/ && $2 ~ /^[0-9]/ {print $1}')
(( parsed_modes == entry_count )) || gp_die "Nicht alle ZIP-Dateitypen konnten sicher bestimmt werden."
unzip -tq "$staged_package" >/dev/null || gp_die "Das Server-ZIP ist beschaedigt."
declare -A archive_entries=()
while IFS= read -r entry; do
  normalized="${entry#./}"
  normalized="${normalized%/}"
  [[ -n "$normalized" ]] || continue
  [[ ! "$entry" =~ [[:cntrl:]] && "$normalized" != /* && "$normalized" != *\\* \
    && -z "${archive_entries[$normalized]+x}" ]] || gp_die "Ungueltiger oder doppelter ZIP-Pfad."
  archive_entries["$normalized"]=1
  IFS=/ read -ra segments <<<"$normalized"
  for segment in "${segments[@]}"; do
    [[ -n "$segment" && "$segment" != . && "$segment" != .. ]] || gp_die "Nicht kanonischer ZIP-Pfad."
  done
done < <(unzip -Z1 "$staged_package")

build_user="$GP_DEFAULT_BUILD_USER"
build_group="$GP_DEFAULT_BUILD_GROUP"
getent passwd "$build_user" >/dev/null || gp_die "Der isolierte Build-Benutzer fehlt."
getent group "$build_group" >/dev/null || gp_die "Die isolierte Build-Gruppe fehlt."
chown "root:$build_group" -- "$staged_package"
chmod 0640 -- "$staged_package"
chown "$build_user:$build_group" -- "$extract_root"
runuser --user "$build_user" -- unzip -qq "$staged_package" -d "$extract_root"
[[ -z "$(find "$extract_root" ! -type f ! -type d -print -quit)" ]] \
  || gp_die "Das entpackte Paket enthaelt unzulaessige Dateitypen."
(( $(du --bytes --summarize "$extract_root" | awk '{print $1}') <= MAX_EXPANDED_BYTES )) \
  || gp_die "Das entpackte Paket ist zu gross."

gp_seal_build_tree "$extract_root" "$work_root/extract" "$GP_DEFAULT_SERVICE_GROUP" || gp_die 'Der ausgepackte Buildbaum konnte nicht mit frischen root-eigenen Dateien versiegelt werden.'
extract_root="$work_root/extract"
gp_verify_sealed_zip "$staged_package" "$extract_root" 0 || gp_die 'Der versiegelte Quellbaum ist nicht bytegleich an das originale SHA-gepruefte ZIP gebunden.'

candidate_verifier="$extract_root/server-tools/linux/lib/verify-package.js"
transition_helper="$extract_root/server-tools/linux/lib/runtime-v6-transition.js"
module_helper="$extract_root/server-tools/linux/lib/offsite-postgresql-only-compat.js"
manifest_result="$work_root/manifest.json"
root_node "$candidate_verifier" "$extract_root" >"$manifest_result" || gp_die 'Paketmanifest und Einzeldateien sind ungueltig.'
cmp --silent -- "$SCRIPT_PATH" "$extract_root/server-tools/linux/migrate-grabenplaner-runtime-v6.sh" || gp_die 'Der gestartete EntryPoint ist nicht bytegleich paketgebunden.'
cmp --silent -- "$SCRIPT_DIR/lib/common.sh" "$extract_root/server-tools/linux/lib/common.sh" || gp_die 'Die geladene Sicherheitsbasis ist nicht bytegleich paketgebunden.'
root_node "$transition_helper" verify "$app_dir" "$extract_root" >"$work_root/core-delta.json" || gp_die 'Nur der exakt gepruefte Core-5-zu-6-Uebergang ist erlaubt.'
candidate_version="$(root_node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).appVersion)' "$manifest_result")"
old_version="$(root_node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$app_dir/package.json")"
version_comparison="$(gp_compare_semver root_node "$old_version" "$candidate_version")"
(( version_comparison <= 0 )) || gp_die 'Die Runtime-Migration erlaubt keine aeltere App-Version.'
clamscan --recursive --infected --no-summary -- "$extract_root" >/dev/null || gp_die 'ClamAV hat das vollstaendige Paket abgelehnt.'
gp_apply_app_permissions "$extract_root" "$GP_DEFAULT_SERVICE_GROUP"
root_node "$transition_helper" dependencies "$app_dir" "$extract_root" >"$work_root/dependency-continuity.json" \
  || gp_die 'Die alte privilegierte Abhaengigkeitskette ist nicht vollstaendig root-geschuetzt und unveraendert gebunden.'
cp -R --no-preserve=ownership --no-dereference -- "$app_dir/node_modules" "$extract_root/node_modules" \
  || gp_die 'Die qualifizierte Alt-Closure konnte nicht in frische lokale Kandidatdateien uebernommen werden.'
gp_apply_app_permissions "$extract_root" "$GP_DEFAULT_SERVICE_GROUP"
root_node "$transition_helper" dependencies "$app_dir" "$extract_root" >"$work_root/dependency-continuity-local.json" \
  || gp_die 'Die lokale Root-Closure weicht von der qualifizierten Alt-Closure ab.'
gp_verify_sealed_zip "$staged_package" "$extract_root" 1 || gp_die 'Die lokal ergaenzten Abhaengigkeiten haben Originalpaketbytes veraendert.'
root_node "$extract_root/server-tools/linux/postgresql/preflight-install.js" check >"$work_root/postgresql-preflight.json" \
  || gp_die 'Der geschuetzte PostgreSQL-Paar-, Rollen- und Clusterbezug wurde nicht read-only bestaetigt.'

render_bootstrap() {
  local source="$1" target="$2" content
  content="$(<"$source")"
  content="${content//\{\{NODE_EXECUTABLE\}\}/$node}"
  content="${content//\{\{PORT\}\}/$port}"
  content="${content//\{\{PUBLIC_URL\}\}/$public_url}"
  printf '%s\n' "$content" >"$target"
  ! grep -Eq '\{\{[A-Z0-9_]+\}\}' "$target" || gp_die 'Nicht ersetzter Bootstrap-Platzhalter.'
}
assert_provider_binding() (
  # Resolve the actual encrypted rclone/provider and repository binding through
  # the installed module's existing read-only verifier. Temporary credentials
  # remain private and are removed even if the check fails.
  source "$OFFSITE_MODULE/lib/offsite-common.sh" || return 1
  local_credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")" || return 1
  trap 'offsite_remove_uploader_credentials "$local_credentials" >/dev/null 2>&1 || true' EXIT
  offsite_acquire_repository_lock || return 1
  offsite_assert_bound_rclone_provider "$local_credentials" >/dev/null || return 1
  offsite_verify_repository_identity "$local_credentials" "$work_root/repository-verified.json" >/dev/null || return 1
)
[[ -f "$BOOTSTRAP_COMMAND" && ! -L "$BOOTSTRAP_COMMAND" \
  && "$(stat --format='%u:%g:%a:%h' -- "$BOOTSTRAP_COMMAND")" == '0:0:750:1' ]] || gp_die 'Der installierte Bootstrap-Befehl ist nicht sicher gebunden.'
render_bootstrap "$app_dir/server-tools/linux/grabenplaner-bootstrap-admin.sh.in" "$work_root/bootstrap-old"
render_bootstrap "$extract_root/server-tools/linux/grabenplaner-bootstrap-admin.sh.in" "$work_root/bootstrap-new"
cmp --silent -- "$BOOTSTRAP_COMMAND" "$work_root/bootstrap-old" || gp_die 'Der installierte Bootstrap-Befehl weicht vom freigegebenen Core5 ab.'

gp_acquire_maintenance_lock
[[ "$(gp_sha256 "$ENV_FILE")" == "$env_sha256_before" ]] || gp_die 'Die Konfiguration wurde waehrend des Vorabchecks veraendert.'
gp_url_reports_ready "$internal_ready_url" 8 && gp_url_reports_ready "$public_ready_url" 15 || gp_die 'Die alte App ist unter der Wartungssperre nicht bereit.'
root_node "$transition_helper" verify "$app_dir" "$extract_root" >/dev/null || gp_die 'Der alte/neue Core-Vertrag hat sich veraendert.'
root_node "$module_helper" verify "$OFFSITE_MODULE" "$extract_root/server-tools/linux/offsite" "$OFFSITE_RECEIPT" >"$work_root/offsite-delta.json" \
  || gp_die 'Die exakte und providergebundene Offsite12-zu-13-Kontinuitaet ist nicht bestaetigt.'
assert_provider_binding || gp_die 'Die bestehende externe Repository-/Providerbindung ist ungueltig.'
[[ "$(stat --format='%d' "$work_root")" == "$(stat --format='%d' "$(dirname -- "$OFFSITE_MODULE")")" ]] \
  || gp_die 'Der atomare Modultausch verlangt dasselbe Dateisystem.'
install -m 0600 -o root -g root -- "$OFFSITE_RECEIPT" "$rollback_root/installed-contract12.json"
install -m 0750 -o root -g root -- "$BOOTSTRAP_COMMAND" "$rollback_root/bootstrap-admin"
root_node "$extract_root/server-tools/linux/offsite/lib/offsite-contract.js" contract "$extract_root/server-tools/linux/offsite" >"$work_root/offsite13.json"
root_node "$module_helper" bind "$OFFSITE_RECEIPT" "$work_root/offsite13.json" "$rollback_root/offsite13-bound.json" \
  || gp_die 'Die unveraenderte Providerbindung konnte nicht fuer Modul13 vorbereitet werden.'
cp --archive -- "$extract_root/server-tools/linux/offsite" "$work_root/module13"
chown -R root:root -- "$work_root/module13"
find "$work_root/module13" -type d -exec chmod 0755 -- {} +
find "$work_root/module13" -type f -name '*.sh' -exec chmod 0755 -- {} +
find "$work_root/module13" -type f ! -name '*.sh' -exec chmod 0644 -- {} +
root_node "$work_root/module13/lib/offsite-contract.js" verify-installed-bound "$work_root/module13" "$rollback_root/offsite13-bound.json" >/dev/null \
  || gp_die 'Das vorbereitete externe Modul13 ist nicht vollstaendig verifiziert.'
for index in "${!offsite_timer_names[@]}"; do
  timer_state="$(systemctl show "${offsite_timer_names[index]}" --property=ActiveState --value)" || gp_die 'Ein Timerzustand konnte vor der Pause nicht ermittelt werden.'
  case "$timer_state" in
    active) offsite_timer_was_active[index]=1 ;;
    inactive) offsite_timer_was_active[index]=0 ;;
    *) gp_die "Ein Timer befindet sich nicht in einem stabilen aktiven/inaktiven Ausgangszustand: ${offsite_timer_names[index]}" ;;
  esac
done
timers_paused=1
for index in "${!offsite_timer_names[@]}"; do
  systemctl stop "${offsite_timer_names[index]}"
  [[ "$(systemctl show "${offsite_timer_names[index]}" --property=ActiveState --value)" == inactive ]] \
    || gp_die "Der Timer wurde nicht vollstaendig pausiert: ${offsite_timer_names[index]}"
done
for unit in grabenplaner-offsite-prepare.service grabenplaner-offsite-upload.service grabenplaner-offsite-restore-test.service grabenplaner-offsite-application-smoke.service; do
  systemctl is-active --quiet "$unit" && gp_die "Ein alter Sicherungsvorgang muss zuerst enden: $unit"
done
for unit in 'grabenplaner-offsite-assurance@*.service' 'grabenplaner-offsite-assurance-control@*.service' 'grabenplaner-offsite-target-control@*.service'; do
  [[ -z "$(systemctl list-units --state=running --no-legend --plain "$unit")" ]] || gp_die "Ein alter Steuerungs-/Assurancevorgang muss zuerst enden: $unit"
done

# From here to app commit: controlled maintenance gap, never a supported 5/13
# installation. Both unchanged old module12 and its exact receipt are retained.
module_phase=1
mv -T -- "$OFFSITE_MODULE" "$rollback_root/module12"
mv -T -- "$work_root/module13" "$OFFSITE_MODULE"
module_phase=2
install_atomic_root_file "$rollback_root/offsite13-bound.json" "$OFFSITE_RECEIPT" 0600
root_node "$OFFSITE_MODULE/lib/offsite-contract.js" verify-installed-bound "$OFFSITE_MODULE" "$OFFSITE_RECEIPT" >/dev/null || gp_die 'Das externe Modul13 wurde nicht exakt uebernommen.'
bootstrap_changed=1
install_atomic_root_file "$work_root/bootstrap-new" "$BOOTSTRAP_COMMAND" 0750
root_node "$transition_helper" create "$app_dir" "$extract_root" "$sha256_arg" "$transition_file" || gp_die 'Die Paket-/Konfigurations-/Modulbindung konnte nicht erstellt werden.'
update_args=(--package "$staged_package" --sha256 "$sha256_arg" --env-file "$ENV_FILE"
  --app-dir "$app_dir" --data-dir "$DATA_DIR" --database "$DATA_DIR/data/postgresql-pair.json"
  --backup-dir "$BACKUP_DIR" --public-url "$public_url" --node "$node" --backup-keep 1000
  --health-timeout "$health_timeout" --verification full --lock-already-held
  --commit-marker "$updater_commit_marker" --runtime-v6-transition "$transition_file")
[[ -z "$pnpm_arg" ]] || update_args+=(--pnpm "$pnpm_arg")
(( version_comparison != 0 )) || update_args+=(--allow-downgrade-or-reinstall)
if bash "$extract_root/server-tools/linux/update-grabenplaner-server.sh" "${update_args[@]}" >"$work_root/updater-result.json"; then updater_status=0; else updater_status=$?; fi
commit_is_valid || gp_die "Der normale App-Updater hat keinen dauerhaften Commit bestaetigt (Exit $updater_status)."
(( updater_status == 0 )) || gp_die 'Die App ist committed, aber eine nachgelagerte Abschlusspruefung ist fehlgeschlagen.'
[[ "$(gp_sha256 "$ENV_FILE")" == "$env_sha256_before" ]] || gp_die 'Die geschuetzte Serverumgebung wurde veraendert.'
root_node "$app_dir/server-tools/linux/lib/verify-package.js" --runtime-contract "$app_dir" >"$work_root/installed-core6.json"
root_node - "$work_root/installed-core6.json" <<'NODE'
const fs=require('node:fs'),v=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(v.deploymentSchemaVersion!==6||v.fingerprint!=='f9c09a999f5d6b30c0df35e714d0a5ddf0ca17880ad9190ff4bc5c068c3d95fc'||v.offsiteModule.moduleVersion!==13)process.exit(1);
NODE
cmp --silent -- "$BOOTSTRAP_COMMAND" "$work_root/bootstrap-new" || gp_die 'Das ausgelieferte Bootstrap-CLI ist nicht an Core6 gebunden.'
root_node "$OFFSITE_MODULE/lib/offsite-contract.js" verify-installed-bound "$OFFSITE_MODULE" "$OFFSITE_RECEIPT" >/dev/null
assert_provider_binding || gp_die 'Die externe Repository-/Providerbindung ist nach der Migration nicht bestaetigt.'
gp_wait_ready "$internal_ready_url" "$health_timeout" && gp_wait_ready "$public_ready_url" "$health_timeout" || gp_die 'Core6/Offsite13 ist nach dem Update nicht bereit.'
restore_timer_states || gp_die 'Die urspruenglichen Timerzustaende sind nach dem App-Commit nicht vollstaendig bestaetigt; kein Erfolgseintrag.'
systemctl start --no-block grabenplaner-offsite-assurance@app-updated.service || gp_die 'Der neue Assurance-Lauf konnte nach dem App-Commit nicht eingeplant werden.'
history_dir="$DATA_DIR/maintenance/history"
install -d -m 0750 -o root -g "$GP_DEFAULT_SERVICE_GROUP" -- "$history_dir"
receipt="$history_dir/runtime-v6-$(date --utc '+%Y-%m-%dT%H-%M-%S-%3N').json"
root_node - "$receipt" "$old_version" "$candidate_version" "$sha256_arg" "$env_sha256_before" "$updater_commit_marker" <<'NODE'
const fs=require('node:fs');const [file,fromVersion,toVersion,packageSha256,environmentSha256,commitFile]=process.argv.slice(2);
const commit=JSON.parse(fs.readFileSync(commitFile,'utf8'));
fs.writeFileSync(file,JSON.stringify({format:'grabenplaner-runtime-migration',schemaVersion:1,status:'success',completedAt:new Date().toISOString(),deploymentSchema:{from:5,to:6},offsiteModule:{from:12,to:13,providerPreserved:true},providerId:'postgresql',fromVersion,toVersion,packageSha256,environmentSha256,unitsChanged:false,bootstrapCommandUpdated:true,rebootTriggered:false,updateCommittedAt:commit.committedAt})+'\n',{flag:'wx',mode:0o640});
NODE
chown "root:$GP_DEFAULT_SERVICE_GROUP" -- "$receipt"
transition_complete=1
printf '{"ok":true,"fromSchema":5,"toSchema":6,"providerId":"postgresql","offsiteModule":13,"receipt":"%s"}\n' "$receipt"



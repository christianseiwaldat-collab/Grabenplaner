#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly PATH
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH COREPACK_INTEGRITY_KEYS LD_PRELOAD LD_LIBRARY_PATH OPENSSL_CONF OPENSSL_MODULES
umask 077

# This is a separate operation on the same compatible installed application.
# Normal package updates never activate the Passkey schema.
[[ "$#" == 1 && "$1" =~ ^[a-f0-9]{64}$ ]] \
  || { printf '%s\n' 'Verwendung: sudo activate-grabenplaner-passkeys.sh INSTALLIERTES_MANIFEST_SHA256' >&2; exit 1; }
readonly expected_manifest="$1"
readonly app='/opt/grabenplaner/app'
readonly tools="$app/server-tools/linux"
readonly script="$tools/activate-grabenplaner-passkeys.sh"
[[ "$(readlink -f -- "${BASH_SOURCE[0]}")" == "$script" ]] \
  || { printf '%s\n' 'Die Schemaaktivierung gehoert ausschliesslich zur installierten App.' >&2; exit 1; }

# Establish ownership and pinned source bytes before sourcing or executing any
# application helper. Dependencies must also be root-owned and not writable.
/usr/bin/python3 -I - "$app" "$expected_manifest" <<'PY'
import hashlib, json, os, stat, sys
from pathlib import Path
root, expected = Path(sys.argv[1]), sys.argv[2]
assert os.geteuid() == 0 and root.resolve() == root
for item in (root, *root.parents):
    info = item.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
manifest_file = root / 'grabenplaner-server-manifest.json'
raw = manifest_file.read_bytes()
assert hashlib.sha256(raw).hexdigest() == expected
manifest = json.loads(raw)
assert manifest['format'] == 'grabenplaner-server-package' and manifest['schemaVersion'] == 1
assert isinstance(manifest['files'], list) and 0 < len(manifest['files']) <= 10000
seen = set()
for entry in manifest['files']:
    name = entry['path']
    assert isinstance(name, str) and name and '\\' not in name and not name.startswith('/')
    assert all(part not in ('', '.', '..') for part in name.split('/')) and name not in seen
    seen.add(name)
    target = root / name
    assert target.resolve() == target
    info = target.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == entry['bytes']
    assert hashlib.sha256(target.read_bytes()).hexdigest() == entry['sha256']
assert 'server-tools/linux/activate-grabenplaner-passkeys.sh' in seen
assert 'server-tools/linux/lib/common.sh' in seen
for directory, folders, files in os.walk(root, followlinks=False):
    for name in (*folders, *files):
        item = Path(directory) / name
        info = item.lstat()
        assert item.resolve() == item and info.st_uid == 0 and not info.st_mode & 0o022
        assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1
assert (root / 'node_modules').is_dir()
PY
# shellcheck source=server-tools/linux/lib/common.sh
source "$tools/lib/common.sh"
gp_require_root
node="$(gp_assert_root_node /usr/bin/node)"
readonly node
root_node() {
  /usr/bin/env -i PATH="$(dirname -- "$node"):/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME=/root LANG=C.UTF-8 NODE_ENV=production "$node" --no-global-search-paths "$@"
}
gp_load_env_file "$GP_DEFAULT_ENV_FILE"
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH COREPACK_INTEGRITY_KEYS LD_PRELOAD LD_LIBRARY_PATH OPENSSL_CONF OPENSSL_MODULES
[[ "${DB_PROVIDER:-}" == postgresql ]] || gp_die 'Die Aktivierung benoetigt das konfigurierte PostgreSQL-Paar.'
[[ "${GRABENPLANER_DATA_DIR:-$GP_DEFAULT_DATA_DIR}" == "$GP_DEFAULT_DATA_DIR" ]] \
  || gp_die 'Die Schemaaktivierung benoetigt den festen produktiven Datenpfad.'
port="${PORT:-3000}"
[[ "$port" =~ ^[0-9]+$ ]] && (( port>=1 && port<=65535 )) || gp_die 'Ungueltiger App-Port.'
public_url="${GRABENPLANER_PUBLIC_URL:-}"
gp_validate_https_url root_node "$public_url" || gp_die 'Der HTTPS-Ursprung ist ungueltig.'
readonly internal_live_url="http://127.0.0.1:$port/api/health/live"
readonly internal_ready_url="http://127.0.0.1:$port/api/health/ready"
readonly public_live_url="${public_url%/}/api/health/live"
readonly public_ready_url="${public_url%/}/api/health/ready"

# Do not turn a failed Restore/Assurance status into an activation permission.
"$tools/preflight-grabenplaner-deploy.sh" --node "$node" >/dev/null
gp_acquire_maintenance_lock
declare -a timers=(apt-daily.timer apt-daily-upgrade.timer grabenplaner-monitor.timer
  grabenplaner-offsite-assurance.timer grabenplaner-offsite-upload.timer
  grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer
  grabenplaner-host-security-audit.timer)
declare -a maintenance=(apt-daily.service apt-daily-upgrade.service grabenplaner-monitor.service
  grabenplaner-offsite-assurance@scheduled-nightly.service grabenplaner-offsite-assurance@manual-admin-ui.service
  grabenplaner-offsite-assurance@app-updated.service grabenplaner-offsite-assurance@offsite-config-changed.service
  grabenplaner-offsite-assurance@offsite-module-changed.service grabenplaner-offsite-application-smoke.service
  grabenplaner-offsite-prepare.service grabenplaner-offsite-upload.service grabenplaner-offsite-check.service
  grabenplaner-offsite-restore-test.service grabenplaner-host-security-audit.service
  grabenplaner-host-security-rollback.service grabenplaner-host-reboot.service
  grabenplaner-postgresql-maintenance-recover.service)
declare -a resume_timers=()
stopped=0
completed=0
start_attempted=0
activation_verified=0
evidence=''
config_sha=''
readonly helper="$tools/lib/passkeys-schema-activate.js"

verify_same_application() {
  local proof="$1" mode="${2:-recovery}"
  root_node "$helper" inspect "$expected_manifest" --maintenance-lock-held >"$proof" || return 1
  root_node - "$proof" "$expected_manifest" "$config_sha" "$mode" "$evidence" <<'NODE'
const fs=require('node:fs'),[file,manifest,configuration,mode,root]=process.argv.slice(2);
const b=JSON.parse(fs.readFileSync(file,'utf8'));
if(b.manifestSha256!==manifest||b.configurationSha256!==configuration||b.passkeysSchemaPolicy!=='compatible'
  ||!['absent','present'].includes(b.passkeysState))process.exit(1);
if(mode==='activated'){
 const r=JSON.parse(fs.readFileSync(root+'/activation.json','utf8')),i=JSON.parse(fs.readFileSync(root+'/intent.json','utf8'));
 if(b.passkeysState!=='present'||b.beforePairIdentitySha256!==r.afterPairIdentitySha256
   ||b.coreSchemaSha256!==r.coreAfter||b.salesSchemaSha256!==i.salesSchemaSha256)process.exit(1);
}
NODE
}
start_same_application() {
  verify_same_application "$evidence/restart-binding.json" "${1:-recovery}" || return 1
  start_attempted=1
  gp_start_service "$GP_DEFAULT_SERVICE" || return 1
  gp_wait_ready "$internal_ready_url" 1500 && gp_wait_ready "$public_ready_url" 1500 \
    && gp_url_reports_ready "$internal_live_url" 8 && gp_url_reports_ready "$public_live_url" 15
}
cleanup() {
  local status="$?" timer failed=0 recovered=0
  trap - EXIT
  set +e
  if (( stopped == 1 && completed == 0 )); then
    # Both exact pre/post schemas are understood by A. Never downgrade schema,
    # replace credentials or claim the activation passed after a failed step.
    if (( start_attempted == 0 )); then
      if (( activation_verified == 1 )); then start_same_application activated && recovered=1;
      else start_same_application && recovered=1; fi
    fi
    status=1
  fi
  for timer in "${resume_timers[@]}"; do systemctl start "$timer" >/dev/null 2>&1 || failed=1; done
  (( failed == 0 )) || status=1
  if [[ -n "$evidence" ]]; then
    printf '{"format":"grabenplaner-passkeys-activation-end","schemaVersion":1,"completed":%s,"recoveredAfterFailure":%s,"timersRestored":%s,"exitCode":%s}\n' \
      "$([[ "$completed" == 1 && "$failed" == 0 && "$status" == 0 ]] && echo true || echo false)" "$([[ "$recovered" == 1 ]] && echo true || echo false)" \
      "$([[ "$failed" == 0 ]] && echo true || echo false)" "$status" >"$evidence/end.json"
    printf '%s\n' "Aktivierungsnachweise: $evidence" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
gp_systemd_unit_exists grabenplaner-host-security-rollback.timer \
  && { systemctl is-active --quiet grabenplaner-host-security-rollback.timer \
    && gp_die 'Ein Sicherheits-Rollback ist vorgemerkt.'; }
for timer in "${timers[@]}"; do
  if gp_systemd_unit_exists "$timer" && systemctl is-active --quiet "$timer"; then
    resume_timers+=("$timer")
    systemctl stop "$timer"
    if systemctl is-active --quiet "$timer"; then gp_die 'Ein Wartungstimer konnte nicht pausiert werden.'; fi
  fi
done
for unit in "${maintenance[@]}"; do
  gp_systemd_unit_exists "$unit" || continue
  state="$(systemctl show --property=ActiveState --value "$unit")"
  [[ "$state" == inactive || "$state" == failed ]] || gp_die 'Eine andere Wartung ist aktiv; keine Schemaaktivierung.'
done
[[ ! -L /var/lib/grabenplaner-passkeys-activation ]] || gp_die 'Der Nachweisordner ist ungueltig.'
install -d -m 0700 -o root -g root /var/lib/grabenplaner-passkeys-activation
[[ "$(stat --format='%u:%g:%a' /var/lib/grabenplaner-passkeys-activation)" == 0:0:700 ]] \
  || gp_die 'Der Nachweisordner ist nicht privat.'
evidence="$(mktemp -d /var/lib/grabenplaner-passkeys-activation/run.XXXXXXXX)"
root_node "$helper" guard "$expected_manifest" --maintenance-lock-held >"$evidence/source-configuration-binding.json"
config_sha="$(root_node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).configurationSha256' "$evidence/source-configuration-binding.json")"
stopped=1
gp_stop_service "$GP_DEFAULT_SERVICE"
verify_same_application "$evidence/pre-backup-binding.json"
# The same lease covers the snapshot and transaction. This path never prunes
# needed historical backups and never writes into restorePair.workRoot.
"$tools/backup-grabenplaner.sh" --node "$node" --lock-already-held \
  --preserve-existing-backups --keep 1000 >"$evidence/backup.json"
root_node "$helper" binding "$expected_manifest" --maintenance-lock-held >"$evidence/intent.json"
root_node - "$evidence/intent.json" "$expected_manifest" "$config_sha" <<'NODE'
const fs=require('node:fs'),[file,manifest,config]=process.argv.slice(2),b=JSON.parse(fs.readFileSync(file,'utf8'));
if(b.manifestSha256!==manifest||b.configurationSha256!==config||b.passkeysSchemaPolicy!=='compatible')process.exit(1);
NODE
backup_sha="$(root_node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).backupManifestSha256' "$evidence/intent.json")"
before_sha="$(root_node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).beforePairIdentitySha256' "$evidence/intent.json")"
root_node "$helper" activate "$expected_manifest" "$config_sha" "$backup_sha" "$before_sha" \
  --maintenance-lock-held >"$evidence/activation.json"
root_node - "$evidence/activation.json" "$expected_manifest" "$config_sha" "$backup_sha" <<'NODE'
const fs=require('node:fs'),[file,manifest,config,backup]=process.argv.slice(2),r=JSON.parse(fs.readFileSync(file,'utf8'));
if(r.verified!==true||r.passkeysVerified!==true||r.salesUnchanged!==true||r.sameInstalledApplication!==true
  ||r.manifestSha256!==manifest||r.configurationSha256!==config||r.backupManifestSha256!==backup)process.exit(1);
NODE
activation_verified=1
start_same_application activated || gp_die 'Die unveraenderte kompatible App hat die Abschlusspruefung nicht bestanden.'
completed=1
gp_info 'Passkey-Schema aktiviert; unveraenderte kompatible App intern und ueber HTTPS geprueft.'

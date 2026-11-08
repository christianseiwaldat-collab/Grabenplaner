#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly PATH
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_ICU_DATA NODE_V8_COVERAGE NODE_REDIRECT_WARNINGS NODE_TLS_REJECT_UNAUTHORIZED BASH_ENV ENV CDPATH COREPACK_INTEGRITY_KEYS OPENSSL_CONF OPENSSL_MODULES LD_PRELOAD LD_LIBRARY_PATH
# Explicit module13 upload-only refresh. Never called automatically by the generic updater.
SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
for trusted in "$SCRIPT_PATH" "$SCRIPT_DIR/lib/common.sh" "$SCRIPT_DIR/lib/offsite-upload-hardening-compat.js"; do
  [[ -f "$trusted" && ! -L "$trusted" && "$(stat --format='%u:%g:%h' -- "$trusted")" == 0:0:1 ]] || exit 1
  parent="$trusted"
  while :; do
    [[ ! -L "$parent" && "$(stat --format='%u' -- "$parent")" == 0 ]] || exit 1
    mode="$(stat --format='%a' -- "$parent")"
    (( (8#$mode & 022) == 0 )) || exit 1
    [[ "$parent" != / ]] || break
    parent="$(dirname -- "$parent")"
  done
done
# shellcheck source=server-tools/linux/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
readonly APP=/opt/grabenplaner/app MODULE=/opt/grabenplaner-offsite/module RECEIPT=/etc/grabenplaner/offsite/installed-contract.json
readonly MANIFEST="$APP/grabenplaner-server-manifest.json"
package_arg='' candidate_arg='' sha='' node_arg='' pnpm_arg='' recovery='' health_timeout=1500
while (($#)); do
  case "$1" in
    --package) package_arg="${2:?}"; shift 2 ;;
    --candidate-root) candidate_arg="${2:?}"; shift 2 ;;
    --sha256) sha="${2:?}"; shift 2 ;;
    --node) node_arg="${2:?}"; shift 2 ;;
    --pnpm) pnpm_arg="${2:?}"; shift 2 ;;
    --health-timeout) health_timeout="${2:?}"; shift 2 ;;
    --recover) recovery="${2:?}"; shift 2 ;;
    --help|-h)
      printf '%s\n' 'sudo refresh-grabenplaner-offsite-upload.sh --package /root/server.zip --sha256 HEX --candidate-root /root/sealed-package [--node /absolute/node] [--pnpm /absolute/pnpm]'
      printf '%s\n' 'Der Kandidat muss vorher isoliert entpackt und root-eigen versiegelt sein. Keine Lockerung des normalen Update-Gates.'
      printf '%s\n' 'Unterbrochener Lauf: derselbe root-geschuetzte Einstieg --recover /opt/grabenplaner-offsite/.offsite-upload-refresh-UUID'
      exit 0 ;;
    *) gp_die "Unbekannte Option: $1" ;;
  esac
done
gp_require_root
for command_name in bash clamscan cmp flock id readlink sha256sum stat systemctl; do gp_require_command "$command_name"; done
[[ "$health_timeout" =~ ^[0-9]+$ ]] && ((health_timeout >= 30 && health_timeout <= 1500)) || gp_die 'Ungueltiges Health-Timeout.'
if [[ -z "$node_arg" ]]; then gp_require_command node; node_arg="$(readlink -f -- "$(command -v node)")"; fi
node="$(gp_assert_root_node "$node_arg")" || gp_die 'Die Node-Laufzeit ist nicht root-geschuetzt.'
root_node() { /usr/bin/env -i PATH="$PATH" LANG=C.UTF-8 HOME=/root NODE_ENV=production "$node" --no-global-search-paths "$@"; }
helper="$SCRIPT_DIR/lib/offsite-upload-hardening-compat.js"
readonly timers=(grabenplaner-offsite-assurance.timer grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer)
transaction='' timer_fence=0 interrupted=0 complete=0
preflight_args=(--node "$node")
[[ -z "$pnpm_arg" ]] || preflight_args+=(--pnpm "$pnpm_arg")
restore_timers() {
  local state index=0 actual
  local -a states=()
  mapfile -t states < <(root_node - "$transaction/timers.json" <<'NODE'
const fs=require('node:fs'),p=process.argv[2],s=fs.lstatSync(p),v=JSON.parse(fs.readFileSync(p,'utf8'));
if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||s.nlink!==1||(s.mode&0o777)!==0o600||!Array.isArray(v)||v.length!==4||v.some(x=>!['active','inactive'].includes(x)))process.exit(1);
process.stdout.write(v.join('\n')+'\n');
NODE
)
  ((${#states[@]} == 4)) || return 1
  for index in "${!timers[@]}"; do
    state="${states[index]}"
    if [[ "$state" == active ]]; then systemctl start "${timers[index]}"; else systemctl stop "${timers[index]}"; fi
    actual="$(systemctl show "${timers[index]}" --property=ActiveState --value)" || return 1
    [[ "$actual" == "$state" ]] || return 1
  done
  timer_fence=0
}
lock_offsite() {
  local lock owner descriptor
  descriptor=7
  for lock in /run/grabenplaner-offsite/assurance.lock /run/grabenplaner-offsite/repository.lock; do
    [[ -f "$lock" && ! -L "$lock" && "$(readlink -f -- "$lock")" == "$lock" && "$(stat --format='%h' -- "$lock")" == 1 ]] || return 1
    owner="$(stat --format='%u' -- "$lock")"
    if [[ "$descriptor" == 7 ]]; then [[ "$owner" == 0 ]] || return 1; exec 7<>"$lock";
    else [[ "$owner" == "$(id -u grabenplaner-offsite)" ]] || return 1; exec 8<>"$lock"; fi
    flock --nonblock "$descriptor" || return 1
    descriptor=8
  done
}
healthy_installed_app() {
  gp_load_env_file /etc/grabenplaner/grabenplaner.env
  unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_ICU_DATA NODE_V8_COVERAGE NODE_REDIRECT_WARNINGS NODE_TLS_REJECT_UNAUTHORIZED BASH_ENV ENV CDPATH COREPACK_INTEGRITY_KEYS OPENSSL_CONF OPENSSL_MODULES LD_PRELOAD LD_LIBRARY_PATH
  local port="${PORT:-3000}" public_url="${GRABENPLANER_PUBLIC_URL:-}"
  [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || return 1
  gp_validate_https_url root_node "$public_url" || return 1
  root_node "$APP/server-tools/linux/lib/verify-package.js" --runtime-contract "$APP" >/dev/null || return 1
  gp_url_reports_ready "http://127.0.0.1:$port/api/health/ready" 8 && gp_url_reports_ready "${public_url%/}/api/health/ready" 15
}
unlock_offsite() { exec 8>&-; exec 7>&-; }
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$transaction" && "$complete" == 0 ]]; then
    if ((interrupted == 1)); then
      gp_warn "Unterbrechung: Nachweise und Timerpause bleiben erhalten. Exakte Wiederaufnahme: --recover $transaction"
    elif lock_offsite && root_node "$helper" rollback "$transaction" >/dev/null; then
      unlock_offsite
      if ((timer_fence == 1)) && healthy_installed_app; then
        restore_timers || gp_warn 'Timer bleiben pausiert; Wiederaufnahme erforderlich.'
      fi
      gp_warn "Update fehlgeschlagen; exaktes vorheriges Modul wiederhergestellt. Nachweise: $transaction"
    else
      gp_warn "Kein vermuteter Teilrollback: App-/Modulstand genau pruefen. Timerpause und Nachweise bleiben erhalten: $transaction"
      code=2
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'interrupted=1; exit 143' TERM
trap 'interrupted=1; exit 130' INT
if [[ -n "$recovery" ]]; then
  [[ -z "$package_arg" && -z "$candidate_arg" && -z "$sha" ]] || gp_die '--recover erlaubt keine neuen Paketparameter.'
  transaction="$(gp_existing_directory "$recovery" 'Transaktionsnachweis')"
  [[ "$(dirname -- "$transaction")" == /opt/grabenplaner-offsite ]] || gp_die 'Falscher Wiederaufnahmepfad.'
  gp_acquire_maintenance_lock
  root_node "$helper" inspect "$transaction" >/dev/null || gp_die 'Die unterbrochene Transaktion ist nicht eindeutig.'
  timer_fence=1
  lock_offsite || gp_die 'Ein Offsite-Vorgang besitzt noch eine Sperre.'
  if root_node "$helper" rollback "$transaction" >"$transaction/recovery-result.json"; then :
  else root_node "$helper" finish "$transaction" >"$transaction/recovery-result.json" || gp_die 'Unbekannter Appstand; keine automatische Wiederaufnahme.'; fi
  unlock_offsite
  healthy_installed_app || gp_die 'Wiederaufnahme verlangt einen gesunden Server.'
  restore_timers || gp_die 'Die urspruenglichen Timerzustaende wurden nicht wiederhergestellt.'
  complete=1
  gp_info 'Die exakte unterbrochene Transaktion wurde abgeglichen; Nachweise bleiben privat erhalten.'
  exit 0
fi
[[ -n "$package_arg" && -n "$candidate_arg" && -n "$sha" ]] || gp_die 'Paket, SHA256 und versiegelter Kandidat sind erforderlich.'
gp_validate_sha256 "$sha"; sha="${sha,,}"
package="$(gp_existing_file "$package_arg" 'Paket')"
candidate="$(gp_existing_directory "$candidate_arg" 'Versiegelter Kandidat')"
[[ "$(gp_sha256 "$package")" == "$sha" ]] || gp_die 'Das Paket entspricht nicht dem freigegebenen SHA256.'
gp_verify_sealed_zip "$package" "$candidate" 0 || gp_die 'Der root-eigene Kandidat ist nicht exakt bytegleich an das SHA-gepruefte ZIP gebunden.'
for relative in refresh-grabenplaner-offsite-upload.sh lib/common.sh lib/offsite-upload-hardening-compat.js; do
  cmp --silent -- "$SCRIPT_DIR/$relative" "$candidate/server-tools/linux/$relative" || gp_die 'Der Wartungseinstieg ist nicht exakt paketgebunden.'
done
clamscan --recursive --infected --no-summary -- "$candidate" >/dev/null || gp_die 'ClamAV hat den Kandidaten abgelehnt.'
manifest="$(root_node "$candidate/server-tools/linux/lib/verify-package.js" "$candidate")" || gp_die 'Paketmanifest und Einzeldateien sind ungueltig.'
fingerprint="$(root_node -e 'const v=JSON.parse(process.argv[1]);if(v.runtimeContract?.deploymentSchemaVersion!==6||v.offsiteModule?.moduleVersion!==13)process.exit(1);process.stdout.write(v.offsiteModule.fingerprint)' "$manifest")" || gp_die 'Nur Core6/Offsite13 wird unterstuetzt.'
# The installed entrypoint remains the authority for the application update.
root_node "$APP/server-tools/linux/lib/verify-package.js" --runtime-contract "$APP" >/dev/null || gp_die 'Der installierte Core-Vertrag ist nicht gueltig.'
bash "$SCRIPT_DIR/preflight-grabenplaner-deploy.sh" "${preflight_args[@]}" >/dev/null || gp_die 'Der verpflichtende read-only Deploy-Vorabcheck ist nicht gruen.'
gp_acquire_maintenance_lock
prepared="$(root_node "$helper" prepare "$MODULE" "$candidate/server-tools/linux/offsite" "$RECEIPT" "$fingerprint" "$MANIFEST" "$candidate/grabenplaner-server-manifest.json" "$sha")" || gp_die 'Nur der exakt gepruefte Upload-Refresh ist erlaubt.'
transaction="$(root_node -e 'process.stdout.write(JSON.parse(process.argv[1]).transaction)' "$prepared")"
states=()
for timer in "${timers[@]}"; do
  state="$(systemctl show "$timer" --property=ActiveState --value)" || gp_die 'Ein Timerzustand fehlt.'
  [[ "$state" == active || "$state" == inactive ]] || gp_die 'Ein Timer ist nicht stabil.'
  states+=("$state")
done
root_node - "$transaction/timers.json" "${states[@]}" <<'NODE'
const fs=require('node:fs'),[p,...v]=process.argv.slice(2),fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
try{fs.writeFileSync(fd,JSON.stringify(v)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
const d=fs.openSync(require('node:path').dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
NODE
timer_fence=1
for timer in "${timers[@]}"; do systemctl stop "$timer"; done
# Never wait behind a running old Assurance while holding maintenance FD9.
for lock in /run/grabenplaner-offsite/assurance.lock /run/grabenplaner-offsite/repository.lock; do
  [[ -f "$lock" && ! -L "$lock" ]] || gp_die 'Eine Offsite-Sperre fehlt oder ist unsicher.'
  flock --nonblock "$lock" true || gp_die 'Ein Offsite-Vorgang laeuft noch; zuerst geordnet beenden lassen.'
done
lock_offsite || gp_die 'Ein Offsite-Vorgang besitzt noch eine Sperre.'
root_node "$helper" apply "$transaction" >"$transaction/module-result.json"
unlock_offsite
update_args=(--package "$package" --sha256 "$sha" --node "$node" --lock-already-held --verification auto --health-timeout "$health_timeout")
[[ -z "$pnpm_arg" ]] || update_args+=(--pnpm "$pnpm_arg")
if bash "$APP/server-tools/linux/update-grabenplaner-server.sh" "${update_args[@]}" >"$transaction/updater-result.json"; then updater_status=0; else updater_status=$?; fi
# The installed candidate manifest is the durable app identity. Never infer commit from exit status alone.
if root_node "$helper" finish "$transaction" >"$transaction/final-result.json"; then
  complete=1
  ((updater_status == 0)) || gp_die 'Die App ist bereits uebernommen; Abschlusspruefung fehlgeschlagen. Kein Teilrollback, Timer bleiben pausiert.'
else gp_die 'Die exakte App-Uebernahme wurde nicht bestaetigt.'; fi
root_node "$APP/server-tools/linux/lib/verify-package.js" --runtime-contract "$APP" >/dev/null || gp_die 'Der uebernommene Laufzeitvertrag ist ungueltig; Timer bleiben pausiert.'
restore_timers || gp_die 'Die urspruenglichen Timerzustaende fehlen; Nachweise bleiben erhalten.'
gp_info "Upload-Refresh und normaler App-Updater abgeschlossen. Privater Nachweis: $transaction"

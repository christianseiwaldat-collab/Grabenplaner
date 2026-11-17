#!/usr/bin/env bash
# Install only the fixed application capability after the normal app/offsite
# installation has been verified. This does not start a backup or alter timers.
set -Eeuo pipefail
export PATH=/usr/bin:/bin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH
[[ "$EUID" == 0 && $# == 0 ]] || exit 1
readonly APP=/opt/grabenplaner/app
readonly SOURCE="$APP/server-tools/linux/drive-control"
[[ -f /etc/grabenplaner/offsite/installed-contract.json ]] || exit 1
/usr/bin/node - "$APP" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),app=process.argv[2];
for(const name of ['lib/manual-drive-backups.js','server-tools/linux/lib/manual-drive-control.js','server-tools/linux/lib/manual-drive-operation.sh',...['grabenplaner-drive-control.socket','grabenplaner-drive-control@.service','grabenplaner-drive-backup@.service'].map(x=>'server-tools/linux/drive-control/'+x)]){
 const file=path.join(app,name);if(fs.realpathSync(file)!==file)process.exit(1);
 for(let p=file;;p=path.dirname(p)){const s=fs.lstatSync(p);if(s.uid!==0||s.isSymbolicLink()||(s.mode&0o022)||p===file&&(!s.isFile()||s.nlink!==1))process.exit(1);if(p==='/')break;}
}
NODE
getent group grabenplaner-assurance-control >/dev/null
id -nG grabenplaner | tr ' ' '\n' | grep -Fxq grabenplaner-assurance-control
/usr/bin/node /opt/grabenplaner-offsite/module/lib/offsite-contract.js verify-installed-bound /opt/grabenplaner-offsite/module /etc/grabenplaner/offsite/installed-contract.json >/dev/null
provider="$(/usr/bin/node /opt/grabenplaner-offsite/module/lib/offsite-contract.js provider-id /etc/grabenplaner/offsite/installed-contract.json)"
[[ "$provider" == google_drive ]] || exit 0
created=()
complete=0
cleanup() {
  local code=$?
  if (( complete == 0 && ${#created[@]} > 0 )); then
    systemctl disable --now grabenplaner-drive-control.socket >/dev/null 2>&1 || true
    for name in "${created[@]}"; do rm -f -- "/etc/systemd/system/$name"; done
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT
# Inspect every destination before publishing any new unit. Existing differing
# or foreign units are preserved and never replaced by this installer.
for name in grabenplaner-drive-control.socket grabenplaner-drive-control@.service grabenplaner-drive-backup@.service; do
  target="/etc/systemd/system/$name"
  [[ ! -L "$target" ]] || exit 1
  if [[ -e "$target" ]]; then
    [[ -f "$target" && "$(stat -c %u:%g:%h "$target")" == 0:0:1 ]] || exit 1
    # Repair/upgrade only a unit previously installed from this fixed template.
    cmp --silent "$SOURCE/$name" "$target" || exit 1
  fi
done
for name in grabenplaner-drive-control.socket grabenplaner-drive-control@.service grabenplaner-drive-backup@.service; do
  target="/etc/systemd/system/$name"
  if [[ ! -e "$target" ]]; then
    # Do not overwrite a destination appearing after the inspection.
    (set -o noclobber; cat "$SOURCE/$name" >"$target")
    created+=("$name")
    chown root:root "$target"
    chmod 0644 "$target"
  fi
done
systemd-analyze verify /etc/systemd/system/grabenplaner-drive-control.socket /etc/systemd/system/grabenplaner-drive-control@.service /etc/systemd/system/grabenplaner-drive-backup@.service
systemctl daemon-reload
systemctl enable --now grabenplaner-drive-control.socket
systemctl is-active --quiet grabenplaner-drive-control.socket
complete=1

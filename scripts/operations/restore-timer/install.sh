#!/usr/bin/env bash
# Install only the host's restore ExecCondition. The repository check uses a
# separate drop-in and continues to use the original calendar helper.
set -euo pipefail
umask 077
[[ $EUID == 0 ]]
src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
unit=grabenplaner-offsite-restore-test.service
conf=/etc/systemd/system/$unit.d/90-complete-nightly-assurance.conf
base=/usr/local/libexec
version=$(cd "$src" && sha256sum restore-condition.sh restore-proof.cjs | sha256sum | cut -c 1-20)
dest=$base/grabenplaner-restore-timer-$version
[[ $(systemctl show "$unit" -p DropInPaths --value) == "$conf" && -f "$conf" && ! -L "$conf" ]]
[[ $(stat -c %u:%g "$conf") == 0:0 ]]
old=$(sha256sum "$conf" | cut -d' ' -f1)
render() {
  printf '[Unit]\nAfter=grabenplaner-offsite-assurance@scheduled-nightly.service\n[Service]\nExecCondition=/bin/bash %s/restore-condition.sh\n' "$dest"
}
if cmp -s "$conf" <(render); then
  cmp "$src/restore-proof.cjs" "$dest/restore-proof.cjs"
  cmp "$src/restore-condition.sh" "$dest/restore-condition.sh"
  systemctl show "$unit" -p ExecCondition --value | grep -F "$dest/restore-condition.sh"
  exit 0
fi
# Refuse to overwrite an unrelated operator's condition.
[[ $old == 037feeeb8139e2e7e54b812a201c90c961190c08c5cd931a12f018fe15b1bd6e ]]
[[ $(systemctl show "$unit" -p ActiveState --value) == inactive ]]
if [[ ! -e "$dest" ]]; then install -d -m 0755 -- "$dest"; fi
[[ ! -L "$dest" && $(stat -c %u:%g:%a "$dest") == 0:0:755 ]]
for file in restore-condition.sh restore-proof.cjs; do
  if [[ -e "$dest/$file" ]]; then
    [[ ! -L "$dest/$file" && $(stat -c %u:%g:%a "$dest/$file") == 0:0:644 ]]
    cmp "$src/$file" "$dest/$file"
  else
    install -m 0644 "$src/$file" "$dest/$file"
  fi
done
save="$dest/previous-drop-in.conf"
install -m 0600 "$conf" "$save"
next=$(mktemp "${conf}.XXXXXXXX")
trap 'rm -f -- "$next"' EXIT
render >"$next"
chmod 0644 "$next"
[[ $(sha256sum "$conf" | cut -d' ' -f1) == "$old" ]]
mv -T -- "$next" "$conf"
if systemctl daemon-reload && systemctl show "$unit" -p ExecCondition --value | grep -F "$dest/restore-condition.sh"; then
  printf 'Original configuration saved at %s\n' "$save"
else
  install -m 0644 "$save" "$next"
  mv -T -- "$next" "$conf"
  systemctl daemon-reload
  exit 1
fi

#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

confirmed=0
while (($#)); do
  case "$1" in
    --yes) confirmed=1; shift ;;
    -h|--help)
      printf '%s\n' "Verwendung: sudo grabenplaner-offsite-uninstall --yes"
      printf '%s\n' "Deaktiviert das Modul; Repository, lokale Stagingdaten und Geheimdateien bleiben erhalten."
      exit 0
      ;;
    *) offsite_die "Unbekannte Option: $1" ;;
  esac
done
offsite_require_root
(( confirmed == 1 )) || offsite_die "Die Deaktivierung erfordert die ausdrueckliche Option --yes."
for command_name in cmp mktemp readlink rm systemctl; do offsite_require_command "$command_name"; done
offsite_assert_installed_contract
core_common="$OFFSITE_APP_ROOT/server-tools/linux/lib/common.sh"
[[ -f "$core_common" && ! -L "$core_common" ]] || offsite_die "Die verifizierte Core-Wartungssperre fehlt."
# shellcheck source=server-tools/linux/lib/common.sh
source "$core_common"
gp_acquire_maintenance_lock
offsite_acquire_repository_lock

for unit in grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer \
  grabenplaner-offsite-upload.service grabenplaner-offsite-prepare.service grabenplaner-offsite-check.service grabenplaner-offsite-restore-test.service; do
  systemctl disable --now "$unit" >/dev/null 2>&1 || true
done

for template in "$OFFSITE_MODULE_ROOT"/systemd/*.in; do
  unit_name="$(basename -- "$template" .in)"
  unit_file="/etc/systemd/system/$unit_name"
  if [[ -f "$unit_file" && ! -L "$unit_file" ]] && cmp --silent -- "$template" "$unit_file"; then
    rm -f -- "$unit_file"
  elif [[ -e "$unit_file" || -L "$unit_file" ]]; then
    offsite_warn "Veraenderte systemd-Unit bleibt deaktiviert erhalten: $unit_file"
  fi
done
systemctl daemon-reload

for command_name in grabenplaner-offsite-pre-update grabenplaner-offsite-prepare grabenplaner-offsite-test grabenplaner-offsite-uninstall grabenplaner-recovery; do
  command_path="/usr/local/sbin/$command_name"
  expected_recovery="$OFFSITE_APP_ROOT/server-tools/linux/recovery/grabenplaner-recovery.sh"
  if [[ -L "$command_path" && ( "$(readlink -f -- "$command_path")" == "$OFFSITE_MODULE_ROOT/"* \
    || ( "$command_name" == "grabenplaner-recovery" && "$(readlink -f -- "$command_path")" == "$expected_recovery" ) ) ]]; then
    rm -f -- "$command_path"
  elif [[ -e "$command_path" || -L "$command_path" ]]; then
    offsite_warn "Ein fremder oder veraenderter Offsite-Befehl bleibt erhalten: $command_path"
  fi
done

env_temporary="$(mktemp --tmpdir="$(dirname -- "$OFFSITE_APP_ENV")" .grabenplaner.env.XXXXXXXX)"
"$OFFSITE_NODE" - "$OFFSITE_APP_ENV" "$env_temporary" <<'NODE'
const fs = require("node:fs");
const [source, target] = process.argv.slice(2);
const lines = fs.readFileSync(source, "utf8").split(/\r?\n/)
  .filter((line) => !/^GRABENPLANER_OFFSITE_(?:CONFIGURED|STATUS_FILE)=/.test(line));
while (lines.length && !lines.at(-1)) lines.pop();
lines.push("");
fs.writeFileSync(target, lines.join("\n"), { mode: 0o600 });
NODE
chown root:root -- "$env_temporary"
chmod 0600 -- "$env_temporary"
mv -f -- "$env_temporary" "$OFFSITE_APP_ENV"

offsite_status unconfigured >/dev/null
rm -f -- "$OFFSITE_CONFIG_ROOT/installed-contract.json" "$OFFSITE_CONFIG_ROOT/binary-pins.json"
rm -rf --one-file-system -- "$OFFSITE_MODULE_ROOT"
rm -f -- "$OFFSITE_RESTIC" "$OFFSITE_RCLONE" "$OFFSITE_LEGACY_RCLONE_WRAPPER"
if systemctl show --property=LoadState --value "$OFFSITE_APP_SERVICE" 2>/dev/null | grep -qxv not-found; then
  systemctl restart "$OFFSITE_APP_SERVICE"
fi
offsite_info "Das Offsite-Modul wurde deaktiviert. Verschluesselte Repository-Zugangsdaten, Staging und das externe Repository bleiben erhalten."

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
      printf '%s\n' "Deaktiviert das Modul; Repository, lokale Stagingdaten, Pending-Recovery-Sets und Geheimdateien bleiben erhalten."
      exit 0
      ;;
    *) offsite_die "Unbekannte Option: $1" ;;
  esac
done
offsite_require_root
(( confirmed == 1 )) || offsite_die "Die Deaktivierung erfordert die ausdrueckliche Option --yes."
for command_name in awk chmod chown cmp getent gpasswd groupdel id install mktemp paste readlink rm sed sort stat systemctl tr; do offsite_require_command "$command_name"; done
offsite_assert_installed_contract
core_common="$OFFSITE_APP_ROOT/server-tools/linux/lib/common.sh"
[[ -f "$core_common" && ! -L "$core_common" ]] || offsite_die "Die verifizierte Core-Wartungssperre fehlt."
# shellcheck source=server-tools/linux/lib/common.sh
source "$core_common"
gp_acquire_maintenance_lock
offsite_acquire_assurance_lock
offsite_acquire_repository_lock

for unit in 'grabenplaner-offsite-target-control@*.service' grabenplaner-offsite-target-control.socket \
  'grabenplaner-offsite-assurance-control@*.service' grabenplaner-offsite-assurance-control.socket \
  'grabenplaner-offsite-assurance@*.service' \
  grabenplaner-offsite-assurance.timer grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer \
  grabenplaner-offsite-application-smoke.service grabenplaner-offsite-upload.service grabenplaner-offsite-prepare.service grabenplaner-offsite-check.service grabenplaner-offsite-restore-test.service; do
  systemctl disable --now "$unit" >/dev/null 2>&1 || true
done

if [[ -e "$OFFSITE_SMOKE_ROOT" || -L "$OFFSITE_SMOKE_ROOT" ]]; then
  smoke_uid="$(id -u "$OFFSITE_USER")"
  smoke_gid="$(getent group "$OFFSITE_GROUP" | awk -F: '{print $3}')"
  [[ -d "$OFFSITE_SMOKE_ROOT" && ! -L "$OFFSITE_SMOKE_ROOT" \
    && "$(stat --format='%u:%g:%a' -- "$OFFSITE_SMOKE_ROOT")" == "$smoke_uid:$smoke_gid:700" ]] \
    || offsite_die "Der temporaere App-Smoke-Testpfad ist unsicher und wurde nicht entfernt."
  rm -rf --one-file-system -- "$OFFSITE_SMOKE_ROOT"
fi

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

# The control group is part of the v3 privilege boundary, not persistent user
# data. Remove it completely so an uninstalled module leaves no dormant path
# from the application account to a root socket.
offsite_assert_control_group_isolation
gpasswd --delete "$OFFSITE_APP_USER" "$OFFSITE_CONTROL_GROUP" >/dev/null
control_gid="$(getent group "$OFFSITE_CONTROL_GROUP" | awk -F: '{print $3}')"
control_primary="$(getent passwd | awk -F: -v gid="$control_gid" '$4==gid {print $1}' | sort | paste -sd, -)"
control_members="$(getent group "$OFFSITE_CONTROL_GROUP" | awk -F: '{print $4}' | tr ',' '\n' | sed '/^$/d' | sort | paste -sd, -)"
[[ -z "$control_primary" && -z "$control_members" ]] \
  || offsite_die "Die Recovery-Assurance-Steuerungsgruppe konnte nicht sicher geleert werden."
groupdel "$OFFSITE_CONTROL_GROUP"

for command_name in grabenplaner-offsite-assurance grabenplaner-offsite-pre-update grabenplaner-offsite-prepare \
  grabenplaner-offsite-recovery-set grabenplaner-offsite-rebind-rclone \
  grabenplaner-offsite-test grabenplaner-offsite-uninstall grabenplaner-recovery; do
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
  .filter((line) => !/^GRABENPLANER_OFFSITE_(?:CONFIGURED|PROVIDER|STATUS_FILE)=/.test(line));
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
offsite_info "Das Offsite-Modul wurde deaktiviert. Verschluesselte Repository-Zugangsdaten, Staging, Pending-Recovery-Sets und das externe Repository bleiben erhalten."

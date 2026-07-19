#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

offsite_require_root
for command_name in awk flock getent mktemp readlink rm runuser sha256sum stat systemctl; do offsite_require_command "$command_name"; done
failures=0
ok() { printf 'OK\t%s\t%s\n' "$1" "$2"; }
fail() { printf 'FEHLER\t%s\t%s\n' "$1" "$2"; failures=$((failures + 1)); }
offsite_prepare_run_root
credentials=""
operation_root="$(mktemp --directory --tmpdir="$OFFSITE_STATE_ROOT" .self-test.XXXXXXXX)"
chmod 0700 -- "$operation_root"
cleanup() {
  rm -rf --one-file-system -- "$operation_root" 2>/dev/null || true
  [[ -z "$credentials" ]] || offsite_remove_uploader_credentials "$credentials" 2>/dev/null || true
}
trap cleanup EXIT

if (offsite_assert_installed_contract >/dev/null 2>&1); then ok "Modulvertrag" "installierte Dateien unveraendert"; else fail "Modulvertrag" "Integritaetspruefung fehlgeschlagen"; fi
if (offsite_assert_runtime_binaries >/dev/null 2>&1); then
  ok "Binaerintegritaet" "Rechte, Modulwrapper und SHA-256-Pins bestaetigt"
else
  fail "Binaerintegritaet" "Laufzeitvertrag der Binaerdateien fehlgeschlagen"
fi
if runuser --user "$OFFSITE_USER" -- env -i HOME="$OFFSITE_UPLOADER_HOME" PATH=/usr/bin:/bin \
    "$OFFSITE_RESTIC" version >"$operation_root/restic-version.txt" 2>/dev/null \
  && runuser --user "$OFFSITE_USER" -- env -i HOME="$OFFSITE_UPLOADER_HOME" PATH=/usr/bin:/bin \
    "$OFFSITE_RCLONE" version >"$operation_root/rclone-version.txt" 2>/dev/null \
  && "$OFFSITE_NODE" - "$OFFSITE_BINARY_PINS" "$operation_root/restic-version.txt" "$operation_root/rclone-version.txt" <<'NODE' >/dev/null 2>&1
const fs = require("node:fs");
const [pinsFile, resticFile, rcloneFile] = process.argv.slice(2);
const pins = JSON.parse(fs.readFileSync(pinsFile, "utf8"));
const restic = fs.readFileSync(resticFile, "utf8");
const rclone = fs.readFileSync(rcloneFile, "utf8");
if (pins.platform !== "linux/amd64" || !new RegExp(`\\brestic\\s+${pins.resticVersion.replaceAll(".", "\\.")}\\b[\\s\\S]*\\bon\\s+linux/amd64\\b`, "i").test(restic)
  || !new RegExp(`\\brclone\\s+v${pins.rcloneVersion.replaceAll(".", "\\.")}\\b`, "i").test(rclone)
  || !/os\/type:\s*linux\b/i.test(rclone) || !/os\/arch:\s*amd64\b/i.test(rclone)) process.exit(1);
NODE
then
  ok "Binaerversionen" "gepinntes linux/amd64-Restic und rclone lauffaehig"
else
  fail "Binaerversionen" "Version oder Plattform weicht vom Installationsbeleg ab"
fi

if offsite_assert_persistent_rclone_config >/dev/null 2>&1; then ok "rclone OAuth" "verschluesselt und persistent"; else fail "rclone OAuth" "Konfiguration oder Rechte ungueltig"; fi
groups="$(id -Gn "$OFFSITE_USER" 2>/dev/null || true)"
if [[ "$groups" == "$OFFSITE_GROUP $OFFSITE_STATUS_GROUP" || "$groups" == "$OFFSITE_STATUS_GROUP $OFFSITE_GROUP" ]]; then
  ok "Dienstbenutzergruppen" "nur Uploader- und Statusgruppe"
else
  fail "Dienstbenutzergruppen" "unerwartete Zusatzgruppe vorhanden"
fi
if offsite_assert_group_isolation >/dev/null 2>&1; then ok "Gruppenisolation" "keine fremden Konten"; else fail "Gruppenisolation" "fremdes Konto oder GID-Belegung"; fi
recovery_command="$OFFSITE_APP_ROOT/server-tools/linux/recovery/grabenplaner-recovery.sh"
recovery_link="/usr/local/sbin/grabenplaner-recovery"
if [[ -f "$recovery_command" && ! -L "$recovery_command" && -L "$recovery_link" \
  && "$(readlink -f -- "$recovery_link")" == "$recovery_command" ]]; then
  ok "Recovery-Befehl" "ueberwachte list/prepare/verify/apply-Phasen installiert"
else
  fail "Recovery-Befehl" "fehlt oder zeigt nicht auf das installierte Serverpaket"
fi
for timer in grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer; do
  if systemctl is-enabled --quiet "$timer" && systemctl is-active --quiet "$timer"; then ok "Timer $timer" "aktiv"; else fail "Timer $timer" "nicht aktiv"; fi
done

status_gid="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $3}')"
if [[ "$status_gid" =~ ^[0-9]+$ && -f "$OFFSITE_STATUS_FILE" && ! -L "$OFFSITE_STATUS_FILE" \
  && "$(stat --format='%u:%g:%a:%h' -- "$OFFSITE_STATUS_FILE")" == "0:$status_gid:640:1" ]] \
  && "$OFFSITE_NODE" "$OFFSITE_STATUS_HELPER" --status-file "$OFFSITE_STATUS_FILE" --status-gid "$status_gid" inspect >/dev/null 2>&1
then
  ok "Redigierter Status" "Schema und 14/8/12-Regel gueltig"
else
  fail "Redigierter Status" "fehlt oder ist ungueltig"
fi

credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")"
offsite_acquire_repository_lock
if offsite_verify_repository_identity "$credentials" "$operation_root/repository.json"; then
  ok "Repository-Identitaet" "gepinnt und erreichbar"
else
  fail "Repository-Identitaet" "nicht sicher bestaetigt"
fi

if (( failures > 0 )); then
  offsite_warn "$failures Offsite-Pruefung(en) sind fehlgeschlagen."
  exit 1
fi
offsite_info "Alle Offsite-Pruefungen waren erfolgreich."

#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

offsite_require_root
for command_name in awk chmod chown flock getent id install mktemp readlink rm runuser sha256sum stat systemctl; do offsite_require_command "$command_name"; done
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

if offsite_assert_persistent_rclone_config >/dev/null 2>&1; then ok "rclone-Konfiguration" "verschluesselt und persistent"; else fail "rclone-Konfiguration" "Datei oder Rechte ungueltig"; fi
groups="$(id -Gn "$OFFSITE_USER" 2>/dev/null || true)"
if [[ "$groups" == "$OFFSITE_GROUP $OFFSITE_STATUS_GROUP" || "$groups" == "$OFFSITE_STATUS_GROUP $OFFSITE_GROUP" ]]; then
  ok "Dienstbenutzergruppen" "nur Uploader- und Statusgruppe"
else
  fail "Dienstbenutzergruppen" "unerwartete Zusatzgruppe vorhanden"
fi
if offsite_assert_group_isolation >/dev/null 2>&1; then ok "Gruppenisolation" "keine fremden Konten"; else fail "Gruppenisolation" "fremdes Konto oder GID-Belegung"; fi
if offsite_assert_control_group_isolation >/dev/null 2>&1; then
  ok "RAS-Steuerungsgruppe" "ausschliesslich dem Grabenplaner-Dienstkonto zugewiesen"
else
  fail "RAS-Steuerungsgruppe" "fremdes Konto oder unsichere GID-Belegung"
fi
recovery_command="$OFFSITE_APP_ROOT/server-tools/linux/recovery/grabenplaner-recovery.sh"
recovery_link="/usr/local/sbin/grabenplaner-recovery"
if [[ -f "$recovery_command" && ! -L "$recovery_command" && -L "$recovery_link" \
  && "$(readlink -f -- "$recovery_link")" == "$recovery_command" ]]; then
  ok "Recovery-Befehl" "ueberwachte list/prepare/verify/apply-Phasen installiert"
else
  fail "Recovery-Befehl" "fehlt oder zeigt nicht auf das installierte Serverpaket"
fi
rebind_command="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-rebind-rclone.sh"
rebind_link="/usr/local/sbin/grabenplaner-offsite-rebind-rclone"
if [[ -f "$rebind_command" && ! -L "$rebind_command" && -L "$rebind_link" \
  && "$(readlink -f -- "$rebind_link")" == "$rebind_command" ]]; then
  ok "OAuth-Neuanbindung" "root-only Wartungsbefehl installiert"
else
  fail "OAuth-Neuanbindung" "Wartungsbefehl fehlt oder zeigt nicht auf das installierte Modul"
fi
assurance_command="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-assurance.sh"
assurance_link="/usr/local/sbin/grabenplaner-offsite-assurance"
if [[ -f "$assurance_command" && ! -L "$assurance_command" && -L "$assurance_link" \
  && "$(readlink -f -- "$assurance_link")" == "$assurance_command" ]]; then
  ok "Recovery Assurance" "root-only Pruefbefehl installiert"
else
  fail "Recovery Assurance" "Pruefbefehl fehlt oder zeigt nicht auf das installierte Modul"
fi
recovery_set_command="$OFFSITE_MODULE_ROOT/grabenplaner-offsite-recovery-set.sh"
recovery_set_link="/usr/local/sbin/grabenplaner-offsite-recovery-set"
if [[ -f "$recovery_set_command" && ! -L "$recovery_set_command" && -L "$recovery_set_link" \
  && "$(readlink -f -- "$recovery_set_link")" == "$recovery_set_command" ]]; then
  ok "Offline-Recovery-Set" "root-only Export- und Pruefbefehl installiert"
else
  fail "Offline-Recovery-Set" "Befehl fehlt oder zeigt nicht auf das installierte Modul"
fi
for timer in grabenplaner-offsite-upload.timer grabenplaner-offsite-check.timer grabenplaner-offsite-restore-test.timer; do
  if systemctl is-enabled --quiet "$timer" && systemctl is-active --quiet "$timer"; then ok "Timer $timer" "aktiv"; else fail "Timer $timer" "nicht aktiv"; fi
done

control_socket_unit="grabenplaner-offsite-assurance-control.socket"
control_socket_root="/run/grabenplaner-assurance-control"
control_socket_path="$control_socket_root/request.sock"
control_gid="$(getent group "$OFFSITE_CONTROL_GROUP" | awk -F: '{print $3}')"
if systemctl is-enabled --quiet "$control_socket_unit" && systemctl is-active --quiet "$control_socket_unit"; then
  ok "RAS-Steuerungssocket" "aktiv und beim Systemstart aktiviert"
else
  fail "RAS-Steuerungssocket" "nicht aktiv oder nicht aktiviert"
fi
if [[ "$control_gid" =~ ^[0-9]+$ && -d "$control_socket_root" && ! -L "$control_socket_root" \
  && -S "$control_socket_path" && ! -L "$control_socket_path" \
  && "$(stat --format='%u:%g:%a' -- "$control_socket_root")" == "0:0:755" \
  && "$(stat --format='%u:%g:%a:%h' -- "$control_socket_path")" == "0:$control_gid:660:1" ]]; then
  ok "RAS-Socketrechte" "root und dedizierte Steuerungsgruppe, Modus 0660"
else
  fail "RAS-Socketrechte" "Pfad, Besitz oder Modus weicht vom Sicherheitsvertrag ab"
fi
control_client="$OFFSITE_APP_ROOT/lib/recovery-assurance-control-client.js"
if [[ -f "$control_client" && ! -L "$control_client" ]] && runuser --user "$OFFSITE_APP_USER" -- env -i PATH=/usr/bin:/bin \
  "$OFFSITE_NODE" - "$control_client" <<'NODE' >/dev/null 2>&1
const client = require(process.argv[2]);
client.recoveryAssuranceControlStatus({ timeoutMs: 3000 })
  .then((status) => {
    if (!status || status.available !== true || typeof status.busy !== "boolean" || status.reason !== null && typeof status.reason !== "string") process.exitCode = 1;
  })
  .catch(() => { process.exitCode = 1; });
NODE
then
  ok "RAS-Steuerungsprotokoll" "redigierter Status als App-Dienstkonto abrufbar"
else
  fail "RAS-Steuerungsprotokoll" "Socket oder Statusprotokoll nicht sicher nutzbar"
fi

status_gid="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $3}')"
if [[ "$status_gid" =~ ^[0-9]+$ ]] && offsite_assurance_history inspect >/dev/null 2>&1; then
  ok "Assurance-Verlauf" "Signaturen, Kette und Dateirechte gueltig"
else
  fail "Assurance-Verlauf" "Signaturkette fehlt oder ist ungueltig"
fi
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
if offsite_assert_dedicated_rclone_oauth "$credentials" >/dev/null 2>&1; then
  ok "Google OAuth" "eigener Client und Scope drive.file bestaetigt"
else
  fail "Google OAuth" "eigener Client fehlt oder Richtlinie nicht bestaetigt"
fi
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

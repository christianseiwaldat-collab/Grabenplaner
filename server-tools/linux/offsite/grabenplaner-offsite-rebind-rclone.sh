#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

usage() {
  cat <<'EOF'
Verwendung: sudo grabenplaner-offsite-rebind-rclone \
  --rclone-config /root/geschuetzt/rclone.conf \
  --rclone-config-password /root/geschuetzt/rclone-config-password \
  --yes

Bindet ausschliesslich eine vollstaendig vorbereitete, verschluesselte
rclone-Konfiguration mit eigenem Google-OAuth-Client an das bereits gepinnte
Restic-Repository. Es wird niemals ein Repository angelegt.
EOF
}

rclone_config_source=""
rclone_password_source=""
confirmed=0
while (($#)); do
  case "$1" in
    --rclone-config) rclone_config_source="${2:?Wert fehlt}"; shift 2 ;;
    --rclone-config-password) rclone_password_source="${2:?Wert fehlt}"; shift 2 ;;
    --yes) confirmed=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) offsite_die "Unbekannte Option." ;;
  esac
done

offsite_require_root
(( confirmed == 1 )) || offsite_die "Die Neuanbindung erfordert die ausdrueckliche Option --yes."
for command_name in awk chmod chown cmp cp flock getent id install mktemp mv readlink realpath rm runuser sha256sum sleep stat sync systemctl tr; do
  offsite_require_command "$command_name"
done
[[ -x "$OFFSITE_NODE" ]] || offsite_die "Node.js muss unter /usr/bin/node installiert sein."

secure_root_source() {
  local source="$1" label="$2" resolved
  [[ -n "$source" && "$source" == /* ]] || offsite_die "$label muss ein absoluter lokaler Pfad sein."
  resolved="$(realpath --canonicalize-existing -- "$source")" || offsite_die "$label wurde nicht gefunden."
  [[ "$resolved" == "$source" && -f "$resolved" && ! -L "$resolved" ]] \
    || offsite_die "$label muss eine kanonische regulaere Datei sein."
  [[ "$(stat --format='%u:%g:%a:%h' -- "$resolved")" == "0:0:600:1" ]] \
    || offsite_die "$label muss eine eindeutige root:root-Datei mit Modus 0600 sein."
  printf '%s\n' "$resolved"
}

rclone_config_source="$(secure_root_source "$rclone_config_source" "rclone-Konfiguration")"
rclone_password_source="$(secure_root_source "$rclone_password_source" "rclone-Konfigurationspasswort")"
"$OFFSITE_NODE" - "$rclone_config_source" "$rclone_password_source" <<'NODE' \
  || offsite_die "Die bereitgestellten rclone-Dateien sind ungueltig."
const fs = require("node:fs");
const [configFile, passwordFile] = process.argv.slice(2);
const config = fs.readFileSync(configFile);
const password = fs.readFileSync(passwordFile);
const configText = config.toString("utf8");
if (config.length < 32 || config.length > 1024 * 1024 || config.includes(0)
  || !/^(?:(?:[ \t]*#[^\r\n]*|[ \t]*)\r?\n)*RCLONE_ENCRYPT_V0:/.test(configText)) process.exit(1);
if (password.length < 16 || password.length > 1024 || password.includes(0)) process.exit(1);
const passwordText = password.toString("utf8");
if (!passwordText.trim() || /[\r\n]/.test(passwordText.trimEnd())) process.exit(1);
NODE

offsite_assert_runtime_binaries
offsite_assert_persistent_rclone_config
offsite_assert_regular_root_file "$OFFSITE_CONFIG_ROOT/rclone-config-password"
[[ "$(stat --format='%u:%g:%a:%h' -- "$OFFSITE_CONFIG_ROOT/rclone-config-password")" == "0:0:600:1" ]] \
  || offsite_die "Das bestehende rclone-Konfigurationspasswort hat unsichere Rechte."
remote="$(offsite_repository_remote "$OFFSITE_CONFIG_ROOT")" \
  || offsite_die "Das bestehende rclone-Remote ist ungueltig."
expected_repository_id="$(tr -d '\r\n' <"$OFFSITE_CONFIG_ROOT/repository-id")"
[[ "$expected_repository_id" =~ ^[a-f0-9]{16,64}$ ]] \
  || offsite_die "Die gepinnte Repository-ID ist ungueltig."

core_common="$OFFSITE_APP_ROOT/server-tools/linux/lib/common.sh"
[[ -f "$core_common" && ! -L "$core_common" ]] \
  || offsite_die "Die verifizierte Core-Wartungssperre fehlt."
# shellcheck source=server-tools/linux/lib/common.sh
source "$core_common"

timers=(
  grabenplaner-offsite-assurance.timer
  grabenplaner-offsite-upload.timer
  grabenplaner-offsite-check.timer
  grabenplaner-offsite-restore-test.timer
)
services=(
  grabenplaner-offsite-prepare.service
  grabenplaner-offsite-upload.service
  grabenplaner-offsite-check.service
  grabenplaner-offsite-restore-test.service
)
declare -a timer_was_enabled=(0 0 0 0)
declare -a timer_was_active=(0 0 0 0)
timers_paused=0
operation_root=""
setup_root=""
candidate_credentials=""
post_credentials=""
config_next=""
password_next=""
commit_started=0
rebind_complete=0
preserve_operation_root=0

restore_timer_state() {
  local index
  for index in 0 1 2 3; do
    if (( timer_was_enabled[index] == 1 )); then
      systemctl enable "${timers[index]}" >/dev/null 2>&1 || return 1
    fi
    if (( timer_was_active[index] == 1 )); then
      systemctl start "${timers[index]}" >/dev/null 2>&1 || return 1
    fi
  done
  timers_paused=0
}

restore_original_credentials() {
  local rollback_config_next="" rollback_password_next="" stage_failed=0 restore_failed=0
  [[ -n "$operation_root" && -f "$operation_root/original-rclone.conf" \
    && -f "$operation_root/original-rclone-config-password" ]] || return 1
  rollback_config_next="$(mktemp --tmpdir="$OFFSITE_CREDENTIAL_STATE_ROOT" .rclone.conf.rollback.XXXXXXXX)" || return 1
  rollback_password_next="$(mktemp --tmpdir="$OFFSITE_CONFIG_ROOT" .rclone-config-password.rollback.XXXXXXXX)" || {
    rm -f -- "$rollback_config_next"
    return 1
  }
  install -m 0600 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" \
    -- "$operation_root/original-rclone.conf" "$rollback_config_next" || stage_failed=1
  install -m 0600 -o root -g root \
    -- "$operation_root/original-rclone-config-password" "$rollback_password_next" || stage_failed=1
  if (( stage_failed == 0 )); then sync -f "$rollback_config_next" "$rollback_password_next" || stage_failed=1; fi
  if (( stage_failed == 0 )); then
    mv -f -- "$rollback_config_next" "$OFFSITE_RCLONE_CONFIG" || restore_failed=1
    [[ -e "$rollback_config_next" ]] || rollback_config_next=""
    mv -f -- "$rollback_password_next" "$OFFSITE_CONFIG_ROOT/rclone-config-password" || restore_failed=1
    [[ -e "$rollback_password_next" ]] || rollback_password_next=""
  fi
  # Sollte ein Rename auf einem beschaedigten Dateisystem scheitern, werden
  # beide Originale unter den bereits gehaltenen Sperren nochmals direkt
  # hergestellt. Dadurch bleibt kein bewusst gemischtes Credential-Paar zurueck.
  if ! cmp --silent -- "$operation_root/original-rclone.conf" "$OFFSITE_RCLONE_CONFIG"; then
    install -m 0600 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" \
      -- "$operation_root/original-rclone.conf" "$OFFSITE_RCLONE_CONFIG" || restore_failed=1
  fi
  if ! cmp --silent -- "$operation_root/original-rclone-config-password" "$OFFSITE_CONFIG_ROOT/rclone-config-password"; then
    install -m 0600 -o root -g root \
      -- "$operation_root/original-rclone-config-password" "$OFFSITE_CONFIG_ROOT/rclone-config-password" || restore_failed=1
  fi
  # Der abschliessende Bytevergleich ist massgeblich; ein erfolgreicher
  # Direkt-Fallback darf einen zuvor fehlgeschlagenen Rename vollstaendig heilen.
  restore_failed=0
  sync -f "$OFFSITE_CREDENTIAL_STATE_ROOT" "$OFFSITE_CONFIG_ROOT" || restore_failed=1
  cmp --silent -- "$operation_root/original-rclone.conf" "$OFFSITE_RCLONE_CONFIG" || restore_failed=1
  cmp --silent -- "$operation_root/original-rclone-config-password" "$OFFSITE_CONFIG_ROOT/rclone-config-password" \
    || restore_failed=1
  [[ -z "$rollback_config_next" ]] || rm -f -- "$rollback_config_next"
  [[ -z "$rollback_password_next" ]] || rm -f -- "$rollback_password_next"
  (( restore_failed == 0 ))
}

cleanup() {
  local status=$? rollback_failed=0 timer_restore_failed=0
  trap - EXIT
  set +e
  if (( rebind_complete == 0 && commit_started == 1 )); then
    restore_original_credentials || rollback_failed=1
  fi
  [[ -z "$candidate_credentials" ]] || offsite_remove_uploader_credentials "$candidate_credentials" >/dev/null 2>&1
  [[ -z "$post_credentials" ]] || offsite_remove_uploader_credentials "$post_credentials" >/dev/null 2>&1
  [[ -z "$config_next" ]] || rm -f -- "$config_next"
  [[ -z "$password_next" ]] || rm -f -- "$password_next"
  if [[ -n "$setup_root" && -d "$setup_root" && ! -L "$setup_root" ]]; then
    rm -rf --one-file-system -- "$setup_root"
  fi
  if (( timers_paused == 1 )); then restore_timer_state || timer_restore_failed=1; fi
  if (( rollback_failed == 1 )); then
    preserve_operation_root=1
    offsite_warn "Der automatische Credential-Rollback ist fehlgeschlagen; das root-only Arbeitsverzeichnis bleibt zur beaufsichtigten Wiederherstellung erhalten: $operation_root"
    status=1
  fi
  if (( timer_restore_failed == 1 )); then
    offsite_warn "Der vorherige Zustand der Offsite-Timer konnte nicht vollstaendig wiederhergestellt werden."
    status=1
  fi
  if (( preserve_operation_root == 0 )) && [[ -n "$operation_root" && -d "$operation_root" && ! -L "$operation_root" ]]; then
    rm -rf --one-file-system -- "$operation_root"
  fi
  if (( status == 0 && rebind_complete == 1 )); then
    offsite_info "Die verschluesselte rclone-Konfiguration wurde sicher an das bestehende Repository neu gebunden."
  fi
  exit "$status"
}
trap cleanup EXIT

gp_acquire_maintenance_lock
offsite_acquire_assurance_lock
for index in 0 1 2 3; do
  load_state="$(systemctl show --property=LoadState --value "${timers[index]}" 2>/dev/null)" \
    || offsite_die "Ein erforderlicher Offsite-Timer fehlt."
  [[ -n "$load_state" && "$load_state" != "not-found" ]] \
    || offsite_die "Ein erforderlicher Offsite-Timer fehlt."
  systemctl is-enabled --quiet "${timers[index]}" && timer_was_enabled[index]=1 || true
  systemctl is-active --quiet "${timers[index]}" && timer_was_active[index]=1 || true
done
timers_paused=1
for index in 0 1 2 3; do
  systemctl disable --now "${timers[index]}" >/dev/null \
    || offsite_die "Ein Offsite-Timer konnte nicht kontrolliert pausiert werden."
done
for service_name in "${services[@]}"; do
  deadline=$((SECONDS + 14400))
  while systemctl is-active --quiet "$service_name"; do
    (( SECONDS < deadline )) || offsite_die "Ein laufender Offsite-Vorgang wurde nicht rechtzeitig abgeschlossen."
    sleep 2
  done
done
offsite_acquire_repository_lock

# Alle Vorpruefungen werden unter der vollstaendigen Sperrkette nochmals auf
# dem tatsaechlich verwendeten Live-Stand ausgefuehrt. Ein Update oder ein
# zweiter Rebind waehrend der Wartezeit darf keinen vorab geprueften, spaeter
# ausgetauschten Modul-/Credential-Stand einschleusen.
offsite_assert_runtime_binaries
offsite_assert_persistent_rclone_config
offsite_assert_regular_root_file "$OFFSITE_CONFIG_ROOT/rclone-config-password"
[[ "$(stat --format='%u:%g:%a:%h' -- "$OFFSITE_CONFIG_ROOT/rclone-config-password")" == "0:0:600:1" ]] \
  || offsite_die "Das bestehende rclone-Konfigurationspasswort hat sich waehrend der Sperruebernahme unsicher veraendert."
locked_remote="$(offsite_repository_remote "$OFFSITE_CONFIG_ROOT")" \
  || offsite_die "Das eingerichtete rclone-Remote ist nach der Sperruebernahme ungueltig."
locked_repository_id="$(tr -d '\r\n' <"$OFFSITE_CONFIG_ROOT/repository-id")"
[[ "$locked_remote" == "$remote" && "$locked_repository_id" == "$expected_repository_id" ]] \
  || offsite_die "Die bestehende Repository-Bindung hat sich waehrend der Sperruebernahme geaendert."

operation_root="$(mktemp --directory --tmpdir="$OFFSITE_RUN_ROOT" rebind.XXXXXXXX)"
chown root:root -- "$operation_root"
chmod 0700 -- "$operation_root"
setup_root="$(mktemp --directory --tmpdir="$OFFSITE_RUN_ROOT" setup.XXXXXXXX)"
source_credentials="$operation_root/source-credentials"
chown "root:$OFFSITE_GROUP" -- "$setup_root"
chmod 0750 -- "$setup_root"
install -d -m 0700 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" -- "$setup_root/config"
install -d -m 0700 -o root -g root -- "$source_credentials"
install -m 0755 -o root -g root -- "$OFFSITE_RCLONE" "$setup_root/rclone"
install -m 0755 -o root -g root -- "$OFFSITE_READER" "$setup_root/read-secret"
install -m 0755 -o root -g root -- "$OFFSITE_MODULE_ROOT/lib/offsite-setup-rclone-wrapper.sh" "$setup_root/rclone-wrapper"
install -m 0600 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" -- "$rclone_config_source" "$setup_root/config/rclone.conf"
for name in repository repository-id installation-id restic-password; do
  install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/$name" "$source_credentials/$name"
done
install -m 0600 -o root -g root -- "$rclone_password_source" "$source_credentials/rclone-config-password"
candidate_credentials="$(offsite_make_uploader_credentials "$source_credentials")"

setup_run() {
  runuser --user "$OFFSITE_USER" -- env -i \
    HOME="$OFFSITE_UPLOADER_HOME" USER="$OFFSITE_USER" LOGNAME="$OFFSITE_USER" PATH=/usr/bin:/bin \
    CREDENTIALS_DIRECTORY="$candidate_credentials" GRABENPLANER_OFFSITE_SETUP_ROOT="$setup_root" "$@"
}
setup_restic() {
  setup_run "$OFFSITE_RESTIC" --repository-file "$candidate_credentials/repository" \
    --password-file "$candidate_credentials/restic-password" --retry-lock 15m \
    -o "rclone.program=$setup_root/rclone-wrapper" "$@"
}

setup_run "$setup_root/rclone-wrapper" config redacted "$remote" 2>/dev/null \
  | "$OFFSITE_NODE" "$OFFSITE_RCLONE_POLICY_HELPER" "$remote" >/dev/null \
  || offsite_die "Die neue rclone-Konfiguration verwendet keinen freigegebenen eigenen Google-OAuth-Client."
setup_restic cat config >"$operation_root/candidate-repository.json" 2>/dev/null \
  || offsite_die "Die neue rclone-Konfiguration erreicht das bestehende Repository nicht."
candidate_repository_id="$("$OFFSITE_NODE" - "$operation_root/candidate-repository.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!/^[a-f0-9]{16,64}$/i.test(String(value.id || ""))) process.exit(1);
process.stdout.write(String(value.id).toLowerCase());
NODE
)" || offsite_die "Die Identitaet des bestehenden Repositorys konnte nicht gelesen werden."
[[ "$candidate_repository_id" == "$expected_repository_id" ]] \
  || offsite_die "Die neue rclone-Konfiguration verweist nicht auf das gepinnte bestehende Repository."
# Ein moeglicher Token-Refresh waehrend des Repositoryzugriffs darf die
# OAuth-Richtlinie nicht veraendern.
setup_run "$setup_root/rclone-wrapper" config redacted "$remote" 2>/dev/null \
  | "$OFFSITE_NODE" "$OFFSITE_RCLONE_POLICY_HELPER" "$remote" >/dev/null \
  || offsite_die "Die aktualisierte rclone-Konfiguration verletzt die OAuth-Richtlinie."

install -m 0600 -o root -g root -- "$OFFSITE_RCLONE_CONFIG" "$operation_root/original-rclone.conf"
install -m 0600 -o root -g root \
  -- "$OFFSITE_CONFIG_ROOT/rclone-config-password" "$operation_root/original-rclone-config-password"
config_next="$(mktemp --tmpdir="$OFFSITE_CREDENTIAL_STATE_ROOT" .rclone.conf.rebind.XXXXXXXX)"
password_next="$(mktemp --tmpdir="$OFFSITE_CONFIG_ROOT" .rclone-config-password.rebind.XXXXXXXX)"
install -m 0600 -o "$OFFSITE_USER" -g "$OFFSITE_GROUP" -- "$setup_root/config/rclone.conf" "$config_next"
install -m 0600 -o root -g root -- "$rclone_password_source" "$password_next"
sync -f "$config_next" "$password_next"

commit_started=1
mv -f -- "$config_next" "$OFFSITE_RCLONE_CONFIG"
config_next=""
mv -f -- "$password_next" "$OFFSITE_CONFIG_ROOT/rclone-config-password"
password_next=""
sync -f "$OFFSITE_CREDENTIAL_STATE_ROOT" "$OFFSITE_CONFIG_ROOT"

offsite_assert_persistent_rclone_config
[[ "$(stat --format='%u:%g:%a:%h' -- "$OFFSITE_CONFIG_ROOT/rclone-config-password")" == "0:0:600:1" ]] \
  || offsite_die "Das neu gebundene rclone-Konfigurationspasswort hat unsichere Rechte."
post_credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")"
offsite_assert_dedicated_rclone_oauth "$post_credentials"
offsite_verify_repository_identity "$post_credentials" "$operation_root/post-repository.json" \
  || offsite_die "Die Repository-Bindung konnte nach dem Credential-Tausch nicht bestaetigt werden."
cmp --silent -- "$setup_root/config/rclone.conf" "$OFFSITE_RCLONE_CONFIG" \
  || offsite_die "Die persistente rclone-Konfiguration weicht vom geprueften Kandidaten ab."
cmp --silent -- "$rclone_password_source" "$OFFSITE_CONFIG_ROOT/rclone-config-password" \
  || offsite_die "Das persistente rclone-Konfigurationspasswort weicht vom geprueften Kandidaten ab."

restore_timer_state || offsite_die "Der vorherige Zustand der Offsite-Timer konnte nicht wiederhergestellt werden."
app_version="$($OFFSITE_NODE -e 'const value=require("/opt/grabenplaner/app/package.json");const version=String(value.version||"");if(!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version))process.exit(1);process.stdout.write(version)')" \
  || offsite_die "Die installierte App-Version ist fuer Recovery Assurance ungueltig."
offsite_record_assurance_queue configuration-change-queued oauth-config-changed "$app_version" \
  || offsite_die "Die OAuth-Aenderung konnte nicht im signierten Recovery-Assurance-Verlauf vorgemerkt werden."
systemctl start --no-block grabenplaner-offsite-assurance@oauth-config-changed.service >/dev/null \
  || offsite_die "Die Recovery-Assurance-Pruefung der neuen OAuth-Konfiguration konnte nicht eingeplant werden."
rebind_complete=1

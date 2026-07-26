#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly RESULT_FORMAT="grabenplaner-offsite-target-switch-result"
readonly RESULT_SCHEMA_VERSION=1
readonly MANAGED_PREFIX="Grabenplaner-Offsite"
readonly COPY_MAX_DURATION="20m"
readonly PENDING_MARKER_FORMAT="grabenplaner-offsite-target-switch-pending"

completed=0
failure_code="TARGET_SWITCH_FAILED"
emit_result() {
  local ok="$1" code="$2" migration_mode="$3" recovery_state="$4" fallback_preserved="$5"
  printf '{"format":"%s","schemaVersion":%d,"ok":%s,"code":"%s","migrationMode":%s,"recoverySetState":%s,"fallbackPreserved":%s}\n' \
    "$RESULT_FORMAT" "$RESULT_SCHEMA_VERSION" "$ok" "$code" "$migration_mode" "$recovery_state" "$fallback_preserved"
}
on_exit() {
  local status=$?
  trap - EXIT ERR
  if (( completed == 0 )) && declare -F rollback_repository_binding >/dev/null 2>&1; then
    rollback_repository_binding || true
  fi
  if declare -F cleanup >/dev/null 2>&1; then cleanup || true; fi
  if (( completed == 0 )); then
    emit_result false "$failure_code" null null false
  fi
  exit "$status"
}
trap on_exit EXIT

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

if (($# != 2)) || [[ "$1" != "--folder-label" ]]; then
  failure_code="TARGET_SWITCH_REQUEST_INVALID"
  exit 2
fi
folder_label="$2"
if [[ ${#folder_label} -gt 48 || ! "$folder_label" =~ ^[A-Za-z0-9]([A-Za-z0-9_-]{0,46}[A-Za-z0-9])?$ ]]; then
  failure_code="TARGET_SWITCH_REQUEST_INVALID"
  exit 2
fi

offsite_require_root
for command_name in awk chmod chown cp date dirname find flock getent grep install mktemp mv readlink \
  realpath rm runuser sha256sum stat sync timeout tr wc; do
  offsite_require_command "$command_name"
done
[[ -x "$OFFSITE_NODE" ]] || offsite_die "Die freigegebene Node.js-Laufzeit fehlt."
core_common="$OFFSITE_APP_ROOT/server-tools/linux/lib/common.sh"
[[ -f "$core_common" && ! -L "$core_common" ]] \
  || offsite_die "Die verifizierte Core-Wartungssperre fehlt."
# shellcheck source=server-tools/linux/lib/common.sh
source "$core_common"

operation_root=""
current_credentials=""
candidate_credentials=""
pending_temporary=""
pending_final=""
pending_marker_temporary=""
original_repository=""
repository_committed=0
pending_marker="$OFFSITE_RECOVERY_SET_ROOT/target-switch-pending.json"
cleanup() {
  if [[ -n "$current_credentials" ]]; then offsite_remove_uploader_credentials "$current_credentials" || true; fi
  if [[ -n "$candidate_credentials" ]]; then offsite_remove_uploader_credentials "$candidate_credentials" || true; fi
  if [[ -n "$pending_temporary" && -d "$pending_temporary" && ! -L "$pending_temporary" \
    && "$pending_temporary" == "$OFFSITE_RECOVERY_SET_ROOT/.pending."* ]]; then
    rm -rf --one-file-system -- "$pending_temporary" || true
  fi
  if [[ -n "$pending_marker_temporary" && -f "$pending_marker_temporary" && ! -L "$pending_marker_temporary" \
    && "$pending_marker_temporary" == "$OFFSITE_RECOVERY_SET_ROOT/.target-switch-pending."* ]]; then
    rm -f -- "$pending_marker_temporary" || true
  fi
  if (( completed == 0 )) && [[ -n "$pending_final" && -d "$pending_final" && ! -L "$pending_final" \
    && "$pending_final" == "$OFFSITE_RECOVERY_SET_ROOT/grabenplaner-recovery-set-pending-"* ]]; then
    rm -rf --one-file-system -- "$pending_final" || true
  fi
  if [[ -n "$operation_root" && -d "$operation_root" && ! -L "$operation_root" \
    && "$operation_root" == "$OFFSITE_RUN_ROOT/target-switch."* ]]; then
    rm -rf --one-file-system -- "$operation_root" || true
  fi
}
verify_repository_identity_bounded() {
  local credentials="$1" config_file="$2" actual expected
  [[ "$credentials" == "$OFFSITE_RUN_ROOT/credentials."* \
    && "$config_file" == "$operation_root/"* && "$config_file" != *"/../"* ]] || return 1
  offsite_assert_runtime_binaries
  if ! offsite_run_as_uploader "$credentials" /usr/bin/timeout \
    --signal=TERM --kill-after=5s 60s \
    "$OFFSITE_RESTIC" \
    --repository-file "$credentials/repository" \
    --password-file "$credentials/restic-password" \
    --retry-lock 30s \
    -o "rclone.program=$OFFSITE_RCLONE_WRAPPER" \
    cat config >"$config_file" 2>/dev/null; then
    return 1
  fi
  [[ -f "$config_file" && ! -L "$config_file" \
    && "$(stat --format='%s' -- "$config_file")" =~ ^[1-9][0-9]{1,4}$ ]] || return 1
  actual="$("$OFFSITE_NODE" -e '
const fs=require("node:fs");
const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(!/^[a-f0-9]{16,64}$/i.test(String(value.id||"")))process.exit(1);
process.stdout.write(String(value.id).toLowerCase());
' "$config_file")" || return 1
  expected="$(tr -d '\r\n' <"$credentials/repository-id")"
  [[ "$expected" =~ ^[a-f0-9]{16,64}$ && "$actual" == "$expected" ]]
}
rollback_repository_binding() {
  local rollback_next="" rollback_credentials=""
  (( repository_committed == 1 )) || return 0
  [[ -n "$original_repository" && -f "$original_repository" && ! -L "$original_repository" ]] || return 1
  rollback_next="$(mktemp --tmpdir="$OFFSITE_CONFIG_ROOT" .repository.rollback.XXXXXXXX)" || return 1
  install -m 0600 -o root -g root -- "$original_repository" "$rollback_next" || {
    rm -f -- "$rollback_next"
    return 1
  }
  sync -f "$rollback_next" || {
    rm -f -- "$rollback_next"
    return 1
  }
  mv -T -- "$rollback_next" "$OFFSITE_CONFIG_ROOT/repository" || return 1
  sync -f "$OFFSITE_CONFIG_ROOT" || return 1
  if [[ -n "$candidate_credentials" ]]; then
    offsite_remove_uploader_credentials "$candidate_credentials" || return 1
    candidate_credentials=""
  fi
  rollback_credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")" || return 1
  if ! verify_repository_identity_bounded "$rollback_credentials" "$operation_root/rollback-repository.json"; then
    offsite_remove_uploader_credentials "$rollback_credentials" || true
    return 1
  fi
  offsite_remove_uploader_credentials "$rollback_credentials" || return 1
  repository_committed=0
}
pending_marker_matches_request() {
  offsite_assert_regular_root_file "$pending_marker"
  [[ "$(stat --format='%u:%g:%a:%h' -- "$pending_marker")" == "0:0:600:1" \
    && "$(stat --format='%s' -- "$pending_marker")" =~ ^[1-9][0-9]{1,3}$ ]] \
    || offsite_die "Der lokale Wiederaufnahmebeleg besitzt unsichere Metadaten."
  "$OFFSITE_NODE" - "$pending_marker" "$folder_label" "$OFFSITE_CONFIG_ROOT/repository-id" <<'NODE' >/dev/null
const fs = require("node:fs");
const [markerFile, expectedLabel, repositoryIdFile] = process.argv.slice(2);
const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
const expectedId = fs.readFileSync(repositoryIdFile, "utf8").trim().toLowerCase();
const keys = Object.keys(marker || {}).sort();
if (JSON.stringify(keys) !== JSON.stringify([
  "createdAt", "folderLabel", "format", "repositoryId", "schemaVersion",
])
  || marker.format !== "grabenplaner-offsite-target-switch-pending"
  || marker.schemaVersion !== 1
  || marker.folderLabel !== expectedLabel
  || marker.repositoryId !== expectedId
  || !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,46}[A-Za-z0-9])?$/.test(marker.folderLabel)
  || !/^[a-f0-9]{16,64}$/.test(marker.repositoryId)
  || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(marker.createdAt || ""))
  || !Number.isFinite(Date.parse(marker.createdAt))
  || new Date(marker.createdAt).toISOString() !== marker.createdAt) process.exit(1);
NODE
}
create_pending_marker() {
  [[ ! -e "$pending_marker" && ! -L "$pending_marker" ]] \
    || offsite_die "Ein anderer Offsite-Zielwechsel ist noch nicht abgeschlossen."
  pending_marker_temporary="$(mktemp --tmpdir="$OFFSITE_RECOVERY_SET_ROOT" .target-switch-pending.XXXXXXXX)"
  "$OFFSITE_NODE" - "$pending_marker_temporary" "$folder_label" "$OFFSITE_CONFIG_ROOT/repository-id" <<'NODE'
const fs = require("node:fs");
const [target, folderLabel, repositoryIdFile] = process.argv.slice(2);
const repositoryId = fs.readFileSync(repositoryIdFile, "utf8").trim().toLowerCase();
if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,46}[A-Za-z0-9])?$/.test(folderLabel)
  || !/^[a-f0-9]{16,64}$/.test(repositoryId)) process.exit(1);
const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_TRUNC);
try {
  fs.writeFileSync(descriptor, `${JSON.stringify({
    format: "grabenplaner-offsite-target-switch-pending",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    folderLabel,
    repositoryId,
  })}\n`, "utf8");
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
NODE
  chown root:root -- "$pending_marker_temporary"
  chmod 0600 -- "$pending_marker_temporary"
  mv -T -- "$pending_marker_temporary" "$pending_marker"
  pending_marker_temporary=""
  sync -f "$OFFSITE_RECOVERY_SET_ROOT"
  pending_marker_matches_request \
    || offsite_die "Der lokale Wiederaufnahmebeleg konnte nicht sicher bestaetigt werden."
}
remove_pending_marker() {
  [[ -e "$pending_marker" || -L "$pending_marker" ]] || return 0
  pending_marker_matches_request \
    || offsite_die "Der lokale Wiederaufnahmebeleg ist ungueltig."
  rm -f -- "$pending_marker"
  sync -f "$OFFSITE_RECOVERY_SET_ROOT"
}

offsite_assert_runtime_binaries
offsite_assert_persistent_rclone_config
offsite_assert_regular_root_file "$OFFSITE_CONFIG_ROOT/repository"
offsite_assert_regular_root_file "$OFFSITE_CONFIG_ROOT/repository-id"
offsite_assert_regular_root_file "$OFFSITE_CONFIG_ROOT/restic-password"
offsite_assert_regular_root_file "$OFFSITE_CONFIG_ROOT/rclone-config-password"

gp_acquire_maintenance_lock
offsite_acquire_assurance_lock
offsite_acquire_repository_lock
offsite_assurance_history inspect >/dev/null \
  || offsite_die "Der signierte Recovery-Assurance-Verlauf ist nicht sicher lesbar."

offsite_prepare_run_root
operation_root="$(mktemp --directory --tmpdir="$OFFSITE_RUN_ROOT" target-switch.XXXXXXXX)"
chown root:root -- "$operation_root"
chmod 0700 -- "$operation_root"

readarray -t repository_values < <("$OFFSITE_NODE" - "$OFFSITE_CONFIG_ROOT/repository" "$folder_label" <<'NODE'
const fs = require("node:fs");
const [file, label] = process.argv.slice(2);
const value = fs.readFileSync(file, "utf8").trim();
const match = value.match(/^rclone:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([A-Za-z0-9][A-Za-z0-9._/-]{0,511})$/);
if (!match || match[2].split("/").some((part) => !part || part === "." || part === "..")
  || !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,46}[A-Za-z0-9])?$/.test(label)
  || Buffer.byteLength(label, "utf8") > 48) process.exit(1);
const candidatePath = `Grabenplaner-Offsite/${label}`;
process.stdout.write(`${match[1]}\n${match[2]}\n${candidatePath}\n`);
NODE
) || offsite_die "Die Repository-Bindung konnte nicht sicher gelesen werden."
(( ${#repository_values[@]} == 3 )) || offsite_die "Die Repository-Bindung ist unvollstaendig."
remote="${repository_values[0]}"
current_path="${repository_values[1]}"
candidate_path="${repository_values[2]}"
current_repository="rclone:$remote:$current_path"
candidate_repository="rclone:$remote:$candidate_path"
if [[ "$current_repository" == "$candidate_repository" ]]; then
  failure_code="TARGET_FOLDER_ALREADY_ACTIVE"
  exit 1
fi

install -d -m 0700 -o root -g root -- "$OFFSITE_RECOVERY_SET_ROOT"
[[ -d "$OFFSITE_RECOVERY_SET_ROOT" && ! -L "$OFFSITE_RECOVERY_SET_ROOT" \
  && "$(stat --format='%u:%g:%a' -- "$OFFSITE_RECOVERY_SET_ROOT")" == "0:0:700" ]] \
  || offsite_die "Der geschuetzte Recovery-Set-Bereich ist unsicher."
existing_pending_recovery_set="$(
  find "$OFFSITE_RECOVERY_SET_ROOT" -mindepth 1 -maxdepth 1 \
    -name 'grabenplaner-recovery-set-pending-*' -print -quit
)"
[[ -z "$existing_pending_recovery_set" ]] \
  || offsite_die "Ein vorheriger Recovery-Satz wartet noch auf den bestaetigten Offline-Transfer."
pending_marker_present=0
if [[ -e "$pending_marker" || -L "$pending_marker" ]]; then
  pending_marker_matches_request \
    || offsite_die "Ein anderer oder ungueltiger Offsite-Zielwechsel ist noch nicht abgeschlossen."
  pending_marker_present=1
fi

candidate_root="$operation_root/candidate"
install -d -m 0700 -o root -g root -- "$candidate_root"
for name in repository-id installation-id restic-password rclone-config-password; do
  install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/$name" "$candidate_root/$name"
done
printf '%s\n' "$candidate_repository" >"$candidate_root/repository"
chown root:root -- "$candidate_root/repository"
chmod 0600 -- "$candidate_root/repository"
candidate_credentials="$(offsite_make_uploader_credentials "$candidate_root")"

current_credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")"
offsite_assert_dedicated_rclone_oauth "$current_credentials"
list_output="$operation_root/candidate-list.txt"
list_error="$operation_root/candidate-list.error"
set +e
offsite_run_as_uploader "$current_credentials" "$OFFSITE_RCLONE_WRAPPER" \
  lsf "$remote:$candidate_path" --max-depth 1 >"$list_output" 2>"$list_error"
list_status=$?
set -e
candidate_empty=0
if (( list_status == 0 )); then
  [[ "$(wc -c <"$list_output")" =~ ^[0-9]+$ ]] || offsite_die "Das Kandidatenziel ist nicht sicher pruefbar."
  [[ ! -s "$list_output" ]] && candidate_empty=1
elif (( list_status == 3 )); then
  offsite_run_as_uploader "$current_credentials" "$OFFSITE_RCLONE_WRAPPER" \
    mkdir "$remote:$candidate_path" >/dev/null 2>"$operation_root/candidate-mkdir.error" \
    || offsite_die "Das Kandidatenziel konnte nicht vorbereitet werden."
  candidate_empty=1
else
  offsite_die "Das Kandidatenziel ist nicht sicher pruefbar."
fi

migration_mode="verified-existing"
if (( candidate_empty == 1 && pending_marker_present == 0 )); then
  create_pending_marker
  pending_marker_present=1
fi
if (( pending_marker_present == 1 )); then
  migration_mode="copied"
else
  verify_repository_identity_bounded "$candidate_credentials" "$operation_root/candidate-repository-before-copy.json" \
    || offsite_die "Ein bestehendes Kandidatenziel besitzt nicht exakt die erwartete Repository-Identitaet."
fi
# Der root-only Wiederaufnahmebeleg autorisiert ausschliesslich die
# Fortsetzung eines von diesem Helper selbst an einem zuvor leeren Ziel
# begonnenen Transfers. Ohne diesen Beleg wird ein nichtleeres Ziel vor
# jedem Schreiben gegen die gepinnte Repository-ID geprueft.
offsite_run_as_uploader "$current_credentials" "$OFFSITE_RCLONE_WRAPPER" \
  copy "$remote:$current_path" "$remote:$candidate_path" \
  --checkers 4 --transfers 4 --contimeout 15s --timeout 5m \
  --retries 3 --low-level-retries 10 --max-duration "$COPY_MAX_DURATION" \
  >/dev/null 2>"$operation_root/candidate-copy.error" \
  || offsite_die "Das bestehende Repository konnte nicht vollstaendig zum Kandidatenziel kopiert werden."
offsite_run_as_uploader "$current_credentials" "$OFFSITE_RCLONE_WRAPPER" \
  check "$remote:$current_path" "$remote:$candidate_path" \
  --checkers 4 --one-way --max-duration 5m \
  >/dev/null 2>"$operation_root/candidate-check.error" \
  || offsite_die "Das Kandidatenziel enthaelt nicht alle aktuellen Repository-Objekte."

verify_repository_identity_bounded "$candidate_credentials" "$operation_root/candidate-repository.json" \
  || offsite_die "Das Kandidatenziel besitzt nicht exakt die erwartete Repository-Identitaet."

pending_stamp="$(date --utc '+%Y%m%dT%H%M%SZ')"
pending_nonce="$("$OFFSITE_NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
[[ "$pending_nonce" =~ ^[a-f0-9]{16}$ ]] || offsite_die "Die Recovery-Set-Kennung konnte nicht erzeugt werden."
pending_name="grabenplaner-recovery-set-pending-$pending_stamp-$pending_nonce"
pending_final="$OFFSITE_RECOVERY_SET_ROOT/$pending_name"
pending_temporary="$(mktemp --directory --tmpdir="$OFFSITE_RECOVERY_SET_ROOT" .pending.XXXXXXXX)"
chown root:root -- "$pending_temporary"
chmod 0700 -- "$pending_temporary"

install -m 0600 -o root -g root -- "$candidate_root/repository" "$pending_temporary/repository"
for entry in \
  "repository-id:$OFFSITE_CONFIG_ROOT/repository-id" \
  "installation-id:$OFFSITE_CONFIG_ROOT/installation-id" \
  "restic-password:$OFFSITE_CONFIG_ROOT/restic-password" \
  "rclone-config-password:$OFFSITE_CONFIG_ROOT/rclone-config-password" \
  "grabenplaner.env:$OFFSITE_APP_ENV" \
  "binary-pins.json:$OFFSITE_CONFIG_ROOT/binary-pins.json" \
  "offsite-installed-contract.json:$OFFSITE_CONFIG_ROOT/installed-contract.json"; do
  IFS=: read -r target_name source_name <<<"$entry"
  install -m 0600 -o root -g root -- "$source_name" "$pending_temporary/$target_name"
done
install -m 0600 -o root -g root /dev/null "$pending_temporary/rclone.conf"
offsite_stream_persistent_rclone_config >"$pending_temporary/rclone.conf" \
  || offsite_die "Die rclone-Konfiguration konnte nicht sicher in das Recovery-Set uebernommen werden."
chown root:root -- "$pending_temporary/rclone.conf"
chmod 0600 -- "$pending_temporary/rclone.conf"
status_gid="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $3}')"
[[ "$status_gid" =~ ^[0-9]+$ ]] || offsite_die "Die Offsite-Statusgruppe konnte nicht sicher aufgeloest werden."
install -d -m 0750 -o root -g "$OFFSITE_STATUS_GROUP" \
  -- "$pending_temporary/assurance" "$pending_temporary/assurance/history"
install -m 0600 -o root -g root \
  -- "$OFFSITE_ASSURANCE_ROOT/signing-private.pem" "$pending_temporary/assurance/signing-private.pem"
install -m 0440 -o root -g "$OFFSITE_STATUS_GROUP" \
  -- "$OFFSITE_ASSURANCE_ROOT/signing-public.pem" "$pending_temporary/assurance/signing-public.pem"
install -m 0640 -o root -g "$OFFSITE_STATUS_GROUP" \
  -- "$OFFSITE_ASSURANCE_ROOT/head.json" "$pending_temporary/assurance/head.json"
cp --archive --reflink=never -- "$OFFSITE_ASSURANCE_HISTORY/." "$pending_temporary/assurance/history/"
chown -R --no-dereference "root:$OFFSITE_STATUS_GROUP" "$pending_temporary/assurance/history"
find "$pending_temporary/assurance/history" -xdev -type d -exec chmod 0750 -- {} +
find "$pending_temporary/assurance/history" -xdev -type f -exec chmod 0640 -- {} +
cat >"$pending_temporary/HINWEISE.txt" <<'EOF'
GRABENPLANER OFFLINE-RECOVERY-SET - TRANSFER UND PRUEFUNG AUSSTAENDIG

Dieses root-only Recovery-Set gehoert bereits zum neu gebundenen
Offsite-Repository. Es enthaelt hochsensible Zugangsdaten und Schluessel.

Noch zwingend manuell auszufuehren:
- stark verschluesselt auf ein getrenntes Administrationsgeraet uebertragen
- dort Vollstaendigkeit und Lesbarkeit beaufsichtigt pruefen
- getrennt von VPS und Restic-Repository aufbewahren

Das bisherige Repository und bereits offline gelagerte Recovery-Set bleiben
bis zum Abschluss dieser Schritte der unabhaengige Rueckfallpunkt.
EOF
chmod 0600 -- "$pending_temporary/HINWEISE.txt"
"$OFFSITE_NODE" - "$pending_temporary" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
function walk(directory, base = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target, base));
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(target);
      files.push({
        path: path.relative(base, target).split(path.sep).join("/"),
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      });
    } else process.exit(1);
  }
  return files;
}
const files = walk(root).sort((left, right) => left.path.localeCompare(right.path));
fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({
  format: "grabenplaner-offline-recovery-set",
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  files,
}, null, 2)}\n`, { mode: 0o600, flag: "wx" });
NODE
chown root:root -- "$pending_temporary/manifest.json"
chmod 0600 -- "$pending_temporary/manifest.json"
"$SCRIPT_DIR/grabenplaner-offsite-recovery-set.sh" verify --input "$pending_temporary" >/dev/null \
  || offsite_die "Das neue Recovery-Set konnte nicht vollstaendig verifiziert werden."
sync -f "$pending_temporary"
mv -T -- "$pending_temporary" "$pending_final"
pending_temporary=""
sync -f "$pending_final"
sync -f "$OFFSITE_RECOVERY_SET_ROOT"
"$SCRIPT_DIR/grabenplaner-offsite-recovery-set.sh" verify --input "$pending_final" >/dev/null \
  || offsite_die "Das festgeschriebene Recovery-Set konnte nicht erneut verifiziert werden."

original_repository="$operation_root/original-repository"
install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/repository" "$original_repository"
repository_next="$(mktemp --tmpdir="$OFFSITE_CONFIG_ROOT" .repository.next.XXXXXXXX)"
install -m 0600 -o root -g root -- "$candidate_root/repository" "$repository_next"
sync -f "$repository_next"
mv -T -- "$repository_next" "$OFFSITE_CONFIG_ROOT/repository"
repository_committed=1
sync -f "$OFFSITE_CONFIG_ROOT"

offsite_remove_uploader_credentials "$candidate_credentials"
candidate_credentials=""
candidate_credentials="$(offsite_make_uploader_credentials "$OFFSITE_CONFIG_ROOT")"
if ! verify_repository_identity_bounded "$candidate_credentials" "$operation_root/post-repository.json"; then
  rollback_repository_binding \
    || offsite_die "Die Repository-Bindung konnte nicht sicher zurueckgerollt werden."
  offsite_die "Die neue Repository-Bindung hat die Nachpruefung nicht bestanden und wurde zurueckgerollt."
fi
remove_pending_marker

completed=1
emit_result true "TARGET_FOLDER_ACTIVATED" "\"$migration_mode\"" \
  '"pending-offline-transfer-and-verification"' true
exit 0

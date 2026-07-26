#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
# shellcheck source=server-tools/linux/offsite/lib/offsite-common.sh
source "$SCRIPT_DIR/lib/offsite-common.sh"

usage() {
  cat <<'EOF'
Verwendung:
  sudo grabenplaner-offsite-recovery-set export --output /root/grabenplaner-recovery-set-DATUM --yes
  sudo grabenplaner-offsite-recovery-set verify --input /root/grabenplaner-recovery-set-DATUM

Der Export erzeugt ein root-only Zwischenverzeichnis zur beaufsichtigten,
verschluesselten Uebertragung auf ein getrenntes Administrationsgeraet.
EOF
}

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage; exit 2; }
shift
target=""
confirmed=0
while (($#)); do
  case "$1" in
    --output|--input) target="${2:?Pfad fehlt}"; shift 2 ;;
    --yes) confirmed=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) offsite_die "Unbekannte Option." ;;
  esac
done

offsite_require_root
for required in awk cat chmod chown cp dirname find flock getent grep install mktemp mv readlink realpath rm sha256sum stat sync; do
  offsite_require_command "$required"
done
[[ -x "$OFFSITE_NODE" ]] || offsite_die "Die freigegebene Node.js-Laufzeit fehlt."
core_common="$OFFSITE_APP_ROOT/server-tools/linux/lib/common.sh"
[[ -f "$core_common" && ! -L "$core_common" ]] \
  || offsite_die "Die verifizierte Core-Wartungssperre fehlt."
# shellcheck source=server-tools/linux/lib/common.sh
source "$core_common"

secure_target() {
  local requested="$1" mode="$2" resolved parent
  [[ "$requested" != *"/../"* ]] \
    || offsite_die "Der Recovery-Set-Pfad ist nicht zulaessig."
  if [[ "$mode" == "existing" ]]; then
    resolved="$(realpath --canonicalize-existing -- "$requested")" \
      || offsite_die "Das Recovery-Set wurde nicht gefunden."
  else
    resolved="$(realpath --canonicalize-missing -- "$requested")" \
      || offsite_die "Der Recovery-Set-Pfad ist ungueltig."
  fi
  parent="$(dirname -- "$resolved")"
  [[ "$resolved" == "$requested" && (
      ( "$parent" == "/root" && "$resolved" == /root/grabenplaner-recovery-set-* )
      || ( "$parent" == "$OFFSITE_RECOVERY_SET_ROOT"
        && "$resolved" == "$OFFSITE_RECOVERY_SET_ROOT/grabenplaner-recovery-set-pending-"* )
      || ( "$parent" == "$OFFSITE_RECOVERY_SET_ROOT"
        && "$resolved" == "$OFFSITE_RECOVERY_SET_ROOT/.pending."* )
    ) ]] \
    || offsite_die "Der Recovery-Set-Pfad ist nicht kanonisch."
  printf '%s\n' "$resolved"
}

verify_set() {
  local root="$1" status_gid assurance_reader
  [[ -d "$root" && ! -L "$root" && "$(stat --format='%u:%g:%a' -- "$root")" == "0:0:700" ]] \
    || offsite_die "Der Recovery-Set-Ordner ist unsicher."
  if find "$root" -xdev \( -type l -o -type f -links +1 -o \( ! -type f -a ! -type d \) \) -print -quit | grep -q .; then
    offsite_die "Das Recovery-Set enthaelt unzulaessige Dateitypen oder Verknuepfungen."
  fi
  [[ -f "$root/manifest.json" && ! -L "$root/manifest.json" \
    && "$(stat --format='%u:%g:%a:%h' -- "$root/manifest.json")" == "0:0:600:1" ]] \
    || offsite_die "Das Recovery-Set-Manifest ist unsicher."
  status_gid="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $3}')"
  [[ "$status_gid" =~ ^[0-9]+$ ]] || offsite_die "Die Offsite-Statusgruppe konnte nicht sicher aufgeloest werden."
  "$OFFSITE_NODE" - "$root" "$status_gid" <<'NODE' >/dev/null
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const statusGid = Number(process.argv[3]);
const manifestFile = path.join(root, "manifest.json");
const required = [
  "HINWEISE.txt", "assurance/head.json", "assurance/signing-private.pem",
  "assurance/signing-public.pem", "binary-pins.json", "grabenplaner.env",
  "installation-id", "offsite-installed-contract.json", "rclone-config-password",
  "rclone.conf", "repository", "repository-id", "restic-password",
];
const historyPattern = /^assurance\/history\/\d{12}-[a-f0-9]{64}\.json$/;
function walk(directory, base = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const relative = path.relative(base, target).split(path.sep).join("/");
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) process.exit(1);
    if (entry.isDirectory()) {
      if (!["assurance", "assurance/history"].includes(relative)) process.exit(1);
      files.push(...walk(target, base));
    }
    else if (entry.isFile() && stat.nlink === 1) files.push(relative);
    else process.exit(1);
  }
  return files.sort();
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const manifestStat = fs.lstatSync(manifestFile);
if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1
  || (process.platform !== "win32" && (manifestStat.uid !== 0 || manifestStat.gid !== 0 || (manifestStat.mode & 0o7777) !== 0o600))) process.exit(1);
if (manifest?.format !== "grabenplaner-offline-recovery-set" || manifest?.schemaVersion !== 1
  || !Number.isFinite(Date.parse(String(manifest.createdAt || ""))) || !Array.isArray(manifest.files)
  || manifest.files.length < required.length) process.exit(1);
const entries = new Map();
for (const item of manifest.files) {
  if (!item || typeof item.path !== "string" || entries.has(item.path)
    || !/^[a-f0-9]{64}$/.test(String(item.sha256 || "")) || !Number.isSafeInteger(item.bytes) || item.bytes < 1) process.exit(1);
  entries.set(item.path, item);
}
if (required.some((name) => !entries.has(name))) process.exit(1);
for (const name of entries.keys()) {
  if (!required.includes(name) && !historyPattern.test(name)) process.exit(1);
}
const actual = walk(root).filter((name) => name !== "manifest.json");
if (JSON.stringify(actual) !== JSON.stringify([...entries.keys()].sort())) process.exit(1);
for (const directory of [path.join(root, "assurance"), path.join(root, "assurance", "history")]) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.uid !== 0 || stat.gid !== statusGid
      || (stat.mode & 0o7777) !== 0o750))) process.exit(1);
}
for (const name of entries.keys()) {
  const file = path.join(root, name);
  const stat = fs.lstatSync(file);
  const bytes = fs.readFileSync(file);
  const item = entries.get(name);
  let expectedMode = 0o600;
  let expectedGid = 0;
  if (name === "assurance/signing-public.pem") { expectedMode = 0o440; expectedGid = statusGid; }
  else if (name === "assurance/head.json" || historyPattern.test(name)) { expectedMode = 0o640; expectedGid = statusGid; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== item.bytes
    || (process.platform !== "win32" && (stat.uid !== 0 || stat.gid !== expectedGid
      || (stat.mode & 0o7777) !== expectedMode))
    || crypto.createHash("sha256").update(bytes).digest("hex") !== item.sha256) process.exit(1);
}
NODE
  assurance_reader="$OFFSITE_APP_ROOT/lib/recovery-assurance-status.js"
  [[ -f "$assurance_reader" && ! -L "$assurance_reader" ]] \
    || offsite_die "Der Recovery-Assurance-Pruefer fehlt."
  "$OFFSITE_NODE" - "$root/assurance" "$status_gid" "$assurance_reader" <<'NODE' >/dev/null \
    || offsite_die "Der signierte Recovery-Assurance-Verlauf im Recovery-Set ist ungueltig."
const [root, gid, helper] = process.argv.slice(2);
const { readRecoveryAssuranceStatus } = require(helper);
const status = readRecoveryAssuranceStatus({
  configured: true,
  rootPath: root,
  expectedGid: Number(gid),
  requireRootOwner: true,
});
if (status.statusAvailable !== true || status.integrityVerified !== true) process.exit(1);
NODE
}

case "$command_name" in
  export)
    (( confirmed == 1 )) || offsite_die "Der Recovery-Set-Export erfordert die ausdrueckliche Option --yes."
    output="$(secure_target "$target" missing)"
    [[ ! -e "$output" && ! -L "$output" ]] || offsite_die "Der Zielordner darf noch nicht existieren."
    gp_acquire_maintenance_lock
    offsite_acquire_assurance_lock
    offsite_acquire_repository_lock
    offsite_assert_runtime_binaries
    offsite_assert_persistent_rclone_config
    offsite_assurance_history inspect >/dev/null \
      || offsite_die "Der signierte Recovery-Assurance-Verlauf ist nicht sicher lesbar."
    for source in "$OFFSITE_CONFIG_ROOT/repository" "$OFFSITE_CONFIG_ROOT/repository-id" \
      "$OFFSITE_CONFIG_ROOT/installation-id" "$OFFSITE_CONFIG_ROOT/restic-password" \
      "$OFFSITE_CONFIG_ROOT/rclone-config-password" "$OFFSITE_RCLONE_CONFIG" "$OFFSITE_APP_ENV" \
      "$OFFSITE_CONFIG_ROOT/binary-pins.json" "$OFFSITE_CONFIG_ROOT/installed-contract.json" \
      "$OFFSITE_ASSURANCE_ROOT/signing-private.pem" "$OFFSITE_ASSURANCE_ROOT/signing-public.pem" \
      "$OFFSITE_ASSURANCE_ROOT/head.json"; do
      [[ -f "$source" && ! -L "$source" ]] || offsite_die "Eine benoetigte Recovery-Datei fehlt."
    done
    temporary="$(mktemp --directory --tmpdir=/root .grabenplaner-recovery-set.XXXXXXXX)"
    cleanup() { [[ -d "$temporary" && ! -L "$temporary" ]] && rm -rf --one-file-system -- "$temporary"; }
    trap cleanup EXIT
    chmod 0700 -- "$temporary"
    install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/repository" "$temporary/repository"
    install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/repository-id" "$temporary/repository-id"
    install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/installation-id" "$temporary/installation-id"
    install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/restic-password" "$temporary/restic-password"
    install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/rclone-config-password" "$temporary/rclone-config-password"
    install -m 0600 -o root -g root -- "$OFFSITE_RCLONE_CONFIG" "$temporary/rclone.conf"
    install -m 0600 -o root -g root -- "$OFFSITE_APP_ENV" "$temporary/grabenplaner.env"
    install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/binary-pins.json" "$temporary/binary-pins.json"
    install -m 0600 -o root -g root -- "$OFFSITE_CONFIG_ROOT/installed-contract.json" "$temporary/offsite-installed-contract.json"
    status_gid="$(getent group "$OFFSITE_STATUS_GROUP" | awk -F: '{print $3}')"
    [[ "$status_gid" =~ ^[0-9]+$ ]] || offsite_die "Die Offsite-Statusgruppe konnte nicht sicher aufgeloest werden."
    install -d -m 0750 -o root -g "$OFFSITE_STATUS_GROUP" -- "$temporary/assurance" "$temporary/assurance/history"
    install -m 0600 -o root -g root -- "$OFFSITE_ASSURANCE_ROOT/signing-private.pem" "$temporary/assurance/signing-private.pem"
    install -m 0440 -o root -g "$OFFSITE_STATUS_GROUP" -- "$OFFSITE_ASSURANCE_ROOT/signing-public.pem" "$temporary/assurance/signing-public.pem"
    install -m 0640 -o root -g "$OFFSITE_STATUS_GROUP" -- "$OFFSITE_ASSURANCE_ROOT/head.json" "$temporary/assurance/head.json"
    cp --archive --reflink=never -- "$OFFSITE_ASSURANCE_HISTORY/." "$temporary/assurance/history/"
    chown -R --no-dereference "root:$OFFSITE_STATUS_GROUP" "$temporary/assurance/history"
    find "$temporary/assurance/history" -xdev -type d -exec chmod 0750 -- {} +
    find "$temporary/assurance/history" -xdev -type f -exec chmod 0640 -- {} +
    cat >"$temporary/HINWEISE.txt" <<'EOF'
GRABENPLANER OFFLINE-RECOVERY-SET

Dieses Verzeichnis enthaelt hochsensible Zugangsdaten und Schluessel.
Es muss vor der Uebertragung stark verschluesselt, danach vom Server geloescht
und getrennt vom VPS sowie vom Restic-Repository aufbewahrt werden.

Manuell zu ergaenzen und getrennt zu pruefen:
- Wiederherstellungszugang des zugeordneten Google-Kontos
- Kontakt und Ablauf fuer die verantwortliche IT
- Datum eines beaufsichtigten Lesetests auf dem Offline-Medium

Die Datei manifest.json prueft Vollstaendigkeit und unveraenderte Bytes. Sie
ersetzt weder die Verschluesselung des Sets noch einen echten Restore-Test.
Der Ordner assurance enthaelt die vollstaendige signierte Historie samt
Schluesselpaar; nur dieses gemeinsame Set erlaubt eine lueckenlose Fortsetzung.
EOF
    chmod 0600 -- "$temporary/HINWEISE.txt"
    "$OFFSITE_NODE" - "$temporary" <<'NODE'
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
      files.push({ path: path.relative(base, target).split(path.sep).join("/"), bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    } else process.exit(1);
  }
  return files;
}
const files = walk(root).sort((left, right) => left.path.localeCompare(right.path));
const manifest = { format: "grabenplaner-offline-recovery-set", schemaVersion: 1, createdAt: new Date().toISOString(), files };
fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
NODE
    verify_set "$temporary"
    sync -f "$temporary"
    verify_set "$temporary"
    mv -T -- "$temporary" "$output"
    temporary=""
    sync -f "$output"
    sync -f /root
    verify_set "$output"
    offsite_info "Das verifizierte root-only Recovery-Set wurde fuer den beaufsichtigten Offline-Transfer vorbereitet."
    ;;
  verify)
    input="$(secure_target "$target" existing)"
    verify_set "$input"
    offsite_info "Das Offline-Recovery-Set ist vollstaendig und unveraendert."
    ;;
  *) usage; exit 2 ;;
esac

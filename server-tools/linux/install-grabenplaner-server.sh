#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SERVICE_USER="grabenplaner"
readonly SERVICE_GROUP="grabenplaner"
readonly BUILD_USER="grabenplaner-build"
readonly BUILD_GROUP="grabenplaner-build"
readonly APP_PARENT="/opt/grabenplaner"
readonly APP_ROOT="${APP_PARENT}/app"
readonly DATA_ROOT="/var/lib/grabenplaner"
readonly CACHE_ROOT="/var/cache/grabenplaner"
readonly LOG_ROOT="/var/log/grabenplaner"
readonly BACKUP_ROOT="/var/backups/grabenplaner"
readonly CONFIG_ROOT="/etc/grabenplaner"
readonly ENV_FILE="${CONFIG_ROOT}/grabenplaner.env"
readonly APP_UNIT="/etc/systemd/system/grabenplaner.service"
readonly BOOTSTRAP_UNIT="/etc/systemd/system/grabenplaner-bootstrap.service"
readonly MONITOR_UNIT="/etc/systemd/system/grabenplaner-monitor.service"
readonly MONITOR_TIMER="/etc/systemd/system/grabenplaner-monitor.timer"
readonly MONITOR_STATUS_ROOT="/var/lib/grabenplaner-monitor"
readonly MONITOR_STATUS_FILE="${MONITOR_STATUS_ROOT}/status.json"
readonly MONITOR_STATUS_GROUP="grabenplaner-monitor-status"
readonly CADDY_CONFIG="/etc/caddy/Caddyfile"
readonly BOOTSTRAP_COMMAND="/usr/local/sbin/grabenplaner-bootstrap-admin"
readonly CADDY_MANAGED_MARKER="# Managed by Grabenplaner. Local changes may be replaced by the installer."
readonly MANIFEST_NAME="grabenplaner-server-manifest.json"
readonly EXPECTED_PNPM_VERSION="11.7.0"
readonly MAX_ARCHIVE_BYTES=$((2 * 1024 * 1024 * 1024))
readonly MAX_EXTRACTED_BYTES=$((4 * 1024 * 1024 * 1024))

PACKAGE_PATH=""
EXPECTED_SHA256=""
SHA256_FILE=""
PUBLIC_URL=""
PORT="3000"
NODE_EXECUTABLE=""
START_AFTER_INSTALL=1
REPLACE_CADDY_CONFIG=0
STAGE_ROOT=""
APP_SWAPPED=0
CADDY_CONFIG_REPLACED=0
CADDY_CONFIG_BACKUP=""
CADDY_CONFIG_WRITTEN=0
CADDY_SERVICE_STATE_CAPTURED=0
CADDY_WAS_ACTIVE=0
CADDY_WAS_ENABLED=0
APP_UNIT_WRITTEN=0
BOOTSTRAP_UNIT_WRITTEN=0
MONITOR_UNIT_WRITTEN=0
MONITOR_TIMER_WRITTEN=0
BOOTSTRAP_COMMAND_WRITTEN=0
UNIT_TEMP=""
PNPM_COMMAND=()

fail() {
  printf 'Fehler: %s\n' "$*" >&2
  exit 1
}

run_as_build_user() {
  local working_directory="$1"
  shift
  [[ -d "$working_directory" && ! -L "$working_directory" ]] \
    || fail "Der Arbeitsordner fuer den Build-Benutzer ist ungueltig."
  (
    cd -- "$working_directory"
    runuser -u "$BUILD_USER" -- "$@"
  )
}

normalize_verified_archive_modes() {
  local source_root="$1" linux_tools_root script first_line script_count=0
  linux_tools_root="$source_root/server-tools/linux"
  [[ -d "$linux_tools_root" && ! -L "$linux_tools_root" ]] \
    || fail "Der verifizierte Linux-Werkzeugordner fehlt oder ist ungueltig."
  find "$source_root" -type d -exec chmod 0750 {} +
  find "$source_root" -type f -exec chmod 0640 {} +
  while IFS= read -r -d '' script; do
    first_line=""
    IFS= read -r first_line <"$script" || true
    [[ "$first_line" == '#!/usr/bin/env bash' ]] \
      || fail "Ein freigegebenes Linux-Shellwerkzeug besitzt keinen gueltigen Bash-Interpreter."
    chmod 0750 -- "$script"
    script_count=$((script_count + 1))
  done < <(find "$linux_tools_root" -type f -name '*.sh' -print0)
  (( script_count > 0 )) || fail "Das Serverpaket enthaelt keine freigegebenen Linux-Shellwerkzeuge."
}

usage() {
  cat <<'TEXT'
Aufruf:
  sudo bash install-grabenplaner-server.sh \
    --package /pfad/Grabenplaner-Server-...-linux-x64.zip \
    (--sha256 <64-hex> | --sha256-file /pfad/datei.sha256) \
    --public-url https://beta.example.org [Optionen]

Optionen:
  --port <1-65535>       Interner Loopback-Port (Standard: 3000)
  --node <pfad>          Node.js-Binary (Standard: aus PATH)
  --replace-caddy-config Vorhandene Caddy-Konfiguration root-only sichern
                         und auf diesem dedizierten Server ersetzen
  --no-start             Dienste nur installieren, noch nicht starten
  --help                 Diese Hilfe anzeigen

Das Skript laedt selbst keine Binaries herunter. Der explizite, eingefrorene
pnpm-Produktionsinstall darf Pakete aus der konfigurierten Registry beziehen.
TEXT
}

cleanup() {
  local exit_code=$?
  if [[ -n "$UNIT_TEMP" ]]; then
    rm -f -- "$UNIT_TEMP"
  fi
  if [[ -n "$STAGE_ROOT" && -d "$STAGE_ROOT" ]]; then
    rm -rf --one-file-system -- "$STAGE_ROOT"
  fi
  if [[ $exit_code -ne 0 && $APP_SWAPPED -eq 1 ]]; then
    systemctl disable --now grabenplaner-monitor.timer grabenplaner-monitor.service \
      grabenplaner.service grabenplaner-bootstrap.service >/dev/null 2>&1 || true
    rm -rf --one-file-system -- "$APP_ROOT"
  fi
  [[ $exit_code -eq 0 ]] || rollback_caddy_configuration
  if [[ $exit_code -ne 0 ]]; then
    [[ $APP_UNIT_WRITTEN -eq 0 ]] || rm -f -- "$APP_UNIT"
    [[ $BOOTSTRAP_UNIT_WRITTEN -eq 0 ]] || rm -f -- "$BOOTSTRAP_UNIT"
    [[ $MONITOR_UNIT_WRITTEN -eq 0 ]] || rm -f -- "$MONITOR_UNIT"
    [[ $MONITOR_TIMER_WRITTEN -eq 0 ]] || rm -f -- "$MONITOR_TIMER"
    [[ $BOOTSTRAP_COMMAND_WRITTEN -eq 0 ]] || rm -f -- "$BOOTSTRAP_COMMAND"
  fi
  if [[ $exit_code -ne 0 && ( $APP_UNIT_WRITTEN -eq 1 || $BOOTSTRAP_UNIT_WRITTEN -eq 1 \
    || $MONITOR_UNIT_WRITTEN -eq 1 || $MONITOR_TIMER_WRITTEN -eq 1 ) ]]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if [[ $exit_code -ne 0 ]]; then
    local maintenance_name target
    for maintenance_name in backup monitor stop test update uninstall; do
      target="$(readlink -- "/usr/local/sbin/grabenplaner-${maintenance_name}" 2>/dev/null || true)"
      if [[ -n "$target" && ( "$target" == "$APP_ROOT" || "$target" == "$APP_ROOT/"* ) ]]; then
        rm -f -- "/usr/local/sbin/grabenplaner-${maintenance_name}"
      fi
    done
  fi
  exit "$exit_code"
}
trap cleanup EXIT

caddy_config_is_managed() {
  local first_line=""
  [[ -f "$CADDY_CONFIG" && ! -L "$CADDY_CONFIG" ]] || return 1
  IFS= read -r first_line <"$CADDY_CONFIG" || true
  [[ "$first_line" == "$CADDY_MANAGED_MARKER" ]]
}

capture_caddy_service_state() {
  CADDY_WAS_ACTIVE=0
  CADDY_WAS_ENABLED=0
  if systemctl is-active --quiet caddy.service; then CADDY_WAS_ACTIVE=1; fi
  if systemctl is-enabled --quiet caddy.service; then CADDY_WAS_ENABLED=1; fi
  CADDY_SERVICE_STATE_CAPTURED=1
}

restore_caddy_service_state() {
  [[ $CADDY_SERVICE_STATE_CAPTURED -eq 1 ]] || return 0
  if [[ $CADDY_WAS_ACTIVE -eq 1 ]]; then
    systemctl restart caddy.service >/dev/null 2>&1 || true
  else
    systemctl stop caddy.service >/dev/null 2>&1 || true
  fi
  if [[ $CADDY_WAS_ENABLED -eq 1 ]]; then
    systemctl enable caddy.service >/dev/null 2>&1 || true
  else
    systemctl disable caddy.service >/dev/null 2>&1 || true
  fi
}

rollback_caddy_configuration() {
  local configuration_changed=0
  if [[ $CADDY_CONFIG_REPLACED -eq 1 && -n "$CADDY_CONFIG_BACKUP" && -f "$CADDY_CONFIG_BACKUP" ]]; then
    cp --preserve=mode,timestamps,ownership -- "$CADDY_CONFIG_BACKUP" "$CADDY_CONFIG"
    configuration_changed=1
  elif [[ $CADDY_CONFIG_WRITTEN -eq 1 && -f "$CADDY_CONFIG" ]] && caddy_config_is_managed; then
    rm -f -- "$CADDY_CONFIG"
    configuration_changed=1
  fi
  [[ $configuration_changed -eq 0 ]] || restore_caddy_service_state
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Erforderlicher Befehl fehlt: $1"
}

render_template() {
  local source=$1 destination=$2 content
  [[ -f "$source" ]] || fail "Vorlage fehlt: $source"
  content="$(<"$source")"
  content="${content//\{\{PUBLIC_URL\}\}/$PUBLIC_URL}"
  content="${content//\{\{PUBLIC_HOST\}\}/$PUBLIC_HOST}"
  content="${content//\{\{UPSTREAM\}\}/127.0.0.1:$PORT}"
  content="${content//\{\{PORT\}\}/$PORT}"
  content="${content//\{\{NODE_EXECUTABLE\}\}/$NODE_EXECUTABLE}"
  content="${content//\{\{CLAMSCAN_EXECUTABLE\}\}/$CLAMSCAN_EXECUTABLE}"
  content="${content//\{\{CADDY_LOG_PATH\}\}/\/var\/log\/grabenplaner\/caddy\/access.log}"
  content="${content//\{\{AMU_KEY\}\}/${AMU_KEY-}}"
  content="${content//\{\{INTEGRATION_KEY\}\}/${INTEGRATION_KEY-}}"
  content="${content//\{\{WIFI_IDENTITY_KEY\}\}/${WIFI_IDENTITY_KEY-}}"
  content="${content//\{\{WIFI_WEBHOOK_SECRET\}\}/${WIFI_WEBHOOK_SECRET-}}"
  content="${content//\{\{SERVICE_CONTROL_TOKEN\}\}/${SERVICE_CONTROL_TOKEN-}}"
  content="${content//\{\{BOOTSTRAP_TOKEN\}\}/${BOOTSTRAP_TOKEN-}}"
  printf '%s\n' "$content" >"$destination"
  if grep -Eq '\{\{[A-Z0-9_]+\}\}' "$destination"; then
    fail "Nicht ersetzter Platzhalter in der Vorlage: $source"
  fi
}

random_base64() {
  local bytes=$1
  head -c "$bytes" /dev/urandom | base64 | tr -d '\n'
}

environment_value() {
  local key=$1
  awk -F= -v wanted="$key" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$ENV_FILE"
}

require_environment_value() {
  local key=$1 expected=${2-} value
  value="$(environment_value "$key")"
  [[ -n "$value" ]] || fail "Die bestehende Konfiguration enthaelt keinen Wert fuer $key."
  if [[ -n "$expected" && "$value" != "$expected" ]]; then
    fail "Die bestehende Konfiguration verwendet fuer $key einen anderen Wert."
  fi
}

validate_secret_bytes() {
  local key=$1 expected_bytes=$2 value decoded_bytes
  value="$(environment_value "$key")"
  [[ -n "$value" ]] || fail "Die bestehende Konfiguration enthaelt keinen geheimen Wert fuer $key."
  decoded_bytes="$(printf '%s' "$value" | base64 --decode 2>/dev/null | wc -c)" || fail "$key ist kein gueltiger Base64-Wert."
  [[ "$decoded_bytes" -eq "$expected_bytes" ]] || fail "$key hat nicht die erforderliche Laenge."
}

validate_node_version() {
  local version major minor patch architecture
  version="$($NODE_EXECUTABLE --version)"
  version="${version#v}"
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || fail "Node.js meldet eine ungueltige Version."
  if (( major < 22 || (major == 22 && minor < 13) )); then
    fail "Node.js >=22.13.0 ist erforderlich; gefunden wurde $version."
  fi
  architecture="$($NODE_EXECUTABLE -p 'process.arch')"
  [[ "$architecture" == "x64" ]] || fail "Die Node.js-Runtime muss fuer x64 gebaut sein; gefunden wurde $architecture."
}

resolve_pnpm() {
  local version
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_COMMAND=("$(command -v pnpm)")
  elif command -v corepack >/dev/null 2>&1; then
    PNPM_COMMAND=("$(command -v corepack)" pnpm)
  else
    fail "pnpm $EXPECTED_PNPM_VERSION oder Corepack ist erforderlich."
  fi
  version="$(run_as_build_user "$STAGE_ROOT/source" env \
    HOME="$CACHE_ROOT" XDG_CACHE_HOME="$CACHE_ROOT" PNPM_HOME="$CACHE_ROOT/pnpm" COREPACK_HOME="$CACHE_ROOT/corepack" \
    PATH="$(dirname "$NODE_EXECUTABLE"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "${PNPM_COMMAND[@]}" --version)"
  [[ "$version" == "$EXPECTED_PNPM_VERSION" ]] || fail "pnpm $EXPECTED_PNPM_VERSION ist erforderlich; gefunden wurde $version."
}

validate_os() {
  [[ -r /etc/os-release ]] || fail "Die Betriebssystemkennung /etc/os-release fehlt."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || fail "Der Installer unterstuetzt Ubuntu Server."
  case "${VERSION_ID:-}" in
    24.04|26.04) ;;
    *) fail "Unterstuetzt werden Ubuntu 24.04 LTS und 26.04 LTS; gefunden wurde ${VERSION_ID:-unbekannt}." ;;
  esac
  [[ "$(uname -m)" == "x86_64" ]] || fail "Dieses Serverpaket ist fuer x86_64 bestimmt."
}

validate_public_url() {
  PUBLIC_HOST="$($NODE_EXECUTABLE - "$PUBLIC_URL" <<'NODE'
const value = process.argv[2];
let url;
try { url = new URL(value); } catch { process.exit(1); }
if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) process.exit(1);
if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) || !url.hostname.includes(".")) process.exit(1);
process.stdout.write(url.hostname.toLowerCase());
NODE
)" || fail "--public-url muss eine HTTPS-Adresse ohne Port, Pfad, Zugangsdaten, Abfrage oder Fragment sein."
}

validate_zip_entries() {
  local entry normalized count=0 summary declared_count declared_bytes listing mode parsed_modes=0
  declare -A seen_entries=()
  summary="$(unzip -Z -t "$PACKAGE_PATH")" || fail "Das ZIP-Zentralverzeichnis kann nicht gelesen werden."
  declared_count="$(printf '%s\n' "$summary" | awk '/files?, .* bytes uncompressed/ { print $1; exit }')"
  declared_bytes="$(printf '%s\n' "$summary" | awk '/files?, .* bytes uncompressed/ { print $3; exit }')"
  [[ "$declared_count" =~ ^[0-9]+$ && "$declared_bytes" =~ ^[0-9]+$ ]] || fail "Die ZIP-Groessenangaben sind ungueltig."
  (( declared_count > 0 && declared_count <= 100000 )) || fail "Das Serverpaket enthaelt zu viele oder keine Eintraege."
  (( declared_bytes <= MAX_EXTRACTED_BYTES )) || fail "Das Serverpaket wuerde entpackt mehr als 4 GiB belegen."
  listing="$(unzip -Z -l "$PACKAGE_PATH")" || fail "Die ZIP-Dateitypen koennen nicht gelesen werden."
  while IFS= read -r mode; do
    ((parsed_modes += 1))
    case "${mode:0:1}" in
      -|d) ;;
      *) fail "Links und Spezialdateien sind im Serverpaket nicht erlaubt." ;;
    esac
  done < <(printf '%s\n' "$listing" | awk '$1 ~ /^[-dlbcps]/ && $2 ~ /^[0-9]/ { print $1 }')
  (( parsed_modes == declared_count )) || fail "Nicht alle ZIP-Dateitypen konnten sicher bestimmt werden."
  unzip -tq "$PACKAGE_PATH" >/dev/null || fail "Das Server-ZIP ist beschaedigt oder unvollstaendig."
  while IFS= read -r entry; do
    ((count += 1))
    (( count <= 100000 )) || fail "Das Serverpaket enthaelt zu viele Eintraege."
    normalized="${entry#./}"
    [[ -n "$normalized" ]] || continue
    [[ ! "$entry" =~ [[:cntrl:]] && "$normalized" != /* && "$normalized" != *\\* ]] || fail "Ungueltiger ZIP-Pfad im Serverpaket."
    normalized="${normalized%/}"
    [[ -n "$normalized" && -z "${seen_entries[$normalized]+x}" ]] || fail "Doppelter ZIP-Pfad im Serverpaket."
    seen_entries[$normalized]=1
    IFS=/ read -ra parts <<<"$normalized"
    for segment in "${parts[@]}"; do
      [[ -n "$segment" && "$segment" != "." && "$segment" != ".." ]] || fail "Ein ZIP-Pfad ist nicht kanonisch."
    done
  done < <(unzip -Z1 "$PACKAGE_PATH")
  (( count == declared_count )) || fail "ZIP-Dateiliste und Zentralverzeichnis sind inkonsistent."
}

validate_manifest() {
  APP_VERSION="$($NODE_EXECUTABLE - "$STAGE_ROOT/source" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(process.argv[2]);
const manifestPath = path.join(root, "grabenplaner-server-manifest.json");
const fail = (message) => { console.error(message); process.exit(1); };
const expectedOffsiteArtifacts = [
  "server-tools/linux/offsite/grabenplaner-offsite-check.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-pre-update.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-prepare.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-read-secret.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-rclone-wrapper.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-restore-test.sh",
  "server-tools/linux/offsite/grabenplaner-offsite-upload.sh",
  "server-tools/linux/offsite/install-grabenplaner-offsite.sh",
  "server-tools/linux/offsite/lib/offsite-common.sh",
  "server-tools/linux/offsite/lib/offsite-contract.js",
  "server-tools/linux/offsite/lib/offsite-restore-verify.js",
  "server-tools/linux/offsite/lib/offsite-retention-verify.js",
  "server-tools/linux/offsite/lib/offsite-stage.js",
  "server-tools/linux/offsite/lib/offsite-status.js",
  "server-tools/linux/offsite/lib/offsite-setup-rclone-wrapper.sh",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-check.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-check.timer.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-prepare.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-restore-test.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-restore-test.timer.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-upload.service.in",
  "server-tools/linux/offsite/systemd/grabenplaner-offsite-upload.timer.in",
  "server-tools/linux/offsite/uninstall-grabenplaner-offsite.sh",
  "server-tools/linux/offsite/test-grabenplaner-offsite.sh",
];
const expectedMonitorArtifacts = [
  "server-tools/linux/monitor/lib/monitor-status.js",
  "server-tools/linux/monitor/run-grabenplaner-monitor.sh",
  "server-tools/linux/grabenplaner-monitor.service.in",
  "server-tools/linux/grabenplaner-monitor.timer.in",
];
const expectedRecoveryArtifacts = [
  "server-tools/linux/recovery/grabenplaner-recovery.sh",
  "server-tools/linux/recovery/lib/recovery-apply.js",
  "server-tools/linux/recovery/lib/recovery-metadata.js",
  "server-tools/linux/recovery/lib/recovery-verify.js",
];
const hardeningPrefix = "server-tools/linux/hardening/";
const expectedHardeningArtifacts = [
  "server-tools/linux/hardening/grabenplaner-host-security.sh",
  "server-tools/linux/hardening/install-grabenplaner-host-hardening.sh",
  "server-tools/linux/hardening/lib/hardening-common.sh",
  "server-tools/linux/hardening/lib/hardening-contract.js",
  "server-tools/linux/hardening/lib/hardening-policy.js",
  "server-tools/linux/hardening/module-schema.json",
  "server-tools/linux/hardening/systemd/grabenplaner-host-security-audit.service.in",
  "server-tools/linux/hardening/systemd/grabenplaner-host-security-audit.timer.in",
  "server-tools/linux/hardening/systemd/grabenplaner-host-security-rollback.service.in",
  "server-tools/linux/hardening/systemd/grabenplaner-host-security-rollback.timer.in",
  "server-tools/linux/hardening/templates/00-grabenplaner-hardening.conf",
  "server-tools/linux/hardening/templates/60grabenplaner-auto-upgrades",
  "server-tools/linux/hardening/templates/60grabenplaner-unattended-upgrades",
  "server-tools/linux/hardening/templates/60-grabenplaner-journald.conf",
  "server-tools/linux/hardening/templates/60-grabenplaner-sysctl.conf",
  "server-tools/linux/hardening/test-grabenplaner-host-hardening.sh",
  "server-tools/linux/hardening/uninstall-grabenplaner-host-hardening.sh",
];
const expectedHardeningDirectories = new Set(["lib", "systemd", "templates"]);
const sha256File = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
const ordinalCompare = (left, right) => (left === right ? 0 : left < right ? -1 : 1);
function assertExactHardeningTree() {
  const moduleRoot = path.join(root, "server-tools", "linux", "hardening");
  const moduleStat = fs.lstatSync(moduleRoot, { throwIfNoEntry: false });
  if (!moduleStat?.isDirectory() || moduleStat.isSymbolicLink()) fail("Der optionale Hardening-Modulordner ist unzulaessig.");
  const expectedFiles = new Set(expectedHardeningArtifacts.map((relative) => relative.slice(hardeningPrefix.length)));
  const actualFiles = new Set();
  const actualDirectories = new Set();
  function inspect(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail(`Symbolischer Link im Hardening-Modul: ${relative}`);
      if (stat.isDirectory()) {
        if (!expectedHardeningDirectories.has(relative)) fail(`Nicht manifestiertes Hardening-Verzeichnis: ${relative}`);
        actualDirectories.add(relative);
        inspect(target, relative);
      } else if (stat.isFile()) {
        if (!expectedFiles.has(relative)) fail(`Nicht manifestierte Hardening-Moduldatei: ${relative}`);
        actualFiles.add(relative);
      } else {
        fail(`Unzulaessiger Dateityp im Hardening-Modul: ${relative}`);
      }
    }
  }
  inspect(moduleRoot);
  if (actualFiles.size !== expectedFiles.size || [...expectedFiles].some((relative) => !actualFiles.has(relative))) {
    fail("Der Hardening-Modulbaum enthaelt nicht exakt die freigegebenen Dateien.");
  }
  if (actualDirectories.size !== expectedHardeningDirectories.size
    || [...expectedHardeningDirectories].some((relative) => !actualDirectories.has(relative))) {
    fail("Der Hardening-Modulbaum enthaelt nicht exakt die freigegebenen Verzeichnisse.");
  }
}
function hardeningContractMatches(candidate, expected) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(["files", "fingerprint", "format", "moduleVersion", "schemaSha256", "schemaVersion"])) return false;
  if (candidate.format !== expected.format || candidate.schemaVersion !== expected.schemaVersion
    || candidate.moduleVersion !== expected.moduleVersion || candidate.schemaSha256 !== expected.schemaSha256
    || candidate.fingerprint !== expected.fingerprint || !Array.isArray(candidate.files)
    || candidate.files.length !== expected.files.length) return false;
  return candidate.files.every((item, index) => item && typeof item === "object" && !Array.isArray(item)
    && JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["path", "sha256"])
    && item.path === expected.files[index].path && item.sha256 === expected.files[index].sha256);
}
if (!fs.existsSync(manifestPath)) fail("Das Manifest fehlt in der Archivwurzel.");
let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")); } catch { fail("Das Manifest ist kein gueltiges JSON."); }
if (manifest.format !== "grabenplaner-server-package" || manifest.schemaVersion !== 1) fail("Das Manifestformat wird nicht unterstuetzt.");
if (manifest.platform !== "linux" || manifest.architecture !== "x64" || manifest.dependenciesMode !== "source-install") fail("Das Paket ist kein Linux-x64-Quellpaket.");
if (manifest.minimumNode !== ">=22.13.0" || manifest.packageManager !== "pnpm@11.7.0") fail("Die Laufzeitvorgaben des Pakets sind unerwartet.");
if (manifest.nodeRuntimeIncluded !== false || manifest.nodeRuntimeSha256 !== null) fail("Ein Linux-Quellpaket darf keine Node-Runtime enthalten.");
if (!/^[0-9a-f]{7,64}$/i.test(String(manifest.sourceCommit || ""))) fail("Der Quellcommit im Manifest ist ungueltig.");
if (!Number.isFinite(Date.parse(String(manifest.createdAt || "")))) fail("Der Erstellzeitpunkt im Manifest ist ungueltig.");
if (!Array.isArray(manifest.files) || !manifest.files.length) fail("Die Manifestdateiliste fehlt.");
const packageJsonPath = path.join(root, "package.json");
const lockPath = path.join(root, "pnpm-lock.yaml");
for (const required of [
  "server.js", "package.json", "pnpm-lock.yaml", "lib/backup-commit.js", "lib/database-lock.js", "lib/amu-storage.js",
  "server-tools/linux/backup-grabenplaner.sh",
  "server-tools/linux/stop-grabenplaner-server.sh",
  "server-tools/linux/test-grabenplaner-server.sh",
  "server-tools/linux/migrate-grabenplaner-runtime-v2.sh",
  "server-tools/linux/update-grabenplaner-server.sh",
  "server-tools/linux/uninstall-grabenplaner-server.sh",
  "server-tools/linux/runtime-schema.json",
  "server-tools/linux/lib/common.sh",
  "server-tools/linux/lib/backup-snapshot.js",
  "server-tools/linux/lib/hold-database-lock.js",
  "server-tools/linux/lib/prune-backups.js",
  "server-tools/linux/lib/restore-backup.js",
  "server-tools/linux/lib/verify-backup.js",
  "server-tools/linux/lib/verify-install-tree.js",
  "server-tools/linux/lib/verify-package.js",
  ...expectedMonitorArtifacts,
  ...expectedRecoveryArtifacts,
  ...expectedOffsiteArtifacts,
  ...expectedHardeningArtifacts,
]) {
  if (!fs.statSync(path.join(root, required), { throwIfNoEntry: false })?.isFile()) fail(`Pflichtdatei fehlt: ${required}`);
}
const metadata = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (String(metadata.version) !== String(manifest.appVersion)) fail("Manifest- und App-Version stimmen nicht ueberein.");
if (metadata.packageManager !== "pnpm@11.7.0") fail("package.json fordert nicht die freigegebene pnpm-Version.");
const runtimeContract = JSON.parse(fs.readFileSync(path.join(root, "server-tools/linux/runtime-schema.json"), "utf8").replace(/^\uFEFF/, ""));
const expectedRuntimeArtifacts = [
  "server-tools/linux/Caddyfile.in",
  "server-tools/linux/grabenplaner-bootstrap-admin.sh.in",
  "server-tools/linux/grabenplaner-bootstrap.service.in",
  "server-tools/linux/grabenplaner.env.example",
  "server-tools/linux/grabenplaner-monitor.service.in",
  "server-tools/linux/grabenplaner-monitor.timer.in",
  "server-tools/linux/grabenplaner.service.in",
];
if (runtimeContract?.format !== "grabenplaner-linux-runtime-contract" || runtimeContract?.schemaVersion !== 1
  || runtimeContract?.deploymentSchemaVersion !== 2 || runtimeContract?.migrationPolicy !== "explicit-maintenance"
  || !Array.isArray(runtimeContract?.managedArtifacts)
  || runtimeContract.managedArtifacts.length !== expectedRuntimeArtifacts.length
  || expectedRuntimeArtifacts.some((relative) => !runtimeContract.managedArtifacts.includes(relative))) {
  fail("Der Linux-Runtimevertrag v2 ist ungueltig.");
}
const offsiteSchemaPath = path.join(root, "server-tools/linux/offsite/module-schema.json");
let offsiteContract;
try { offsiteContract = JSON.parse(fs.readFileSync(offsiteSchemaPath, "utf8").replace(/^\uFEFF/, "")); } catch { fail("Der optionale Offsite-Modulvertrag ist nicht lesbar."); }
if (offsiteContract?.format !== "grabenplaner-linux-offsite-module-contract" || offsiteContract?.schemaVersion !== 1
  || offsiteContract?.moduleVersion !== 1 || offsiteContract?.activationPolicy !== "explicit-root-setup"
  || !Array.isArray(offsiteContract?.managedArtifacts) || offsiteContract.managedArtifacts.length !== expectedOffsiteArtifacts.length
  || expectedOffsiteArtifacts.some((relative) => !offsiteContract.managedArtifacts.includes(relative))
  || offsiteContract.managedArtifacts.some((relative) => typeof relative !== "string" || !relative.startsWith("server-tools/linux/offsite/") || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === ".."))) {
  fail("Der optionale Offsite-Modulvertrag ist ungueltig.");
}
const hardeningSchemaPath = path.join(root, "server-tools/linux/hardening/module-schema.json");
assertExactHardeningTree();
let hardeningSchema;
try { hardeningSchema = JSON.parse(fs.readFileSync(hardeningSchemaPath, "utf8").replace(/^\uFEFF/, "")); } catch { fail("Der optionale Hardening-Modulvertrag ist nicht lesbar."); }
if (JSON.stringify(Object.keys(hardeningSchema || {}).sort()) !== JSON.stringify(["activationPolicy", "format", "managedArtifacts", "moduleVersion", "schemaVersion"])
  || hardeningSchema?.format !== "grabenplaner-linux-hardening-module-contract" || hardeningSchema?.schemaVersion !== 1
  || hardeningSchema?.moduleVersion !== 1 || hardeningSchema?.activationPolicy !== "explicit-root-two-session"
  || !Array.isArray(hardeningSchema?.managedArtifacts) || hardeningSchema.managedArtifacts.length !== expectedHardeningArtifacts.length
  || expectedHardeningArtifacts.some((relative, index) => hardeningSchema.managedArtifacts[index] !== relative)) {
  fail("Der optionale Hardening-Modulvertrag ist ungueltig.");
}
const hardeningArtifacts = new Map();
for (const relative of hardeningSchema.managedArtifacts) {
  if (typeof relative !== "string" || !relative.startsWith(hardeningPrefix) || relative.includes("\\")
    || relative.split("/").some((part) => !part || part === "." || part === "..") || hardeningArtifacts.has(relative)) {
    fail("Der optionale Hardening-Modulvertrag enthaelt einen ungueltigen Pfad.");
  }
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${root}${path.sep}`)) fail("Ein Hardening-Modulartefakt verlaesst das Paket.");
  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!targetStat?.isFile() || targetStat.isSymbolicLink()) fail(`Hardening-Modulartefakt fehlt oder ist unzulaessig: ${relative}`);
  hardeningArtifacts.set(relative, sha256File(target));
}
const sortedHardeningArtifacts = [...hardeningArtifacts].sort(([left], [right]) => ordinalCompare(left, right));
const hardeningModuleContract = {
  format: "grabenplaner-linux-hardening-installed-contract",
  schemaVersion: 1,
  moduleVersion: 1,
  schemaSha256: sha256File(hardeningSchemaPath),
  fingerprint: crypto.createHash("sha256")
    .update(sortedHardeningArtifacts.map(([relative, hash]) => `${relative}\0${hash}\n`).join(""))
    .digest("hex"),
  files: sortedHardeningArtifacts.map(([relative, sha256]) => ({ path: relative.slice(hardeningPrefix.length), sha256 })),
};
if (!hardeningContractMatches(manifest.hardeningModule, hardeningModuleContract)) {
  fail("Der Hardening-Fingerprint im Paketmanifest stimmt nicht mit dem separaten Modulvertrag ueberein.");
}
const allowedRootFiles = new Set([
  "server.js", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "README.md", "LICENSE.md", "SECURITY.md", "SERVERBETRIEB.md",
]);
const allowedRootDirectories = new Set(["lib", "public", "server-tools"]);
const forbiddenTopLevels = new Set([
  ".git", ".github", ".devcontainer", "backups", "data", "demo", "docs",
  "node_modules", "output", "release", "runtime", "scripts", "test", "tmp", "usb-backups",
]);
function forbiddenPackagePath(relative) {
  const normalized = relative.replaceAll("\\", "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  const top = lower.split("/", 1)[0];
  if (forbiddenTopLevels.has(top)) return true;
  if (/(^|\/)(\.env(?:$|\.)|\.npmrc$|\.pnpm-store(?:$|\/)|__pycache__(?:$|\/))/.test(lower)) return true;
  if (/\.(?:db|sqlite|sqlite3|amu|pfx|p12|pem|key|crt)$/.test(lower)) return true;
  if (/(^|\/)(?:branding-kits?|customer-branding|kundenbranding)(?:\/|$)/.test(lower)) return true;
  if (/(?:lamprechter|photo[-_ ]?straub|foto[-_ ]?straub|united[-_ ]?camera)/.test(lower)) return true;
  const slash = normalized.indexOf("/");
  if (slash < 0) return !allowedRootFiles.has(normalized);
  return !allowedRootDirectories.has(normalized.slice(0, slash));
}
const expected = new Map();
for (const item of manifest.files) {
  const relative = String(item?.path || "");
  if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative || relative.split("/").includes("..")) fail("Ungueltiger Manifestpfad.");
  if (forbiddenPackagePath(relative)) fail(`Im neutralen Serverpaket ist ein Pfad nicht erlaubt: ${relative}`);
  if (expected.has(relative)) fail("Doppelter Manifestpfad.");
  const candidate = path.resolve(root, ...relative.split("/"));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) fail("Manifestpfad verlaesst das Paket.");
  const stat = fs.statSync(candidate, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size !== Number(item.bytes)) fail(`Manifestdatei fehlt oder hat eine falsche Groesse: ${relative}`);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
  if (hash !== String(item.sha256 || "").toLowerCase()) fail(`Manifestpruefsumme stimmt nicht: ${relative}`);
  expected.set(relative, true);
}
function walk(directory, prefix = "") {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walk(path.join(directory, entry.name), relative));
    else if (entry.isFile() && relative !== "grabenplaner-server-manifest.json") found.push(relative);
    else if (entry.isSymbolicLink()) fail(`Symbolischer Link im Quellpaket: ${relative}`);
  }
  return found;
}
const actual = walk(root);
if (actual.length !== expected.size || actual.some((relative) => !expected.has(relative))) fail("Paketinhalt und Manifestdateiliste stimmen nicht ueberein.");
process.stdout.write(String(manifest.appVersion));
NODE
)" || fail "Die Manifestpruefung ist fehlgeschlagen."
}

validate_installed_dependencies() {
  run_as_build_user "$STAGE_ROOT/source" env NODE_ENV=production HOME="$CACHE_ROOT" "$NODE_EXECUTABLE" - "$STAGE_ROOT/source" <<'NODE' >/dev/null
const path = require("node:path");
const root = process.argv[2];
const metadata = require(path.join(root, "package.json"));
for (const dependency of Object.keys(metadata.dependencies || {})) require.resolve(dependency, { paths: [root] });
require(require.resolve("express", { paths: [root] }));
require(require.resolve("sharp", { paths: [root] }));
require(require.resolve("pdfkit", { paths: [root] }));
process.stdout.write("dependencies-ok");
NODE
}

admin_is_configured() {
  [[ -f "$DATA_ROOT/data/dienstplan.db" ]] || return 1
  runuser -u "$SERVICE_USER" -- "$NODE_EXECUTABLE" - "$DATA_ROOT/data/dienstplan.db" <<'NODE' >/dev/null
const { DatabaseSync } = require("node:sqlite");
let database;
try {
  database = new DatabaseSync(process.argv[2], { readOnly: true });
  const row = database.prepare("SELECT COUNT(*) AS count FROM portal_users WHERE active = 1 AND role IN ('developer','it_admin','admin')").get();
  process.exit(Number(row?.count || 0) > 0 ? 0 : 1);
} catch { process.exit(1); }
finally { try { database?.close(); } catch {} }
NODE
}

wait_for_health() {
  local service=$1 endpoint=$2 attempt
  for attempt in $(seq 1 60); do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:${PORT}/api/health/${endpoint}" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  journalctl -u "$service" --no-pager -n 40 >&2 || true
  return 1
}

wait_for_public_ready() {
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if curl --proto '=https' --tlsv1.2 --fail --silent --show-error --max-time 5 \
      -- "${PUBLIC_URL%/}/api/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  journalctl -u caddy.service --no-pager -n 40 >&2 || true
  journalctl -u grabenplaner.service --no-pager -n 40 >&2 || true
  return 1
}

while (($#)); do
  case "$1" in
    --package) [[ $# -ge 2 ]] || fail "Wert fuer --package fehlt."; PACKAGE_PATH=$2; shift 2 ;;
    --sha256) [[ $# -ge 2 ]] || fail "Wert fuer --sha256 fehlt."; EXPECTED_SHA256=$2; shift 2 ;;
    --sha256-file) [[ $# -ge 2 ]] || fail "Wert fuer --sha256-file fehlt."; SHA256_FILE=$2; shift 2 ;;
    --public-url) [[ $# -ge 2 ]] || fail "Wert fuer --public-url fehlt."; PUBLIC_URL=$2; shift 2 ;;
    --port) [[ $# -ge 2 ]] || fail "Wert fuer --port fehlt."; PORT=$2; shift 2 ;;
    --node) [[ $# -ge 2 ]] || fail "Wert fuer --node fehlt."; NODE_EXECUTABLE=$2; shift 2 ;;
    --replace-caddy-config) REPLACE_CADDY_CONFIG=1; shift ;;
    --no-start) START_AFTER_INSTALL=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unbekannte Option: $1" ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "Der Installer muss mit sudo ausgefuehrt werden."
[[ -n "$PACKAGE_PATH" && -f "$PACKAGE_PATH" ]] || fail "Ein lokales Server-ZIP muss mit --package angegeben werden."
[[ -n "$PUBLIC_URL" ]] || fail "--public-url fehlt."
[[ -z "$EXPECTED_SHA256" || -z "$SHA256_FILE" ]] || fail "Nur --sha256 oder --sha256-file verwenden."
if [[ -n "$SHA256_FILE" ]]; then
  [[ -f "$SHA256_FILE" ]] || fail "Die SHA256-Datei wurde nicht gefunden."
  EXPECTED_SHA256="$(awk 'NR == 1 { print $1 }' "$SHA256_FILE")"
fi
[[ "$EXPECTED_SHA256" =~ ^[A-Fa-f0-9]{64}$ ]] || fail "Eine feste SHA256-Pruefsumme ist erforderlich."
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || fail "--port muss zwischen 1 und 65535 liegen."

for command in awk base64 caddy chmod chown clamscan cp curl date dirname du find getent grep groupadd head id install journalctl ln mktemp mv readlink rm runuser seq sha256sum sleep stat systemctl tr uname unzip useradd usermod wc; do
  need_command "$command"
done
validate_os
if [[ -z "$NODE_EXECUTABLE" ]]; then
  need_command node
  NODE_EXECUTABLE="$(command -v node)"
fi
NODE_EXECUTABLE="$(readlink -f -- "$NODE_EXECUTABLE")"
[[ -x "$NODE_EXECUTABLE" ]] || fail "Das Node.js-Binary ist nicht ausfuehrbar."
validate_node_version
CLAMSCAN_EXECUTABLE="$(readlink -f -- "$(command -v clamscan)")"
validate_public_url

install -d -o root -g root -m 0755 "$APP_PARENT"
STAGE_ROOT="$(mktemp -d "$APP_PARENT/.install.XXXXXX")"
chmod 0700 "$STAGE_ROOT"
install -o root -g root -m 0600 "$PACKAGE_PATH" "$STAGE_ROOT/package.zip"
PACKAGE_PATH="$STAGE_ROOT/package.zip"
[[ "$(stat -c %s -- "$PACKAGE_PATH")" -le "$MAX_ARCHIVE_BYTES" ]] || fail "Das Serverpaket ist groesser als 2 GiB."
ACTUAL_SHA256="$(sha256sum -- "$PACKAGE_PATH" | awk '{ print $1 }')"
[[ "${ACTUAL_SHA256,,}" == "${EXPECTED_SHA256,,}" ]] || fail "Die SHA256-Pruefsumme des Serverpakets stimmt nicht."
validate_zip_entries

[[ -f "$SCRIPT_DIR/grabenplaner.service.in" && -f "$SCRIPT_DIR/grabenplaner-bootstrap.service.in" \
  && -f "$SCRIPT_DIR/grabenplaner-monitor.service.in" && -f "$SCRIPT_DIR/grabenplaner-monitor.timer.in" \
  && -f "$SCRIPT_DIR/Caddyfile.in" && -f "$SCRIPT_DIR/grabenplaner.env.example" \
  && -f "$SCRIPT_DIR/grabenplaner-bootstrap-admin.sh.in" ]] || fail "Die Linux-Laufzeitvorlagen sind unvollstaendig."
if [[ -s "$CADDY_CONFIG" ]] && ! caddy_config_is_managed; then
  [[ $REPLACE_CADDY_CONFIG -eq 1 ]] || fail "Die vorhandene Caddy-Konfiguration wird nicht von Grabenplaner verwaltet. Fuer einen dedizierten Server ist --replace-caddy-config erforderlich."
fi
systemctl cat caddy.service >/dev/null 2>&1 || fail "Der installierte Caddy-systemd-Dienst fehlt."
id caddy >/dev/null 2>&1 || fail "Der Systembenutzer caddy fehlt."
[[ ! -e "$APP_ROOT" ]] || fail "Grabenplaner ist bereits installiert. Fuer bestehende Installationen grabenplaner-update verwenden."

getent group "$SERVICE_GROUP" >/dev/null 2>&1 || groupadd --system "$SERVICE_GROUP"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
[[ "$(id -gn "$SERVICE_USER")" == "$SERVICE_GROUP" ]] || fail "Der bestehende Benutzer grabenplaner verwendet eine unerwartete Hauptgruppe."
getent group "$MONITOR_STATUS_GROUP" >/dev/null 2>&1 || groupadd --system "$MONITOR_STATUS_GROUP"
if ! id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -Fxq "$MONITOR_STATUS_GROUP"; then
  usermod --append --groups "$MONITOR_STATUS_GROUP" "$SERVICE_USER"
fi
id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -Fxq "$MONITOR_STATUS_GROUP" \
  || fail "Der App-Benutzer konnte nicht lesend der Monitor-Statusgruppe zugeordnet werden."
getent group "$BUILD_GROUP" >/dev/null 2>&1 || groupadd --system "$BUILD_GROUP"
if ! id "$BUILD_USER" >/dev/null 2>&1; then
  useradd --system --gid "$BUILD_GROUP" --home-dir "$CACHE_ROOT" --shell /usr/sbin/nologin "$BUILD_USER"
fi
[[ "$(id -gn "$BUILD_USER")" == "$BUILD_GROUP" ]] || fail "Der bestehende Build-Benutzer verwendet eine unerwartete Hauptgruppe."

install -d -o root -g root -m 0755 "$APP_PARENT" "$LOG_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 \
  "$DATA_ROOT" "$DATA_ROOT/data" "$DATA_ROOT/private" "$DATA_ROOT/branding-kits" "$DATA_ROOT/backups" \
  "$BACKUP_ROOT" "$LOG_ROOT/app"
install -d -o "$BUILD_USER" -g "$BUILD_GROUP" -m 0750 "$CACHE_ROOT" "$CACHE_ROOT/pnpm" "$CACHE_ROOT/corepack"
install -d -o caddy -g caddy -m 0750 "$LOG_ROOT/caddy"
install -d -o root -g root -m 0700 "$CONFIG_ROOT"
if [[ -e "$MONITOR_STATUS_ROOT" || -L "$MONITOR_STATUS_ROOT" ]]; then
  [[ -d "$MONITOR_STATUS_ROOT" && ! -L "$MONITOR_STATUS_ROOT" ]] \
    || fail "Der Monitorstatuspfad ist kein sicherer lokaler Ordner."
fi
install -d -o root -g "$MONITOR_STATUS_GROUP" -m 0750 "$MONITOR_STATUS_ROOT"

if [[ ! -f "$ENV_FILE" ]]; then
  AMU_KEY="$(random_base64 32)"
  INTEGRATION_KEY="$(random_base64 32)"
  WIFI_IDENTITY_KEY="$(random_base64 32)"
  WIFI_WEBHOOK_SECRET="$(random_base64 48)"
  SERVICE_CONTROL_TOKEN="$(random_base64 48)"
  BOOTSTRAP_TOKEN="$(random_base64 32)"
  ENV_TEMP="$(mktemp "$CONFIG_ROOT/.grabenplaner.env.XXXXXX")"
  chmod 0600 "$ENV_TEMP"
  render_template "$SCRIPT_DIR/grabenplaner.env.example" "$ENV_TEMP"
  mv -- "$ENV_TEMP" "$ENV_FILE"
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  unset AMU_KEY INTEGRATION_KEY WIFI_IDENTITY_KEY WIFI_WEBHOOK_SECRET SERVICE_CONTROL_TOKEN BOOTSTRAP_TOKEN
else
  [[ "$(stat -c %a "$ENV_FILE")" == "600" && "$(stat -c %U:%G "$ENV_FILE")" == "root:root" ]] \
    || fail "Die bestehende Umgebungsdatei muss root:root gehoeren und Modus 0600 haben."
  require_environment_value NODE_ENV production
  require_environment_value GRABENPLANER_OPERATION_MODE server
  require_environment_value GRABENPLANER_DEPLOYMENT_KIND production
  require_environment_value GRABENPLANER_PUBLIC_URL "$PUBLIC_URL"
  require_environment_value GRABENPLANER_HOST 127.0.0.1
  require_environment_value GRABENPLANER_TRUST_PROXY loopback
  require_environment_value PORT "$PORT"
  require_environment_value GRABENPLANER_DATA_DIR "$DATA_ROOT"
  require_environment_value DB_PATH "$DATA_ROOT/data/dienstplan.db"
  require_environment_value BACKUP_DIR "$BACKUP_ROOT"
  validate_secret_bytes GRABENPLANER_AMU_KEY 32
  validate_secret_bytes GRABENPLANER_INTEGRATION_KEY 32
  validate_secret_bytes GRABENPLANER_WIFI_IDENTITY_KEY 32
  validate_secret_bytes GRABENPLANER_WIFI_WEBHOOK_SECRET 48
  [[ "$(environment_value GRABENPLANER_SERVICE_CONTROL_TOKEN | wc -c)" -ge 32 ]] || fail "Der Dienststeuerungs-Token ist zu kurz."
  validate_secret_bytes GRABENPLANER_BOOTSTRAP_TOKEN 32
fi

SCANNER_PROBE="$(mktemp "$DATA_ROOT/private/.scanner-probe.XXXXXX")"
printf '%s\n' 'Grabenplaner ClamAV readiness probe' >"$SCANNER_PROBE"
chown "$SERVICE_USER:$SERVICE_GROUP" "$SCANNER_PROBE"
chmod 0600 "$SCANNER_PROBE"
if ! runuser -u "$SERVICE_USER" -- "$CLAMSCAN_EXECUTABLE" --no-summary -- "$SCANNER_PROBE" >/dev/null; then
  rm -f -- "$SCANNER_PROBE"
  fail "ClamAV konnte den sauberen Preflight nicht erfolgreich pruefen."
fi
rm -f -- "$SCANNER_PROBE"

chown root:"$BUILD_GROUP" "$STAGE_ROOT"
chmod 0750 "$STAGE_ROOT"
chown root:"$BUILD_GROUP" "$STAGE_ROOT/package.zip"
chmod 0640 "$STAGE_ROOT/package.zip"
install -d -o "$BUILD_USER" -g "$BUILD_GROUP" -m 0750 "$STAGE_ROOT/source"
install -d -o "$BUILD_USER" -g "$BUILD_GROUP" -m 0700 "$STAGE_ROOT/pnpm-store"
run_as_build_user "$STAGE_ROOT/source" unzip -q "$STAGE_ROOT/package.zip" -d "$STAGE_ROOT/source"
[[ -z "$(find "$STAGE_ROOT/source" ! -type f ! -type d -print -quit)" ]] || fail "Links und Spezialdateien sind im Quellpaket nicht erlaubt."
[[ "$(du -sb "$STAGE_ROOT/source" | awk '{ print $1 }')" -le "$MAX_EXTRACTED_BYTES" ]] || fail "Das entpackte Serverpaket ist groesser als 4 GiB."
[[ -f "$STAGE_ROOT/source/$MANIFEST_NAME" ]] || fail "Das Serverpaket-Manifest fehlt in der Archivwurzel."
validate_manifest
normalize_verified_archive_modes "$STAGE_ROOT/source"
resolve_pnpm

chown -R "$BUILD_USER:$BUILD_GROUP" "$STAGE_ROOT/source"
run_as_build_user "$STAGE_ROOT/source" env \
  HOME="$CACHE_ROOT" XDG_CACHE_HOME="$CACHE_ROOT" PNPM_HOME="$CACHE_ROOT/pnpm" COREPACK_HOME="$CACHE_ROOT/corepack" \
  PATH="$(dirname "$NODE_EXECUTABLE"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  NODE_ENV=production "${PNPM_COMMAND[@]}" install --prod --frozen-lockfile --config.node-linker=hoisted \
    --store-dir "$STAGE_ROOT/pnpm-store" --package-import-method=copy --reporter=append-only
run_as_build_user "$STAGE_ROOT/source" "$NODE_EXECUTABLE" --check "$STAGE_ROOT/source/server.js" >/dev/null
validate_installed_dependencies

# pnpm may create internal links; every resulting target must stay inside the app.
run_as_build_user "$STAGE_ROOT/source" "$NODE_EXECUTABLE" - "$STAGE_ROOT/source" <<'NODE' >/dev/null
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.argv[2]);
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(candidate);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) process.exit(1);
    } else if (entry.isDirectory()) walk(candidate);
    else if (entry.isFile() && fs.lstatSync(candidate).nlink !== 1) process.exit(1);
  }
}
walk(root);
NODE

chown -hR root:"$SERVICE_GROUP" "$STAGE_ROOT/source"
chmod -R o-rwx "$STAGE_ROOT/source"
find "$STAGE_ROOT/source" -type d -exec chmod 0750 {} +
find "$STAGE_ROOT/source" -type f -perm /111 -exec chmod 0750 {} +
find "$STAGE_ROOT/source" -type f ! -perm /111 -exec chmod 0640 {} +
[[ -x "$STAGE_ROOT/source/server-tools/linux/monitor/run-grabenplaner-monitor.sh" ]] \
  || fail "Das freigegebene Monitorwerkzeug ist nach der Berechtigungssetzung nicht ausfuehrbar."

systemctl disable --now grabenplaner-monitor.timer grabenplaner-monitor.service >/dev/null 2>&1 || true
systemctl stop grabenplaner-bootstrap.service grabenplaner.service >/dev/null 2>&1 || true
mv -- "$STAGE_ROOT/source" "$APP_ROOT"
APP_SWAPPED=1

monitor_status_gid="$(getent group "$MONITOR_STATUS_GROUP" | awk -F: '{print $3}')"
[[ "$monitor_status_gid" =~ ^[0-9]+$ ]] || fail "Die Monitor-Statusgruppe konnte nicht sicher aufgeloest werden."
monitor_status_helper="$APP_ROOT/server-tools/linux/monitor/lib/monitor-status.js"
[[ -f "$monitor_status_helper" && ! -L "$monitor_status_helper" ]] || fail "Der Monitorstatus-Helfer fehlt im installierten Paket."
"$NODE_EXECUTABLE" "$monitor_status_helper" --status-file "$MONITOR_STATUS_FILE" --status-gid "$monitor_status_gid" initialize >/dev/null

UNIT_TEMP="$(mktemp)"
render_template "$SCRIPT_DIR/grabenplaner.service.in" "$UNIT_TEMP"
APP_UNIT_WRITTEN=1
install -o root -g root -m 0644 "$UNIT_TEMP" "$APP_UNIT"
render_template "$SCRIPT_DIR/grabenplaner-bootstrap.service.in" "$UNIT_TEMP"
BOOTSTRAP_UNIT_WRITTEN=1
install -o root -g root -m 0644 "$UNIT_TEMP" "$BOOTSTRAP_UNIT"
render_template "$SCRIPT_DIR/grabenplaner-monitor.service.in" "$UNIT_TEMP"
MONITOR_UNIT_WRITTEN=1
install -o root -g root -m 0644 "$UNIT_TEMP" "$MONITOR_UNIT"
render_template "$SCRIPT_DIR/grabenplaner-monitor.timer.in" "$UNIT_TEMP"
MONITOR_TIMER_WRITTEN=1
install -o root -g root -m 0644 "$UNIT_TEMP" "$MONITOR_TIMER"
render_template "$SCRIPT_DIR/grabenplaner-bootstrap-admin.sh.in" "$UNIT_TEMP"
BOOTSTRAP_COMMAND_WRITTEN=1
install -o root -g root -m 0750 "$UNIT_TEMP" "$BOOTSTRAP_COMMAND"
render_template "$SCRIPT_DIR/Caddyfile.in" "$UNIT_TEMP"
caddy validate --config "$UNIT_TEMP" --adapter caddyfile >/dev/null
capture_caddy_service_state
if [[ -s "$CADDY_CONFIG" ]]; then
  install -d -o root -g root -m 0700 "$CONFIG_ROOT/caddy-backup"
  CADDY_CONFIG_BACKUP="${CONFIG_ROOT}/caddy-backup/Caddyfile.pre-grabenplaner.$(date -u +%Y%m%dT%H%M%SZ)"
  cp --preserve=mode,timestamps,ownership -- "$CADDY_CONFIG" "$CADDY_CONFIG_BACKUP"
  CADDY_CONFIG_REPLACED=1
fi
CADDY_CONFIG_WRITTEN=1
install -o root -g root -m 0644 "$UNIT_TEMP" "$CADDY_CONFIG"
rm -f -- "$UNIT_TEMP"
UNIT_TEMP=""
systemctl daemon-reload

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$APP_UNIT" "$BOOTSTRAP_UNIT" "$MONITOR_UNIT" "$MONITOR_TIMER" >/dev/null
fi

if [[ $START_AFTER_INSTALL -eq 1 ]]; then
  if admin_is_configured; then
    systemctl enable grabenplaner.service >/dev/null
    systemctl restart grabenplaner.service
    wait_for_health grabenplaner.service ready || fail "Die Produktions-Bereitschaftspruefung ist nicht gruen."
    systemctl enable caddy.service >/dev/null
    systemctl restart caddy.service
    wait_for_public_ready || fail "Die oeffentliche HTTPS-Bereitschaftspruefung ist nicht gruen."
    systemctl enable --now grabenplaner-monitor.timer >/dev/null
    printf 'Grabenplaner %s wurde installiert und als HTTPS-Dienst gestartet.\n' "$APP_VERSION"
  else
    printf 'Grabenplaner %s wurde installiert.\n\n' "$APP_VERSION"
    "$BOOTSTRAP_COMMAND" start
  fi
else
  systemctl disable --now grabenplaner-monitor.timer grabenplaner-monitor.service \
    grabenplaner-bootstrap.service grabenplaner.service caddy.service >/dev/null 2>&1 || true
  printf 'Grabenplaner %s wurde installiert; die Dienste wurden nicht gestartet.\n' "$APP_VERSION"
fi

command_names=(backup monitor stop test update uninstall)
command_files=(backup-grabenplaner.sh monitor/run-grabenplaner-monitor.sh stop-grabenplaner-server.sh test-grabenplaner-server.sh update-grabenplaner-server.sh uninstall-grabenplaner-server.sh)
for index in "${!command_names[@]}"; do
  command_name="${command_names[$index]}"
  command_source="${APP_ROOT}/server-tools/linux/${command_files[$index]}"
  [[ -f "$command_source" && ! -L "$command_source" ]] \
    || fail "Installiertes Wartungsskript fehlt oder ist kein regulaeres App-Artefakt: $command_source"
  ln -sfn -- "$command_source" "/usr/local/sbin/grabenplaner-${command_name}"
done

# A successful installation no longer needs automatic cleanup.
APP_SWAPPED=0
if [[ -n "$CADDY_CONFIG_BACKUP" ]]; then
  printf 'Die vorherige Caddy-Konfiguration wurde root-only gesichert: %s\n' "$CADDY_CONFIG_BACKUP"
fi

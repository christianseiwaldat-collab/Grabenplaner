"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("v0.72 Linux package: source archive keeps the updater manifest contract", () => {
  const builder = read("server-tools", "package", "New-GrabenplanerLinuxServerPackage.ps1");

  assert.match(builder, /format = 'grabenplaner-server-package'/);
  assert.match(builder, /schemaVersion = 1/);
  assert.match(builder, /platform = 'linux'/);
  assert.match(builder, /architecture = 'x64'/);
  assert.match(builder, /dependenciesMode = 'source-install'/);
  assert.match(builder, /minimumNode = \$minimumNode/);
  assert.match(builder, /packageManager = \$packageManager/);
  assert.match(builder, /nodeRuntimeIncluded = \$false/);
  assert.match(builder, /files = \$manifestFiles/);
  assert.match(builder, /grabenplaner-server-manifest\.json/);
  assert.match(builder, /linux-x64\.zip/);
  assert.match(builder, /\.sha256/);
});

test("v0.72 Linux package: only neutral tracked source files can enter the archive", () => {
  const builder = read("server-tools", "package", "New-GrabenplanerLinuxServerPackage.ps1");

  assert.match(builder, /git -C \$sourceRoot status --porcelain --untracked-files=all/);
  assert.match(builder, /git -C \$sourceRoot ls-files/);
  assert.match(builder, /sauberen Git-Arbeitsbaum/);
  assert.match(builder, /'node_modules'.*'output'.*'release'.*'runtime'/s);
  assert.match(builder, /\.env\(\$\|\\\.\)/);
  assert.match(builder, /db\|sqlite\|sqlite3\|amu\|pfx\|p12\|pem\|key\|crt/);
  assert.match(builder, /branding-kits\?/);
  assert.match(builder, /lamprechter\|photo-\?straub\|foto-\?straub\|united-\?camera/);
  assert.match(builder, /StartsWith\('lib\/'\)/);
  assert.match(builder, /StartsWith\('public\/'\)/);
  assert.match(builder, /StartsWith\('server-tools\/'\)/);
  assert.doesNotMatch(builder, /pnpm[^\n]+install/);
});

test("v0.72 Linux package: ZIP output is reproducible and roundtrip-verified", () => {
  const builder = read("server-tools", "package", "New-GrabenplanerLinuxServerPackage.ps1");

  assert.match(builder, /Write-DeterministicZip/);
  assert.match(builder, /1980, 1, 1/);
  assert.match(builder, /Sort-Object/);
  assert.match(builder, /ExtractToDirectory/);
  assert.match(builder, /Manifestpruefsumme stimmt nicht/);
  assert.match(builder, /function Get-Sha256File/);
  assert.match(builder, /Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(builder, /Get-FileHash/);
  assert.match(builder, /GetTempPath\(\).*GrabenplanerLinuxServerPackage/s);
  assert.match(builder, /if \(\$archiveOwned\).*Remove-Item -LiteralPath \$archivePath/s);
});

test("v0.72 Linux server documentation recommends Ubuntu without removing Windows", () => {
  const documentation = read("SERVERBETRIEB.md");

  assert.match(documentation, /Ubuntu 26\.04 LTS/);
  assert.match(documentation, /systemd/);
  assert.match(documentation, /ClamAV/);
  assert.match(documentation, /pnpm install --prod --frozen-lockfile --config\.node-linker=hoisted/);
  assert.match(documentation, /New-GrabenplanerLinuxServerPackage\.ps1/);
  assert.match(documentation, /Zielaufbau unter Windows/);
  assert.match(documentation, /WinSW/);
});

test("Linux environment template prepares Scaleway TEM fail-closed without credentials", () => {
  const environment = read("server-tools", "linux", "grabenplaner.env.example");

  assert.match(environment, /^# GRABENPLANER_EMAIL_PROVIDER=scaleway-tem$/m);
  assert.match(environment, /^# GRABENPLANER_EMAIL_FROM=Grabenplaner <benachrichtigung@grabenplaner\.eu>$/m);
  assert.match(environment, /^# GRABENPLANER_SCALEWAY_TEM_PROJECT_ID=<Scaleway-Projekt-ID>$/m);
  assert.match(environment, /^# GRABENPLANER_SCALEWAY_TEM_SECRET_KEY=<eingeschraenkter TEM-API-Schluessel>$/m);
  assert.match(environment, /^# GRABENPLANER_EMAIL_SENDER_APPROVED=0$/m);
  assert.match(environment, /^# GRABENPLANER_EMAIL_DISPATCH_ENABLED=0$/m);
  assert.match(environment, /^# GRABENPLANER_EMAIL_ALLOWED_EVENTS=$/m);
  assert.match(environment, /^# GRABENPLANER_SMS_SENDER_APPROVED=0$/m);
  assert.match(environment, /^# GRABENPLANER_SMS_DISPATCH_ENABLED=0$/m);
  assert.match(environment, /^# GRABENPLANER_SMS_ALLOWED_EVENTS=$/m);
  assert.match(environment, /^# GRABENPLANER_WHATSAPP_SENDER_APPROVED=0$/m);
  assert.match(environment, /^# GRABENPLANER_WHATSAPP_DISPATCH_ENABLED=0$/m);
  assert.match(environment, /^# GRABENPLANER_WHATSAPP_ALLOWED_EVENTS=$/m);
  assert.doesNotMatch(
    environment,
    /^GRABENPLANER_(?:EMAIL_PROVIDER|EMAIL_FROM|SCALEWAY_TEM_PROJECT_ID|SCALEWAY_TEM_SECRET_KEY|EMAIL_SENDER_APPROVED|EMAIL_DISPATCH_ENABLED|EMAIL_ALLOWED_EVENTS|SMS_SENDER_APPROVED|SMS_DISPATCH_ENABLED|SMS_ALLOWED_EVENTS|WHATSAPP_SENDER_APPROVED|WHATSAPP_DISPATCH_ENABLED|WHATSAPP_ALLOWED_EVENTS)=/m,
  );
});

test("v0.72 Linux bootstrap stays private until public HTTPS readiness succeeds", () => {
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  const updater = read("server-tools", "linux", "update-grabenplaner-server.sh");
  const bootstrap = read("server-tools", "linux", "grabenplaner-bootstrap-admin.sh.in");
  const bootstrapUnit = read("server-tools", "linux", "grabenplaner-bootstrap.service.in");
  const normalUnit = read("server-tools", "linux", "grabenplaner.service.in");
  const environment = read("server-tools", "linux", "grabenplaner.env.example");
  const caddy = read("server-tools", "linux", "Caddyfile.in");

  assert.match(environment, /^GRABENPLANER_BOOTSTRAP_TOKEN=\{\{BOOTSTRAP_TOKEN\}\}$/m);
  assert.match(bootstrapUnit, /^Environment=GRABENPLANER_BOOTSTRAP_MODE=1$/m);
  assert.match(bootstrapUnit, /^Environment=GRABENPLANER_OPERATION_MODE=server$/m);
  assert.doesNotMatch(bootstrapUnit, /^Environment=GRABENPLANER_PUBLIC_URL=/m);
  assert.match(bootstrapUnit, /^Conflicts=grabenplaner\.service caddy\.service$/m);
  assert.doesNotMatch(normalUnit, /GRABENPLANER_BOOTSTRAP_MODE/);
  assert.match(bootstrap, /http:\/\/127\.0\.0\.1:\{\{PORT\}\}\/\?bootstrap=\$\{encoded_token\}/);
  assert.match(bootstrap, /wait_for_public_ready/);
  assert.match(bootstrap, /clear_bootstrap_token/);
  assert.match(bootstrap, /recover_to_bootstrap/);
  assert.ok(bootstrap.indexOf("if ! wait_for_public_ready") < bootstrap.indexOf("if ! clear_bootstrap_token"));
  assert.match(installer, /wait_for_public_ready \|\| fail/);
  assert.match(installer, /install -d -o "\$BUILD_USER" -g "\$BUILD_GROUP" -m 0700 "\$STAGE_ROOT\/pnpm-store"/);
  assert.match(installer, /run_as_build_user "\$STAGE_ROOT\/source" env[\s\S]+"\$\{PNPM_COMMAND\[@\]\}" install --prod --frozen-lockfile[\s\S]+--store-dir "\$STAGE_ROOT\/pnpm-store" --package-import-method=copy/);
  assert.doesNotMatch(installer, /"\$\{PNPM_COMMAND\[@\]\}" --dir/);
  assert.doesNotMatch(installer, /--store-dir "\$CACHE_ROOT/);
  assert.match(installer, /entry\.isFile\(\) && fs\.lstatSync\(candidate\)\.nlink !== 1/);
  assert.match(updater, /pnpm_store="\$maintenance_root\/pnpm-store"/);
  assert.match(updater, /install -d -m 0700 -o "\$build_user" -g "\$build_group" -- "\$pnpm_store"/);
  assert.match(updater, /--store-dir "\$pnpm_store" --package-import-method=copy/);
  assert.doesNotMatch(updater, /--store-dir "\$build_cache/);
  assert.match(installer, /IFS= read -r first_line/);
  assert.match(installer, /CADDY_CONFIG_WRITTEN=1\r?\ninstall/);
  assert.match(caddy, /path_regexp serviceStopPath \(\?i\)\^\/api\/service\/stop/);
});

test("v0.72 Linux install-tree verification rejects hardlinked package files", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-install-tree-hardlink-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source.txt");
  const hardlink = path.join(temporary, "linked.txt");
  fs.writeFileSync(source, "shared-inode\n");
  fs.linkSync(source, hardlink);
  assert.equal(fs.statSync(source).ino, fs.statSync(hardlink).ino);
  assert.equal(fs.statSync(source).nlink, 2);

  const verifier = path.join(root, "server-tools", "linux", "lib", "verify-install-tree.js");
  const rejected = spawnSync(process.execPath, [verifier, temporary], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0, "Ein geteilter Store-/Installations-Inode muss abgelehnt werden.");
  assert.match(rejected.stderr, /Hardlink im Installationsbaum/);

  fs.unlinkSync(hardlink);
  const accepted = spawnSync(process.execPath, [verifier, temporary], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("v0.72 Linux installer moves build commands out of an unreadable caller directory", {
  skip: process.platform !== "linux",
}, (context) => {
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  const helper = installer.match(/^run_as_build_user\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(helper, "Build-User-Helfer wurde nicht gefunden.");
  assert.equal((installer.match(/runuser -u "\$BUILD_USER"/g) || []).length, 1,
    "Alle Build-User-Schritte muessen ueber den CWD-sicheren Helfer laufen.");

  const sudo = process.getuid?.() === 0 ? null : "sudo";
  if (sudo) {
    const probe = spawnSync(sudo, ["-n", "true"], { encoding: "utf8" });
    if (probe.status !== 0) {
      context.skip("Passwordless sudo is unavailable for the unreadable-CWD fixture.");
      return;
    }
  }

  const script = `
set -Eeuo pipefail
BUILD_USER=nobody
${helper}
base="$(mktemp -d /tmp/grabenplaner-build-cwd.XXXXXXXX)"
trap 'chmod 0755 -- "$base/caller" 2>/dev/null || true; rm -rf -- "$base"' EXIT
chmod 0755 -- "$base"
install -d -m 0700 -- "$base/caller"
install -d -m 0755 -- "$base/staging-source"
cd -- "$base/caller"
if runuser -u "$BUILD_USER" -- "${process.execPath}" -e 'require("node:fs").readdirSync(".")' >/dev/null 2>&1; then
  echo "Direkter Build-Aufruf konnte den gesperrten Aufruferordner unerwartet lesen." >&2
  exit 21
fi
run_as_build_user "$base/staging-source" "${process.execPath}" -e \
  'const fs=require("node:fs"); fs.readdirSync("."); if(process.cwd()!==process.argv[1]) process.exit(22)' \
  "$base/staging-source"
`;
  const command = sudo || "bash";
  const args = sudo ? ["-n", "bash", "-s"] : ["-s"];
  const result = spawnSync(command, args, {
    input: script,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("v0.72 Linux installer restores trusted shell modes after ZIP extraction", {
  skip: process.platform !== "linux",
}, (context) => {
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  const helper = installer.match(/^normalize_verified_archive_modes\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(helper, "Helfer fuer vertrauenswuerdige Linux-Ausfuehrungsrechte wurde nicht gefunden.");
  assert.match(helper, /server-tools\/linux/);
  assert.match(helper, /-type f -name '\*\.sh'/);
  assert.match(helper, /find "\$source_root" -type f -exec chmod 0640/);
  assert.doesNotMatch(helper, /-perm \/111/);
  assert.doesNotMatch(helper, /find "\$source_root" -type f -name '\*\.sh'/);
  assert.match(installer, /validate_manifest\r?\nnormalize_verified_archive_modes "\$STAGE_ROOT\/source"\r?\nresolve_pnpm/);
  assert.match(installer, /NODE_ENV=production "\$\{PNPM_COMMAND\[@\]\}" install[\s\S]+find "\$STAGE_ROOT\/source" -type f -perm \/111 -exec chmod 0750/);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-linux-zip-modes-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source");
  const extracted = path.join(temporary, "extracted");
  const trustedScript = path.join(source, "server-tools", "linux", "monitor", "run-grabenplaner-monitor.sh");
  const untrustedScript = path.join(source, "public", "untrusted.sh");
  fs.mkdirSync(path.dirname(trustedScript), { recursive: true });
  fs.mkdirSync(path.dirname(untrustedScript), { recursive: true });
  fs.writeFileSync(trustedScript, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o644 });
  fs.writeFileSync(untrustedScript, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o644 });
  fs.chmodSync(trustedScript, 0o644);
  fs.chmodSync(untrustedScript, 0o755);

  const archive = path.join(temporary, "windows-like.zip");
  const zip = spawnSync("zip", ["-q", "-r", archive, "."], { cwd: source, encoding: "utf8" });
  assert.equal(zip.status, 0, zip.stderr || zip.error?.message);
  fs.mkdirSync(extracted);
  const unzip = spawnSync("unzip", ["-q", archive, "-d", extracted], { encoding: "utf8" });
  assert.equal(unzip.status, 0, unzip.stderr || unzip.error?.message);
  const extractedTrusted = path.join(extracted, "server-tools", "linux", "monitor", "run-grabenplaner-monitor.sh");
  const extractedUntrusted = path.join(extracted, "public", "untrusted.sh");
  assert.equal(fs.statSync(extractedTrusted).mode & 0o111, 0, "ZIP-Fixture muss ohne Unix-Execute-Bits ankommen.");
  assert.notEqual(fs.statSync(extractedUntrusted).mode & 0o111, 0, "ZIP-Fixture muss auch ein nicht freigegebenes Execute-Bit abbilden.");

  const script = `
set -Eeuo pipefail
fail() { echo "$*" >&2; exit 1; }
${helper}
normalize_verified_archive_modes "$1"
`;
  const result = spawnSync("bash", ["-s", "--", extracted], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.notEqual(fs.statSync(extractedTrusted).mode & 0o111, 0, "Verifiziertes Linux-Shellwerkzeug muss ausfuehrbar werden.");
  assert.equal(fs.statSync(extractedUntrusted).mode & 0o111, 0, "Shell-Dateien ausserhalb des engen Linux-Werkzeugpfads bleiben nicht ausfuehrbar.");
});

test("v0.72 failed install keeps a previously inactive Caddy service inactive", {
  skip: process.platform !== "linux",
}, (context) => {
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  const capture = installer.match(/^capture_caddy_service_state\(\) \{[\s\S]*?^\}/m)?.[0];
  const restore = installer.match(/^restore_caddy_service_state\(\) \{[\s\S]*?^\}/m)?.[0];
  const rollback = installer.match(/^rollback_caddy_configuration\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(capture && restore && rollback, "Caddy-Rollback-Helfer wurden nicht gefunden.");
  assert.match(installer, /capture_caddy_service_state\r?\nif \[\[ -s "\$CADDY_CONFIG" \]\]/);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-caddy-rollback-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const current = path.join(temporary, "Caddyfile");
  const backup = path.join(temporary, "Caddyfile.backup");
  const calls = path.join(temporary, "systemctl.log");
  fs.writeFileSync(current, "managed\n");
  fs.writeFileSync(backup, "original\n");

  const script = `
set -Eeuo pipefail
CADDY_CONFIG="$1"
CADDY_CONFIG_BACKUP="$2"
SYSTEMCTL_LOG="$3"
CADDY_CONFIG_REPLACED=1
CADDY_CONFIG_WRITTEN=1
CADDY_SERVICE_STATE_CAPTURED=0
CADDY_WAS_ACTIVE=1
CADDY_WAS_ENABLED=1
caddy_config_is_managed() { return 0; }
systemctl() {
  case "$1" in
    is-active|is-enabled) return 1 ;;
    *) printf '%s\n' "$*" >>"$SYSTEMCTL_LOG" ;;
  esac
}
${capture}
${restore}
${rollback}
capture_caddy_service_state
rollback_caddy_configuration
`;
  const result = spawnSync("bash", ["-s", "--", current, backup, calls], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(current, "utf8"), "original\n");
  const serviceCalls = fs.readFileSync(calls, "utf8");
  assert.match(serviceCalls, /^stop caddy\.service$/m);
  assert.match(serviceCalls, /^disable caddy\.service$/m);
  assert.doesNotMatch(serviceCalls, /^(?:start|restart|enable) caddy\.service$/m);
});

test("v0.72 Linux installer requires every trusted maintenance verifier", () => {
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  for (const required of [
    "lib/amu-storage.js",
    "lib/backup-commit.js",
    "server-tools/linux/lib/common.sh",
    "server-tools/linux/lib/backup-snapshot.js",
    "server-tools/linux/lib/hold-database-lock.js",
    "server-tools/linux/lib/prune-backups.js",
    "server-tools/linux/lib/restore-backup.js",
    "server-tools/linux/lib/verify-backup.js",
    "server-tools/linux/lib/verify-install-tree.js",
    "server-tools/linux/lib/verify-package.js",
  ]) {
    assert.match(installer, new RegExp(required.replaceAll(".", "\\.")));
  }
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

test("v0.72 Linux bootstrap stays private until public HTTPS readiness succeeds", () => {
  const installer = read("server-tools", "linux", "install-grabenplaner-server.sh");
  const bootstrap = read("server-tools", "linux", "grabenplaner-bootstrap-admin.sh.in");
  const environment = read("server-tools", "linux", "grabenplaner.env.example");
  const caddy = read("server-tools", "linux", "Caddyfile.in");

  assert.match(environment, /^GRABENPLANER_BOOTSTRAP_TOKEN=\{\{BOOTSTRAP_TOKEN\}\}$/m);
  assert.match(bootstrap, /http:\/\/127\.0\.0\.1:\{\{PORT\}\}\/\?bootstrap=\$\{encoded_token\}/);
  assert.match(bootstrap, /wait_for_public_ready/);
  assert.match(bootstrap, /clear_bootstrap_token/);
  assert.match(bootstrap, /recover_to_bootstrap/);
  assert.ok(bootstrap.indexOf("if ! wait_for_public_ready") < bootstrap.indexOf("if ! clear_bootstrap_token"));
  assert.match(installer, /wait_for_public_ready \|\| fail/);
  assert.match(installer, /run_as_build_user "\$STAGE_ROOT\/source" env[\s\S]+"\$\{PNPM_COMMAND\[@\]\}" install --prod --frozen-lockfile/);
  assert.doesNotMatch(installer, /"\$\{PNPM_COMMAND\[@\]\}" --dir/);
  assert.match(installer, /IFS= read -r first_line/);
  assert.match(installer, /CADDY_CONFIG_WRITTEN=1\r?\ninstall/);
  assert.match(caddy, /path_regexp serviceStopPath \(\?i\)\^\/api\/service\/stop/);
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

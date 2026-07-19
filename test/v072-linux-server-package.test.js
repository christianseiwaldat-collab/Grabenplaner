"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
  assert.match(builder, /Get-FileHash[^\n]+SHA256/);
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

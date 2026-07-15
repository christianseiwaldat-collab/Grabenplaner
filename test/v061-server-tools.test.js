"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("v0.61 server tools: Caddy and WinSW use production-safe identities and health probes", () => {
  const caddy = read("server-tools", "caddy", "Caddyfile.example");
  const appService = read("server-tools", "windows", "Grabenplaner.Service.xml.example");
  const proxyService = read("server-tools", "windows", "Caddy.Service.xml.example");
  const environment = read("server-tools", "server.env.example");

  assert.match(caddy, /\badmin off\b/);
  assert.match(caddy, /health_uri \/api\/health\/live/);
  assert.match(appService, /<stoptimeout>1(?:[0-9]{2,}|[2-9][0-9]) sec<\/stoptimeout>/);
  assert.match(proxyService, /<stoptimeout>1(?:[0-9]{2,}|[2-9][0-9]) sec<\/stoptimeout>/);
  assert.match(appService, /<user>LOCAL SERVICE<\/user>/);
  assert.match(proxyService, /<user>NETWORK SERVICE<\/user>/);
  assert.match(proxyService, /XDG_CONFIG_HOME/);
  assert.match(proxyService, /XDG_DATA_HOME/);
  assert.match(appService, /GRABENPLANER_DEPLOYMENT_KIND" value="production/);
  assert.match(environment, /^GRABENPLANER_DEPLOYMENT_KIND=production$/m);
});

test("v0.61 server tools: installer separates app secrets from the proxy and requires a scanner", () => {
  const installer = read("server-tools", "windows", "Install-GrabenplanerServer.ps1");

  assert.match(installer, /S-1-5-19:\(OI\)\(CI\)\(M\)/);
  assert.match(installer, /S-1-5-20:\(OI\)\(CI\)\(M\)/);
  assert.match(installer, /Set-RestrictedAcl \$appServiceXml @\('\*S-1-5-19:\(R\)'\)/);
  assert.match(installer, /Set-RestrictedAcl \$proxyServiceXml @\('\*S-1-5-20:\(R\)'\)/);
  assert.doesNotMatch(installer, /Set-RestrictedAcl \$appServiceXml[^\n]*S-1-5-20/);
  assert.match(installer, /Assert-SupportedScannerReady/);
  assert.match(installer, /scanWithAvailableEngine/);
  assert.match(installer, /Defender oder ClamAV/);
  assert.match(installer, /RegisterServices -or \$StartServices/);
  assert.match(installer, /Set-RestrictedAcl \$appRoot[^\n]+S-1-5-19:\(OI\)\(CI\)\(RX\)/);
  assert.match(installer, /Set-RestrictedAcl \$internalBackupDirectory[^\n]+S-1-5-19/);
  assert.match(installer, /Set-RestrictedAcl \$brandingKitsDirectory[^\n]+S-1-5-19/);
  assert.match(installer, /Assert-SeparateTrees \$appRoot \$dataRoot/);
  assert.match(installer, /Assert-SeparateTrees \$backupRoot \$appRoot/);
  assert.match(installer, /Node-Runtime darf nicht im Daten- oder Backupordner liegen/);
});

test("v0.61 server tools: update is checksum-bound, staged, backed up, health-checked and rollback-capable", () => {
  const update = read("server-tools", "windows", "Update-GrabenplanerServer.ps1");
  const packageBuilder = read("server-tools", "windows", "New-GrabenplanerServerPackage.ps1");

  assert.match(update, /Parameter\(Mandatory = \$true\)[\s\S]{0,120}\$PackageZip/);
  assert.match(update, /Parameter\(Mandatory = \$true\)[\s\S]{0,180}\$PackageSha256/);
  assert.match(update, /Get-FileHash[^\n]+packagePath/i);
  assert.match(update, /grabenplaner-server-manifest\.json/);
  assert.match(update, /Expand-VerifiedPackage/);
  assert.match(update, /Backup-Grabenplaner\.ps1/);
  assert.match(update, /previous-app/);
  assert.match(update, /rolled-back/);
  assert.match(update, /Restore-Grabenplaner\.ps1/);
  assert.match(update, /Start-DatabaseMaintenanceLock/);
  assert.match(update, /Stop-DatabaseMaintenanceLock/);
  assert.match(update, /api\/health\/ready/);
  assert.match(update, /previousNodeSha256/);
  assert.match(update, /installedNodeSha256/);
  assert.match(update, /packageSha256/);
  assert.match(update, /Move-Item -LiteralPath \$appRoot -Destination \$rollbackRoot\s+\$oldAppMoved = \$true/);
  assert.match(update, /if \(\$oldAppMoved -and \(Test-Path -LiteralPath \$rollbackRoot/);
  assert.match(update, /\$updateCommitted = \$true/);
  assert.match(update, /rollbackPublicReady = Wait-Health -Url \$publicReadyUrl/);
  assert.match(update, /AllowDowngradeOrReinstall/);
  assert.match(update, /Compare-SemVer/);

  assert.match(packageBuilder, /grabenplaner-server-package/);
  assert.match(packageBuilder, /NodeRuntimeDirectory/);
  assert.match(packageBuilder, /\.git'.*'backups'.*'data'.*'demo'.*'output'.*'release'/s);
  assert.match(packageBuilder, /branding-kits\?/);
  assert.match(packageBuilder, /db\|sqlite\|sqlite3\|amu\|pfx\|p12\|pem\|key/);
  assert.match(packageBuilder, /\.sha256/);
  assert.match(packageBuilder, /ZipFile\]::CreateFromDirectory/);
  assert.match(packageBuilder, /git -C \$sourceRoot status --porcelain --untracked-files=all/);
  assert.match(packageBuilder, /git -C \$sourceRoot ls-files/);
  assert.match(packageBuilder, /sauberen Git-Arbeitsbaum/);
  assert.match(packageBuilder, /node-linker=hoisted/);
  assert.match(packageBuilder, /Reparse-Point/);
  assert.match(packageBuilder, /require\.resolve\('express'/);
  assert.match(packageBuilder, /Server-ZIP-Roundtrip/);
  assert.match(packageBuilder, /GetTempPath\(\).*GrabenplanerServerPackage/s);
  assert.match(packageBuilder, /temporaere Paketordner konnte noch nicht entfernt werden/);
  assert.match(packageBuilder, /Zum Schutz bestehender Release-Artefakte bitte einen leeren Ausgabeordner verwenden/);
  assert.match(packageBuilder, /if \(\$archiveOwned\).*Remove-Item -LiteralPath \$archivePath/s);
});

test("v0.61 server tools: maintenance scripts share one lock and distinct live-ready endpoints", () => {
  const backup = read("server-tools", "windows", "Backup-Grabenplaner.ps1");
  const restore = read("server-tools", "windows", "Restore-Grabenplaner.ps1");
  const stop = read("server-tools", "windows", "Stop-GrabenplanerServer.ps1");
  const health = read("server-tools", "windows", "Test-GrabenplanerServer.ps1");
  const allOps = fs.readdirSync(path.join(root, "server-tools"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => read("server-tools", entry.parentPath.slice(path.join(root, "server-tools").length + 1), entry.name))
    .join("\n");

  for (const script of [backup, restore]) assert.match(script, /Global\\GrabenplanerServerMaintenance/);
  assert.match(backup, /acquireDatabaseLock/);
  assert.match(restore, /Start-DatabaseMaintenanceLock/);
  assert.match(restore, /process\.stdout\.write\('LOCKED\\n'\)/);
  assert.match(restore, /Stop-DatabaseMaintenanceLock/);
  assert.match(restore, /\$transactionCommitted = \$true/);
  assert.match(restore, /if \(\$transactionCommitted\)/);
  assert.match(restore, /Assert-SeparateTrees \$amuSource \$amuTarget 'AUM-Backup und AUM-Ziel'/);
  assert.match(stop, /api\/health\/live/);
  assert.match(restore, /api\/health\/ready/);
  assert.match(health, /InternalLiveUrl[\s\S]+api\/health\/live/);
  assert.match(health, /InternalReadyUrl[\s\S]+api\/health\/ready/);
  assert.match(health, /readAndVerifyBackup/);
  assert.doesNotMatch(allOps, /GRABENPLANER_ALLOW_UNSCANNED_AMU/);
});

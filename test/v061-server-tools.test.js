"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const powershell = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "";
const mandatoryRuntimeModules = [
  "lib\\offsite-provider-policy.js",
  "lib\\host-reboot-control-client.js",
  "lib\\controlled-host-reboot.js",
];

function extractPowerShellFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `PowerShell-Funktion ${name} fehlt.`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next).trim();
}

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
  assert.match(appService, /GRABENPLANER_INTEGRATION_KEY_ID/);
  assert.match(appService, /GRABENPLANER_INTEGRATION_KEY/);
  assert.match(environment, /^GRABENPLANER_DEPLOYMENT_KIND=production$/m);
  assert.match(environment, /^GRABENPLANER_INTEGRATION_KEY_ID=server-v1$/m);
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
  assert.match(installer, /IntegrationEncryptionKey muss genau 32 Byte enthalten/);
  assert.match(installer, /bestehender Integrationsschlüssel/i);
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

test("Windows package builder and updater require every runtime control module", () => {
  const scripts = [
    {
      label: "Serverpaket-Erstellung",
      source: read("server-tools", "windows", "New-GrabenplanerServerPackage.ps1"),
      assertionCall: /Assert-RequiredRuntimeFiles -Root \$buildRoot -PackageKind 'Serverpaket'/,
    },
    {
      label: "Updatepaket-Pruefung",
      source: read("server-tools", "windows", "Update-GrabenplanerServer.ps1"),
      assertionCall: /Assert-RequiredRuntimeFiles -Root \$packageRoot -PackageKind 'Updatepaket'/,
    },
  ];

  for (const script of scripts) {
    const assertionSource = extractPowerShellFunction(script.source, "Assert-RequiredRuntimeFiles");
    for (const modulePath of mandatoryRuntimeModules) {
      assert.ok(
        assertionSource.includes(`'${modulePath}'`),
        `${script.label} verlangt ${modulePath} nicht als Pflichtdatei.`,
      );
    }
    assert.match(script.source, script.assertionCall);
  }
});

test("Windows package assertions reject each missing runtime control module", {
  skip: !powershell || !fs.existsSync(powershell),
}, () => {
  const packageBuilder = read("server-tools", "windows", "New-GrabenplanerServerPackage.ps1");
  const updater = read("server-tools", "windows", "Update-GrabenplanerServer.ps1");
  const builderAssertion = extractPowerShellFunction(packageBuilder, "Assert-RequiredRuntimeFiles")
    .replace("function Assert-RequiredRuntimeFiles", "function Assert-BuilderRequiredRuntimeFiles");
  const updaterAssertion = extractPowerShellFunction(updater, "Assert-RequiredRuntimeFiles")
    .replace("function Assert-RequiredRuntimeFiles", "function Assert-UpdaterRequiredRuntimeFiles");
  const quotedModules = mandatoryRuntimeModules
    .map((modulePath) => `'${modulePath.replaceAll("'", "''")}'`)
    .join(", ");
  const harness = [
    builderAssertion,
    updaterAssertion,
    `$missingModules = @(${quotedModules})`,
    "$allRequired = @(",
    "  'server.js',",
    "  'package.json',",
    "  'lib\\database-lock.js',",
    "  'lib\\offsite-provider-policy.js',",
    "  'lib\\host-reboot-control-client.js',",
    "  'lib\\controlled-host-reboot.js',",
    "  'server-tools\\windows\\Update-GrabenplanerServer.ps1'",
    ")",
    "$base = Join-Path ([IO.Path]::GetTempPath()) ('GrabenplanerRuntimeModules-' + [guid]::NewGuid().ToString('N'))",
    "$results = @()",
    "try {",
    "  foreach ($pathKind in @('builder', 'updater')) {",
    "    foreach ($missing in $missingModules) {",
    "      $root = Join-Path $base ($pathKind + '-' + [IO.Path]::GetFileNameWithoutExtension($missing))",
    "      foreach ($required in $allRequired) {",
    "        if ($required -eq $missing) { continue }",
    "        $target = Join-Path $root $required",
    "        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null",
    "        Set-Content -LiteralPath $target -Value '' -Encoding Ascii",
    "      }",
    "      try {",
    "        if ($pathKind -eq 'builder') {",
    "          Assert-BuilderRequiredRuntimeFiles -Root $root -PackageKind 'Serverpaket'",
    "        } else {",
    "          Assert-UpdaterRequiredRuntimeFiles -Root $root -PackageKind 'Updatepaket'",
    "        }",
    "        $results += [pscustomobject]@{ pathKind = $pathKind; missing = $missing; rejected = $false; message = '' }",
    "      } catch {",
    "        $results += [pscustomobject]@{ pathKind = $pathKind; missing = $missing; rejected = $true; message = $_.Exception.Message }",
    "      }",
    "    }",
    "  }",
    "} finally {",
    "  if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }",
    "}",
    "$results | ConvertTo-Json -Compress",
    "",
  ].join("\r\n");
  const encodedHarness = Buffer.from(harness, "utf16le").toString("base64");
  const result = spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedHarness,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const outcomes = JSON.parse(result.stdout.trim());
  assert.equal(outcomes.length, 6);
  for (const outcome of outcomes) {
    assert.equal(outcome.rejected, true, `${outcome.pathKind} akzeptierte fehlendes ${outcome.missing}.`);
    assert.match(outcome.message, /Pflichtdatei fehlt/);
    assert.ok(outcome.message.includes(outcome.missing), outcome.message);
  }
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
  assert.match(health, /verifyBackupReferences/);
  assert.match(health, /loan_documents/);
  assert.match(health, /loan_photos/);
  assert.match(health, /loan_photo_attachments/);
  const expectedSecurityHeaders = [
    ["HSTS", "max-age=31536000; includeSubDomains"],
    ["Content-Security-Policy", "object-src 'none'"],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "no-referrer"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ["X-Permitted-Cross-Domain-Policies", "none"],
  ];
  for (const [label, expectedValue] of expectedSecurityHeaders) {
    assert.match(health, new RegExp(`Add-Check '${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
    assert.ok(health.includes(expectedValue), `${label} prueft nicht den erwarteten Wert.`);
    assert.ok(
      health.includes(`Add-Check '${label}' $false 'Antwort konnte nicht gelesen werden'`),
      `${label} fehlt im stabilen Fehlerergebnis.`,
    );
  }
  for (const directive of ["base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(health.includes(directive), `Content-Security-Policy prueft ${directive} nicht.`);
  }
  assert.doesNotMatch(allOps, /GRABENPLANER_ALLOW_UNSCANNED_AMU/);
});

test("v0.86 Windows diagnostics require complete, exact CSP directives", {
  skip: !powershell || !fs.existsSync(powershell),
}, () => {
  const health = read("server-tools", "windows", "Test-GrabenplanerServer.ps1");
  const functionStart = health.indexOf("function Test-ExactCspDirectives");
  const functionEnd = health.indexOf("foreach ($serviceName", functionStart);
  assert.notEqual(functionStart, -1, "Exakte CSP-Prueffunktion fehlt.");
  assert.notEqual(functionEnd, -1, "Ende der CSP-Prueffunktion fehlt.");
  const functionSource = health.slice(functionStart, functionEnd).trim();
  const harness = [
    functionSource,
    "$valid = \"default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'\"",
    "$frameSuffix = \"default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none' https://evil.example\"",
    "$formSuffix = \"default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https://evil.example; frame-ancestors 'none'\"",
    "[pscustomobject]@{",
    "  valid = (Test-ExactCspDirectives $valid)",
    "  frameSuffix = (Test-ExactCspDirectives $frameSuffix)",
    "  formSuffix = (Test-ExactCspDirectives $formSuffix)",
    "} | ConvertTo-Json -Compress",
    "",
  ].join("\r\n");
  const encodedHarness = Buffer.from(harness, "utf16le").toString("base64");
  const result = spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedHarness,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    valid: true,
    frameSuffix: false,
    formSuffix: false,
  });
});

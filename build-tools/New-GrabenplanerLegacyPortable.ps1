[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDirectory,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string]$PnpmExecutable,

    [Parameter(Mandatory = $true)]
    [string]$NodeRuntime,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$NodeRuntimeSha256,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$ExpectedCommit
)

$ErrorActionPreference = 'Stop'
$expectedVersion = '0.87.0-beta.legacy.1'
$expectedNodeVersion = 'v24.14.0'
$expectedPnpmVersion = '11.7.0'

function Resolve-ExistingFile([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Datei fehlt: $resolved"
    }
    return $resolved
}

function Resolve-ExistingDirectory([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "Ordner fehlt: $resolved"
    }
    return $resolved
}

function Get-Sha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Copy-RequiredFile([string]$SourceRoot, [string]$TargetRoot, [string]$RelativePath) {
    $relativeWindowsPath = $RelativePath.Replace('/', '\')
    $sourcePath = Join-Path $SourceRoot $relativeWindowsPath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Erforderliche Quelldatei fehlt: $RelativePath"
    }
    $targetPath = Join-Path $TargetRoot $relativeWindowsPath
    New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
}

function Copy-RequiredDirectory([string]$SourceRoot, [string]$TargetRoot, [string]$RelativePath) {
    $relativeWindowsPath = $RelativePath.Replace('/', '\')
    $sourcePath = Join-Path $SourceRoot $relativeWindowsPath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "Erforderlicher Quellordner fehlt: $RelativePath"
    }
    $targetPath = Join-Path $TargetRoot $relativeWindowsPath
    New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Recurse -Force
}

function Write-DeterministicZip([string]$SourceRoot, [string]$ArchivePath) {
    Add-Type -AssemblyName System.IO.Compression
    $timestamp = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $stream = [IO.File]::Open($ArchivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            $prefix = $SourceRoot.TrimEnd('\') + '\'
            $files = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force | Sort-Object {
                $_.FullName.Substring($prefix.Length).Replace('\', '/')
            })
            foreach ($file in $files) {
                $relativePath = $file.FullName.Substring($prefix.Length).Replace('\', '/')
                $entry = $archive.CreateEntry($relativePath, [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = $timestamp
                $input = [IO.File]::OpenRead($file.FullName)
                $output = $entry.Open()
                try {
                    $input.CopyTo($output)
                } finally {
                    $output.Dispose()
                    $input.Dispose()
                }
            }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Invoke-NodeProbe(
    [string]$NodeExecutable,
    [string]$Script,
    [string[]]$Arguments,
    [string]$ExpectedLastLine,
    [string]$FailureMessage
) {
    $result = $Script | & $NodeExecutable - @Arguments
    if ($LASTEXITCODE -ne 0 -or ($result | Select-Object -Last 1) -ne $ExpectedLastLine) {
        throw "$FailureMessage Ausgabe: $($result -join ' ')"
    }
}

$source = Resolve-ExistingDirectory $SourceDirectory
$pnpm = Resolve-ExistingFile $PnpmExecutable
$node = Resolve-ExistingFile $NodeRuntime
$output = [IO.Path]::GetFullPath($OutputDirectory)
$expectedCommitNormalized = $ExpectedCommit.ToLowerInvariant()
$expectedNodeSha256Normalized = $NodeRuntimeSha256.ToLowerInvariant()

$status = @(& git -C $source status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) {
    throw 'Git-Status konnte nicht gelesen werden.'
}
if ($status.Count -gt 0) {
    throw "Der Legacy-Build erfordert einen vollständig sauberen Arbeitsbaum: $($status[0])"
}

$commit = ((& git -C $source rev-parse HEAD) | Select-Object -Last 1).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
    throw 'Git-Commit konnte nicht bestimmt werden.'
}
if ($commit -ne $expectedCommitNormalized) {
    throw "Unerwarteter Quell-Commit: $commit"
}

$metadata = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
$version = [string]$metadata.version
if ($version -ne $expectedVersion) {
    throw "Unerwartete Legacy-Version: $version"
}

$actualNodeSha256 = Get-Sha256 $node
if ($actualNodeSha256 -ne $expectedNodeSha256Normalized) {
    throw "Node.js-Prüfsumme stimmt nicht: $actualNodeSha256"
}
$nodeVersion = ((& $node --version) | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne $expectedNodeVersion) {
    throw "Unerwartete Node.js-Version: $nodeVersion"
}
$pnpmVersion = ((& $pnpm --version) | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne $expectedPnpmVersion) {
    throw "Unerwartete pnpm-Version: $pnpmVersion"
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
$archiveName = "Grabenplaner-v$version-windows-portable.zip"
$archivePath = Join-Path $output $archiveName
$hashPath = "$archivePath.sha256"
if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $hashPath)) {
    throw "Zielartefakt existiert bereits: $archivePath"
}

$workRoot = Join-Path ([IO.Path]::GetTempPath()) ("gp-legacy-v087-" + [Guid]::NewGuid().ToString('N'))
$sourceArchive = Join-Path $workRoot 'source.zip'
$sourceExtract = Join-Path $workRoot 'source'
$stageRoot = Join-Path $workRoot 'stage'
$appRoot = Join-Path $stageRoot 'Grabenplaner'
$roundtripRoot = Join-Path $workRoot 'roundtrip'
$roundtripApp = Join-Path $roundtripRoot 'Grabenplaner'

New-Item -ItemType Directory -Path $workRoot, $sourceExtract, $appRoot -Force | Out-Null
& git -C $source archive --format=zip --output=$sourceArchive HEAD
if ($LASTEXITCODE -ne 0) {
    throw "Git-Archiv konnte nicht erstellt werden. Diagnoseordner: $workRoot"
}
Expand-Archive -LiteralPath $sourceArchive -DestinationPath $sourceExtract

foreach ($directory in @('lib', 'public')) {
    Copy-RequiredDirectory $sourceExtract $appRoot $directory
}
Copy-RequiredFile $sourceExtract $appRoot 'demo/sporthandel/demo-profile.json'

foreach ($relativePath in @(
    'scripts/initialize-portable-db.js',
    'scripts/set-developer.js',
    'Backup erstellen.cmd',
    'backup.js',
    'Dienstplan starten.cmd',
    'Grabenplaner v0.87 Legacy starten.cmd',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'server.js'
)) {
    Copy-RequiredFile $sourceExtract $appRoot $relativePath
}

foreach ($relativePath in @(
    'README.md',
    'LICENSE.md',
    'SECURITY.md',
    'INTEGRATIONEN.md',
    'VERSIONS-LOG.md',
    'LEGACY-WINDOWS-HINWEISE.txt',
    'docs/LEGACY-WINDOWS-PORTABLE.md'
)) {
    $targetRelativePath = if ($relativePath.StartsWith('docs/')) {
        $relativePath
    } else {
        "docs/$relativePath"
    }
    $sourcePath = Join-Path $sourceExtract $relativePath.Replace('/', '\')
    $targetPath = Join-Path $appRoot $targetRelativePath.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Erforderliches Legacy-Dokument fehlt: $relativePath"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
}

New-Item -ItemType Directory -Path (Join-Path $appRoot 'runtime') -Force | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $appRoot 'runtime\node.exe') -Force

$utf8NoBom = [Text.UTF8Encoding]::new($false)
$buildMetadata = [ordered]@{
    format = 'grabenplaner-legacy-build-metadata'
    version = $version
    sourceCommit = $commit
    nodeVersion = $nodeVersion
    nodeRuntimeSha256 = $actualNodeSha256
    pnpmVersion = $pnpmVersion
}
[IO.File]::WriteAllText(
    (Join-Path $appRoot 'docs\BUILD-METADATA.json'),
    (($buildMetadata | ConvertTo-Json -Depth 4) + "`n"),
    $utf8NoBom
)

$previousPath = $env:Path
try {
    $env:Path = "$(Split-Path -Parent $node);$env:Path"
    & $pnpm --dir $appRoot install --prod --frozen-lockfile --config.node-linker=hoisted
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm install fehlgeschlagen: $LASTEXITCODE. Diagnoseordner: $workRoot"
    }
} finally {
    $env:Path = $previousPath
}

Remove-Item -LiteralPath (Join-Path $appRoot 'pnpm-lock.yaml') -Force
Remove-Item -LiteralPath (Join-Path $appRoot 'pnpm-workspace.yaml') -Force

# pnpm schreibt den lokalen Buildpfad und variable Zeitstempel in reine
# Installationsmetadaten. Diese Werte sind für die portable Runtime ohne
# Bedeutung und werden auf reproduzierbare Werte normalisiert.
$modulesPath = Join-Path $appRoot 'node_modules\.modules.yaml'
$modulesText = [IO.File]::ReadAllText($modulesPath)
$modulesText = [regex]::Replace($modulesText, '(?m)^\s*"storeDir":\s*.*$', '  "storeDir": ".pnpm-store",')
$modulesText = [regex]::Replace($modulesText, '(?m)^\s*"virtualStoreDir":\s*.*$', '  "virtualStoreDir": "node_modules/.pnpm",')
$modulesText = [regex]::Replace($modulesText, '(?m)^\s*"prunedAt":\s*.*$', '  "prunedAt": "Thu, 01 Jan 1970 00:00:00 GMT",')
[IO.File]::WriteAllText($modulesPath, $modulesText, $utf8NoBom)

$workspaceStatePath = Join-Path $appRoot 'node_modules\.pnpm-workspace-state-v1.json'
$workspaceState = [IO.File]::ReadAllText($workspaceStatePath) | ConvertFrom-Json
$normalizedSettings = $workspaceState.settings
if ($normalizedSettings.patchedDependencies) {
    foreach ($property in $normalizedSettings.patchedDependencies.PSObject.Properties) {
        $property.Value = "lib/vendor-patches/$([IO.Path]::GetFileName([string]$property.Value))"
    }
}
$normalizedState = [ordered]@{
    lastValidatedTimestamp = 0
    projects = [ordered]@{
        '.' = [ordered]@{
            name = [string]$metadata.name
            version = $version
        }
    }
    pnpmfiles = @()
    settings = $normalizedSettings
    filteredInstall = [bool]$workspaceState.filteredInstall
}
[IO.File]::WriteAllText(
    $workspaceStatePath,
    (($normalizedState | ConvertTo-Json -Depth 12) + "`n"),
    $utf8NoBom
)

$portableTargetComment = '# cmd-shim-target=<portable-node-module>'
$shellShims = @(Get-ChildItem -LiteralPath (Join-Path $appRoot 'node_modules') -Recurse -File -Force |
    Where-Object { $_.Extension -eq '' -and $_.DirectoryName -match '[\\/]\.bin$' })
foreach ($shim in $shellShims) {
    $text = [IO.File]::ReadAllText($shim.FullName)
    $normalized = [regex]::Replace($text, '(?m)^# cmd-shim-target=.*$', $portableTargetComment)
    if ($normalized -ne $text) {
        [IO.File]::WriteAllText($shim.FullName, $normalized, $utf8NoBom)
    }
}
foreach ($metadataFile in @($modulesPath, $workspaceStatePath) + @($shellShims.FullName)) {
    $text = [IO.File]::ReadAllText($metadataFile)
    $unescapedText = $text.Replace('\\', '\')
    foreach ($forbiddenBuildPath in @(
        $workRoot,
        $workRoot.Replace('\', '/'),
        $source,
        $source.Replace('\', '/')
    )) {
        if ($text.Contains($forbiddenBuildPath) -or $unescapedText.Contains($forbiddenBuildPath)) {
            throw "Lokaler Buildpfad blieb in portablen Metadaten erhalten: $metadataFile"
        }
    }
}

$reparse = Get-ChildItem -LiteralPath $appRoot -Recurse -Force |
    Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
    Select-Object -First 1
if ($reparse) {
    throw "Portables Paket enthält einen Reparse-Point: $($reparse.FullName)"
}

foreach ($forbidden in @(
    '.git',
    'backups',
    'data',
    'release',
    'server-tools',
    'test',
    'tmp',
    'usb-backups'
)) {
    if (Test-Path -LiteralPath (Join-Path $appRoot $forbidden)) {
        throw "Verbotener Laufzeitordner im Paket: $forbidden"
    }
}
foreach ($forbiddenFile in @(
    'USB-HINWEISE.txt',
    'Grabenplaner v0.86 Beta starten.cmd'
)) {
    if (Test-Path -LiteralPath (Join-Path $appRoot $forbiddenFile)) {
        throw "Veraltete Datei im Paket: $forbiddenFile"
    }
}
$forbiddenCustomerPath = Get-ChildItem -LiteralPath $stageRoot -Recurse -Force | Where-Object {
    $_.FullName.Substring($stageRoot.Length) -match '(?i)(lamprechter|photo-?straub|foto-?straub|united-?camera)'
} | Select-Object -First 1
if ($forbiddenCustomerPath) {
    throw "Kundenspezifischer Pfad im neutralen Paket: $($forbiddenCustomerPath.FullName)"
}

$dependencyProbe = @'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
(async () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (metadata.version !== '0.87.0-beta.legacy.1') throw new Error(`version=${metadata.version}`);
  for (const dependency of Object.keys(metadata.dependencies || {})) {
    require.resolve(dependency, { paths: [root] });
  }
  const sharp = require(require.resolve('sharp', { paths: [root] }));
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  }).png().toBuffer();
  if (png.length < 60) throw new Error('sharp-output-too-small');
  process.stdout.write('dependencies-ok');
})().catch((error) => {
  process.stderr.write(error.stack || String(error));
  process.exitCode = 1;
});
'@
Invoke-NodeProbe $node $dependencyProbe @($appRoot) 'dependencies-ok' 'Dependency-/Sharp-Probe fehlgeschlagen.'

foreach ($relativePath in @(
    'server.js',
    'backup.js',
    'scripts\initialize-portable-db.js',
    'scripts\set-developer.js'
)) {
    & $node --check (Join-Path $appRoot $relativePath)
    if ($LASTEXITCODE -ne 0) {
        throw "Syntaxprüfung fehlgeschlagen: $relativePath"
    }
}

Write-DeterministicZip -SourceRoot $stageRoot -ArchivePath $archivePath
Expand-Archive -LiteralPath $archivePath -DestinationPath $roundtripRoot

$roundtripNode = Join-Path $roundtripApp 'runtime\node.exe'
if ((Get-Sha256 $roundtripNode) -ne $actualNodeSha256) {
    throw 'Die Node.js-Runtime wurde im ZIP-Roundtrip verändert.'
}
Invoke-NodeProbe $roundtripNode $dependencyProbe @($roundtripApp) 'dependencies-ok' 'ZIP-Roundtrip Dependency-/Sharp-Probe fehlgeschlagen.'

$documentProbe = @'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const pdfPath = process.argv[3];
const xlsxPath = process.argv[4];
(async () => {
  const PDFDocument = require(require.resolve('pdfkit', { paths: [root] }));
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(pdfPath);
    output.on('finish', resolve);
    output.on('error', reject);
    const document = new PDFDocument();
    document.on('error', reject);
    document.pipe(output);
    document.fontSize(16).text('Grabenplaner Legacy Paketpruefung');
    document.end();
  });
  const ExcelJS = require(require.resolve('exceljs', { paths: [root] }));
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Pruefung').addRow(['Legacy', 'OK']);
  await workbook.xlsx.writeFile(xlsxPath);
  process.stdout.write('documents-ok');
})().catch((error) => {
  process.stderr.write(error.stack || String(error));
  process.exitCode = 1;
});
'@
$pdfPath = Join-Path $workRoot 'legacy-pdf-probe.pdf'
$xlsxPath = Join-Path $workRoot 'legacy-xlsx-probe.xlsx'
Invoke-NodeProbe $roundtripNode $documentProbe @($roundtripApp, $pdfPath, $xlsxPath) 'documents-ok' 'PDF-/XLSX-Paketprobe fehlgeschlagen.'
if ((Get-Item -LiteralPath $pdfPath).Length -lt 500 -or (Get-Item -LiteralPath $xlsxPath).Length -lt 1000) {
    throw 'PDF-/XLSX-Paketprobe erzeugte kein plausibles Dokument.'
}

$freshRoot = Join-Path $workRoot 'fresh-db'
$freshDb = Join-Path $freshRoot 'data\dienstplan.db'
New-Item -ItemType Directory -Path $freshRoot -Force | Out-Null
& $roundtripNode (Join-Path $roundtripApp 'scripts\initialize-portable-db.js') $freshDb $freshRoot
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $freshDb)) {
    throw 'Frische Legacy-Datenbank konnte nicht initialisiert werden.'
}
$databaseProbe = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const quick = Object.values(db.prepare('PRAGMA quick_check').get())[0];
const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get().count;
const employees = db.prepare("SELECT COUNT(*) AS count FROM employees").get().count;
db.close();
process.stdout.write(JSON.stringify({ quick, tables, employees }));
'@
$databaseResult = $databaseProbe | & $roundtripNode - $freshDb
if ($LASTEXITCODE -ne 0) {
    throw 'SQLite-Paketprobe fehlgeschlagen.'
}
$databaseInfo = ($databaseResult | Select-Object -Last 1) | ConvertFrom-Json
if ([string]$databaseInfo.quick -ne 'ok' -or [int]$databaseInfo.tables -lt 1 -or [int]$databaseInfo.employees -ne 0) {
    throw "Frische Legacy-Datenbank ist nicht leer oder nicht integer: $($databaseResult | Select-Object -Last 1)"
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$smokePort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$smokeData = Join-Path $workRoot 'server-smoke-data'
$smokeBackups = Join-Path $workRoot 'server-smoke-backups'
$environmentKeys = @(
    'PORT',
    'GRABENPLANER_HOST',
    'GRABENPLANER_OPERATION_MODE',
    'GRABENPLANER_DEPLOYMENT_KIND',
    'GRABENPLANER_DATA_DIR',
    'BACKUP_DIR',
    'GRABENPLANER_SEED_DEMO'
)
$savedEnvironment = @{}
foreach ($key in $environmentKeys) {
    $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
$smokeProcess = $null
try {
    $env:PORT = [string]$smokePort
    $env:GRABENPLANER_HOST = '127.0.0.1'
    $env:GRABENPLANER_OPERATION_MODE = 'local'
    $env:GRABENPLANER_DEPLOYMENT_KIND = 'local'
    $env:GRABENPLANER_DATA_DIR = $smokeData
    $env:BACKUP_DIR = $smokeBackups
    $env:GRABENPLANER_SEED_DEMO = '0'

    $processInfo = [Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = $roundtripNode
    $processInfo.Arguments = 'server.js'
    $processInfo.WorkingDirectory = $roundtripApp
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $smokeProcess = [Diagnostics.Process]::new()
    $smokeProcess.StartInfo = $processInfo
    if (-not $smokeProcess.Start()) {
        throw 'Legacy-Server-Smoke konnte nicht gestartet werden.'
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        if ($smokeProcess.HasExited) {
            break
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$smokePort/api/health/ready" -TimeoutSec 2
            if ($health.ok -eq $true) {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        $exitDetail = if ($smokeProcess.HasExited) { "ExitCode=$($smokeProcess.ExitCode)" } else { 'Timeout' }
        throw "Legacy-Server-Smoke wurde nicht bereit. $exitDetail"
    }

    $systemInfo = Invoke-RestMethod -Uri "http://127.0.0.1:$smokePort/api/system-info" -TimeoutSec 5
    if ($systemInfo.appVersion -ne $version -or $systemInfo.appVersionLabel -ne 'v0.87 Legacy') {
        throw "Legacy-Systeminfo ist inkonsistent: $($systemInfo | ConvertTo-Json -Compress)"
    }
    $updateStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$smokePort/api/update-status" -TimeoutSec 5
    $updateFrozen = $updateStatus.source -eq 'legacy-final' `
        -and $updateStatus.updateAvailable -eq $false `
        -and $updateStatus.canAutoUpdate -eq $false
    if (-not $updateFrozen) {
        throw "Legacy-Updater ist nicht eingefroren: $($updateStatus | ConvertTo-Json -Compress)"
    }
    $portalStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$smokePort/api/portal/v1/status" -TimeoutSec 5
    $usbDisabled = $portalStatus.usbProvisioning.available -eq $false `
        -and $portalStatus.usbProvisioning.reasonCode -eq 'LEGACY_USB_PROVISIONING_DISABLED'
    if (-not $usbDisabled) {
        throw "USB-Bereitstellung ist nicht fail-closed: $($portalStatus.usbProvisioning | ConvertTo-Json -Compress)"
    }
} finally {
    if ($smokeProcess -and -not $smokeProcess.HasExited) {
        Stop-Process -Id $smokeProcess.Id -Force
        $smokeProcess.WaitForExit()
    }
    foreach ($key in $environmentKeys) {
        $savedValue = $savedEnvironment[$key]
        if ($null -eq $savedValue) {
            [Environment]::SetEnvironmentVariable($key, $null, 'Process')
        } else {
            [Environment]::SetEnvironmentVariable($key, [string]$savedValue, 'Process')
        }
    }
}

$sha256 = Get-Sha256 $archivePath
"$sha256 *$archiveName" | Set-Content -LiteralPath $hashPath -Encoding ascii
$files = @(Get-ChildItem -LiteralPath $appRoot -Recurse -File -Force)
$result = [pscustomobject]@{
    Ok = $true
    Package = $archivePath
    Sha256 = $sha256
    Sha256File = $hashPath
    Bytes = (Get-Item -LiteralPath $archivePath).Length
    FileCount = $files.Count
    SourceCommit = $commit
    RuntimeVersion = $nodeVersion
    RuntimeSha256 = $actualNodeSha256
    PnpmVersion = $pnpmVersion
    FreshDatabaseTables = [int]$databaseInfo.tables
    FreshDatabaseEmployees = [int]$databaseInfo.employees
    ServerSmoke = 'ready'
    LegacyUpdater = 'disabled'
    UsbProvisioning = 'disabled'
}

Remove-Item -LiteralPath $workRoot -Recurse -Force
$result

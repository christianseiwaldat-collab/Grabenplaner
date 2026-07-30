[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [string]$SourceDirectory,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [string]$NodeRuntimeDirectory,

    [string]$PnpmExecutable = 'pnpm',
    [string]$NodeExecutableForVerification
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
    $SourceDirectory = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

function Resolve-SafeDirectory([string]$Path, [switch]$MustExist) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Ein erforderlicher Pfad fehlt.' }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\') -or $fullPath -eq [System.IO.Path]::GetPathRoot($fullPath)) {
        throw "Nicht zulaessiger Paketpfad: $fullPath"
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "Ordner nicht gefunden: $fullPath"
    }
    return $fullPath
}

function Test-ExcludedRelativePath([string]$RelativePath) {
    $normalized = $RelativePath.Replace('\', '/')
    $top = ($normalized -split '/', 2)[0].ToLowerInvariant()
    if ($top -in @('.git', '.github', '.devcontainer', 'backups', 'data', 'demo', 'docs', 'node_modules', 'output', 'release', 'runtime', 'scripts', 'test', 'tmp', 'usb-backups')) { return $true }
    if ($normalized -match '(^|/)(\.env($|\.)|\.npmrc$|\.pnpm-store($|/)|__pycache__($|/))') { return $true }
    if ($normalized -match '\.(db|sqlite|sqlite3|amu|pfx|p12|pem|key)$') { return $true }
    if ($normalized -match '(^|/)(branding-kits?|customer-branding|kundenbranding)(/|$)') { return $true }
    if ($normalized -match '(lamprechter|photo-?straub|foto-?straub|united-?camera)') { return $true }
    return $false
}

function Test-AllowedTrackedRuntimePath([string]$RelativePath) {
    $normalized = $RelativePath.Replace('\', '/')
    if ($normalized -in @('server.js', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'LICENSE.md', 'SECURITY.md', 'SERVERBETRIEB.md')) { return $true }
    return $normalized.StartsWith('lib/') -or $normalized.StartsWith('public/') -or $normalized.StartsWith('server-tools/')
}

function Assert-RequiredRuntimeFiles([string]$Root, [string]$PackageKind) {
    foreach ($required in @(
        'server.js',
        'package.json',
        'lib\database-lock.js',
        'lib\offsite-provider-policy.js',
        'lib\host-reboot-control-client.js',
        'lib\controlled-host-reboot.js',
        'server-tools\windows\Update-GrabenplanerServer.ps1'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)) {
            throw "Pflichtdatei fehlt im ${PackageKind}: $required"
        }
    }
}

function Copy-TreeFiles([string]$Source, [string]$Target, [scriptblock]$Include) {
    $sourcePrefix = $Source.TrimEnd('\') + '\'
    foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File -Force) {
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse-Points sind in Serverpaketen nicht erlaubt: $($file.FullName)"
        }
        $relative = $file.FullName.Substring($sourcePrefix.Length)
        if (-not (& $Include $relative)) { continue }
        $destination = Join-Path $Target $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
}

function Remove-TemporaryTreeBestEffort([string]$Path, [string]$ExpectedParent) {
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $parentPrefix = [System.IO.Path]::GetFullPath($ExpectedParent).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not (Test-Path -LiteralPath $resolved)) { return $true }
    for ($attempt = 1; $attempt -le 6 -and (Test-Path -LiteralPath $resolved); $attempt++) {
        try {
            Get-ChildItem -LiteralPath $resolved -Recurse -File -Force -ErrorAction SilentlyContinue |
                ForEach-Object { try { $_.IsReadOnly = $false } catch {} }
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
        } catch {
            if ($attempt -lt 6) { Start-Sleep -Milliseconds 750 }
        }
    }
    return -not (Test-Path -LiteralPath $resolved)
}

$sourceRoot = Resolve-SafeDirectory -Path $SourceDirectory -MustExist
$outputRoot = Resolve-SafeDirectory -Path $OutputDirectory
$sourcePrefixForOutput = $sourceRoot.TrimEnd('\') + '\'
if ($outputRoot -eq $sourceRoot) { throw 'Der Ausgabeordner darf nicht dem Quellordner entsprechen.' }
if ($outputRoot.StartsWith($sourcePrefixForOutput, [StringComparison]::OrdinalIgnoreCase)) {
    $relativeOutput = $outputRoot.Substring($sourcePrefixForOutput.Length)
    if (-not (Test-ExcludedRelativePath (Join-Path $relativeOutput 'package.zip'))) {
        throw 'Ein Ausgabeordner innerhalb der Quelle muss in einem vom Paket ausgeschlossenen Bereich liegen (z.B. release oder output).'
    }
}
$packageJsonPath = Join-Path $sourceRoot 'package.json'
if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) { throw "package.json fehlt: $packageJsonPath" }
$packageMetadata = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$packageMetadata.version
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') { throw 'Die App-Version in package.json ist ungueltig.' }

$runtimeRoot = $null
if ($NodeRuntimeDirectory) {
    $runtimeRoot = Resolve-SafeDirectory -Path $NodeRuntimeDirectory -MustExist
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'node.exe') -PathType Leaf)) {
        throw 'Der bereitgestellte Node-Runtime-Ordner enthaelt keine node.exe.'
    }
}
if (-not $NodeExecutableForVerification) {
    $bundledVerifier = if ($runtimeRoot) { Join-Path $runtimeRoot 'node.exe' } else { Join-Path $sourceRoot 'runtime\node.exe' }
    $NodeExecutableForVerification = if (Test-Path -LiteralPath $bundledVerifier -PathType Leaf) {
        $bundledVerifier
    } else {
        (Get-Command node -ErrorAction Stop).Source
    }
}
$nodeVerifier = [System.IO.Path]::GetFullPath($NodeExecutableForVerification)
if (-not (Test-Path -LiteralPath $nodeVerifier -PathType Leaf)) { throw "Node fuer die Paketpruefung wurde nicht gefunden: $nodeVerifier" }
$pnpmCommandPath = if (Test-Path -LiteralPath $PnpmExecutable -PathType Leaf) {
    [System.IO.Path]::GetFullPath($PnpmExecutable)
} else {
    (Get-Command $PnpmExecutable -ErrorAction Stop).Source
}

$gitMarker = Join-Path $sourceRoot '.git'
if (-not (Test-Path -LiteralPath $gitMarker)) {
    throw 'Neutrale Serverpakete werden nur aus einem Git-Checkout erstellt, damit unversionierte Kundenassets sicher erkannt werden.'
}
$gitStatus = @(& git -C $sourceRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Der Git-Arbeitsbaum konnte nicht geprueft werden.' }
if ($gitStatus.Count -gt 0) {
    throw "Serverpakete erfordern einen sauberen Git-Arbeitsbaum; so gelangen keine unversionierten Kundenassets in das Paket. Erster Eintrag: $($gitStatus[0])"
}
$trackedFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$trackedOutput = & git -C $sourceRoot ls-files
if ($LASTEXITCODE -ne 0) { throw 'Die versionierten neutralen App-Dateien konnten nicht ueber Git ermittelt werden.' }
foreach ($entry in $trackedOutput) { [void]$trackedFiles.Add(([string]$entry).Replace('\', '/')) }

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$temporaryParent = Join-Path ([System.IO.Path]::GetTempPath()) 'GrabenplanerServerPackage'
New-Item -ItemType Directory -Path $temporaryParent -Force | Out-Null
$buildRoot = Join-Path $temporaryParent ".grabenplaner-server-package-$([Guid]::NewGuid().ToString('N'))"
$archiveName = "Grabenplaner-Server-v$version-windows-x64.zip"
$archivePath = Join-Path $outputRoot $archiveName
$hashPath = "$archivePath.sha256"
$roundtripRoot = Join-Path $temporaryParent ".grabenplaner-server-roundtrip-$([Guid]::NewGuid().ToString('N'))"
$packageComplete = $false
$archiveOwned = $false
$hashOwned = $false

if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $hashPath)) {
    throw "Das Ziel enthaelt bereits ein Serverpaket dieser Version. Zum Schutz bestehender Release-Artefakte bitte einen leeren Ausgabeordner verwenden: $outputRoot"
}

if (-not $PSCmdlet.ShouldProcess($archivePath, 'Neutrales, pruefsummengestuetztes Serverpaket erstellen')) { return }
try {
    New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
    foreach ($relative in $trackedFiles) {
        if ((Test-ExcludedRelativePath $relative) -or -not (Test-AllowedTrackedRuntimePath $relative)) { continue }
        $sourceFile = Join-Path $sourceRoot $relative.Replace('/', '\')
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "Versionierte Paketdatei fehlt: $relative" }
        if (((Get-Item -LiteralPath $sourceFile).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse-Points sind in Appquellen nicht erlaubt: $relative" }
        $destination = Join-Path $buildRoot $relative.Replace('/', '\')
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile -Destination $destination -Force
    }
    if ($runtimeRoot) {
        Copy-TreeFiles -Source $runtimeRoot -Target (Join-Path $buildRoot 'runtime') -Include { param($relative) $true }
    }

    if ([System.IO.Path]::GetExtension($pnpmCommandPath) -eq '.cjs') {
        & $nodeVerifier $pnpmCommandPath --dir $buildRoot install --prod --frozen-lockfile --config.node-linker=hoisted
    } else {
        & $pnpmCommandPath --dir $buildRoot install --prod --frozen-lockfile --config.node-linker=hoisted
    }
    if ($LASTEXITCODE -ne 0) { throw "Die portablen Produktionsabhaengigkeiten konnten nicht erstellt werden (pnpm Exitcode $LASTEXITCODE)." }
    Remove-Item -LiteralPath (Join-Path $buildRoot 'pnpm-workspace.yaml') -Force -ErrorAction SilentlyContinue
    $productionModules = Join-Path $buildRoot 'node_modules'
    if (-not (Test-Path -LiteralPath $productionModules -PathType Container)) { throw 'node_modules fehlt nach dem Produktionsinstall.' }
    $reparseDependency = Get-ChildItem -LiteralPath $productionModules -Recurse -Force -ErrorAction Stop |
        Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
        Select-Object -First 1
    if ($reparseDependency) { throw "Die Produktionsabhaengigkeiten enthalten weiterhin einen nicht portablen Reparse-Point: $($reparseDependency.FullName)" }

    $dependencyProbe = @'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const dependency of Object.keys(metadata.dependencies || {})) {
  require.resolve(dependency, { paths: [root] });
}
require(require.resolve('express', { paths: [root] }));
require(require.resolve('sharp', { paths: [root] }));
process.stdout.write('dependencies-ok');
'@
    $probeResult = $dependencyProbe | & $nodeVerifier - $buildRoot
    if ($LASTEXITCODE -ne 0 -or ($probeResult | Select-Object -Last 1) -ne 'dependencies-ok') {
        throw 'Die entpackbare Produktionsdependency-Struktur ist nicht lauffaehig.'
    }
    & $nodeVerifier --check (Join-Path $buildRoot 'server.js')
    if ($LASTEXITCODE -ne 0) { throw 'server.js hat die Node-Syntaxpruefung nicht bestanden.' }

    Assert-RequiredRuntimeFiles -Root $buildRoot -PackageKind 'Serverpaket'

    $buildPrefix = $buildRoot.TrimEnd('\') + '\'
    $manifestFiles = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -File -Force |
        Where-Object { $_.Name -ne 'grabenplaner-server-manifest.json' } |
        ForEach-Object {
            [pscustomobject]@{
                path = $_.FullName.Substring($buildPrefix.Length).Replace('\', '/')
                bytes = [int64]$_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        } | Sort-Object path)
    $nodeEntry = $manifestFiles | Where-Object { $_.path -eq 'runtime/node.exe' } | Select-Object -First 1
    $manifest = [ordered]@{
        format = 'grabenplaner-server-package'
        schemaVersion = 1
        appVersion = $version
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        nodeRuntimeIncluded = [bool]$nodeEntry
        nodeRuntimeSha256 = if ($nodeEntry) { $nodeEntry.sha256 } else { $null }
        files = $manifestFiles
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $buildRoot 'grabenplaner-server-manifest.json') -Encoding utf8

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archiveOwned = $true
    [IO.Compression.ZipFile]::CreateFromDirectory($buildRoot, $archivePath, [IO.Compression.CompressionLevel]::Optimal, $false)
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $roundtripRoot)
    $roundtripProbe = $dependencyProbe | & $nodeVerifier - $roundtripRoot
    if ($LASTEXITCODE -ne 0 -or ($roundtripProbe | Select-Object -Last 1) -ne 'dependencies-ok') {
        throw 'Der entpackte Server-ZIP-Roundtrip kann die Produktionsabhaengigkeiten nicht laden.'
    }
    & $nodeVerifier --check (Join-Path $roundtripRoot 'server.js')
    if ($LASTEXITCODE -ne 0) { throw 'Der entpackte Server-ZIP-Roundtrip hat die Syntaxpruefung nicht bestanden.' }
    $packageSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashOwned = $true
    "$packageSha256 *$archiveName" | Set-Content -LiteralPath $hashPath -Encoding ascii
    $packageComplete = $true

    [pscustomobject]@{
        Ok                  = $true
        Package             = $archivePath
        Sha256              = $packageSha256
        Sha256File          = $hashPath
        AppVersion          = $version
        NodeRuntimeIncluded = [bool]$nodeEntry
        FileCount           = $manifestFiles.Count
    }
} finally {
    if (-not (Remove-TemporaryTreeBestEffort -Path $buildRoot -ExpectedParent $temporaryParent)) {
        Write-Warning "Der temporaere Paketordner konnte noch nicht entfernt werden: $buildRoot"
    }
    if (-not (Remove-TemporaryTreeBestEffort -Path $roundtripRoot -ExpectedParent $temporaryParent)) {
        Write-Warning "Der temporaere ZIP-Pruefordner konnte noch nicht entfernt werden: $roundtripRoot"
    }
    if ((Test-Path -LiteralPath $temporaryParent -PathType Container) -and -not (Get-ChildItem -LiteralPath $temporaryParent -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $temporaryParent -Force -ErrorAction SilentlyContinue
    }
    if (-not $packageComplete) {
        if ($archiveOwned) { Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue }
        if ($hashOwned) { Remove-Item -LiteralPath $hashPath -Force -ErrorAction SilentlyContinue }
    }
}

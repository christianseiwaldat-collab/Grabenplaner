[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [string]$SourceDirectory,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
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
    if ($normalized -match '\.(db|sqlite|sqlite3|amu|pfx|p12|pem|key|crt)$') { return $true }
    if ($normalized -match '(^|/)(branding-kits?|customer-branding|kundenbranding)(/|$)') { return $true }
    if ($normalized -match '(lamprechter|photo-?straub|foto-?straub|united-?camera)') { return $true }
    return $false
}

function Test-AllowedTrackedRuntimePath([string]$RelativePath) {
    $normalized = $RelativePath.Replace('\', '/')
    if ($normalized -in @(
        'server.js',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'README.md',
        'LICENSE.md',
        'SECURITY.md',
        'SERVERBETRIEB.md'
    )) { return $true }
    return $normalized.StartsWith('lib/') -or
        $normalized.StartsWith('public/') -or
        $normalized.StartsWith('server-tools/')
}

function Get-Sha256Text([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Get-Sha256File([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::Open(
        $Path,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
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
            if ($attempt -lt 6) { Start-Sleep -Milliseconds 500 }
        }
    }
    return -not (Test-Path -LiteralPath $resolved)
}

function Write-DeterministicZip([string]$SourceRoot, [string]$ArchivePath) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $fixedTimestamp = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $stream = [IO.File]::Open($ArchivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            $prefix = $SourceRoot.TrimEnd('\') + '\'
            $files = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force | Sort-Object {
                $_.FullName.Substring($prefix.Length).Replace('\', '/')
            })
            foreach ($file in $files) {
                $relative = $file.FullName.Substring($prefix.Length).Replace('\', '/')
                $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = $fixedTimestamp
                $mode = if ($relative.EndsWith('.sh', [StringComparison]::OrdinalIgnoreCase)) { 493 } else { 420 }
                $entry.ExternalAttributes = ((32768 + $mode) -shl 16)
                $input = [IO.File]::OpenRead($file.FullName)
                $output = $entry.Open()
                try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
            }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

$sourceRoot = Resolve-SafeDirectory -Path $SourceDirectory -MustExist
$outputRoot = Resolve-SafeDirectory -Path $OutputDirectory
$hardeningPrefix = 'server-tools/linux/hardening/'
$expectedHardeningArtifacts = @(
    'server-tools/linux/hardening/grabenplaner-host-security.sh',
    'server-tools/linux/hardening/install-grabenplaner-host-hardening.sh',
    'server-tools/linux/hardening/lib/hardening-common.sh',
    'server-tools/linux/hardening/lib/hardening-contract.js',
    'server-tools/linux/hardening/lib/hardening-policy.js',
    'server-tools/linux/hardening/module-schema.json',
    'server-tools/linux/hardening/systemd/grabenplaner-host-security-audit.service.in',
    'server-tools/linux/hardening/systemd/grabenplaner-host-security-audit.timer.in',
    'server-tools/linux/hardening/systemd/grabenplaner-host-security-rollback.service.in',
    'server-tools/linux/hardening/systemd/grabenplaner-host-security-rollback.timer.in',
    'server-tools/linux/hardening/templates/00-grabenplaner-hardening.conf',
    'server-tools/linux/hardening/templates/60grabenplaner-auto-upgrades',
    'server-tools/linux/hardening/templates/60grabenplaner-unattended-upgrades',
    'server-tools/linux/hardening/templates/60-grabenplaner-journald.conf',
    'server-tools/linux/hardening/templates/zz-grabenplaner-journald.conf',
    'server-tools/linux/hardening/templates/60-grabenplaner-sysctl.conf',
    'server-tools/linux/hardening/test-grabenplaner-host-hardening.sh',
    'server-tools/linux/hardening/uninstall-grabenplaner-host-hardening.sh'
)
$expectedHardeningDirectories = @(
    'server-tools/linux/hardening/lib',
    'server-tools/linux/hardening/systemd',
    'server-tools/linux/hardening/templates'
)
$sourcePrefixForOutput = $sourceRoot.TrimEnd('\') + '\'
if ($outputRoot -eq $sourceRoot) { throw 'Der Ausgabeordner darf nicht dem Quellordner entsprechen.' }
if ($outputRoot.StartsWith($sourcePrefixForOutput, [StringComparison]::OrdinalIgnoreCase)) {
    $relativeOutput = $outputRoot.Substring($sourcePrefixForOutput.Length)
    if (-not (Test-ExcludedRelativePath (Join-Path $relativeOutput 'package.zip'))) {
        throw 'Ein Ausgabeordner innerhalb der Quelle muss in einem ausgeschlossenen Bereich wie release oder output liegen.'
    }
}

$packageJsonPath = Join-Path $sourceRoot 'package.json'
if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) { throw "package.json fehlt: $packageJsonPath" }
$packageMetadata = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
$version = [string]$packageMetadata.version
$minimumNode = [string]$packageMetadata.engines.node
$packageManager = [string]$packageMetadata.packageManager
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') { throw 'Die App-Version in package.json ist ungueltig.' }
if ([string]::IsNullOrWhiteSpace($minimumNode)) { throw 'Die minimale Node.js-Version fehlt in package.json.' }
if ($packageManager -notmatch '^pnpm@[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Die festgeschriebene pnpm-Version fehlt in package.json.' }

$gitMarker = Join-Path $sourceRoot '.git'
if (-not (Test-Path -LiteralPath $gitMarker)) {
    throw 'Neutrale Serverpakete werden nur aus einem Git-Checkout erstellt.'
}
$gitStatus = @(& git -C $sourceRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Der Git-Arbeitsbaum konnte nicht geprueft werden.' }
if ($gitStatus.Count -gt 0) {
    throw "Linux-Serverpakete erfordern einen sauberen Git-Arbeitsbaum. Erster Eintrag: $($gitStatus[0])"
}
$sourceCommit = ((& git -C $sourceRoot rev-parse HEAD) | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') { throw 'Der Git-Quellcommit konnte nicht ermittelt werden.' }
$sourceTimestamp = ((& git -C $sourceRoot log -1 --format=%cI) | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourceTimestamp)) { throw 'Der Git-Zeitstempel konnte nicht ermittelt werden.' }
$trackedFiles = @(& git -C $sourceRoot ls-files | ForEach-Object { ([string]$_).Replace('\', '/') } | Sort-Object)
if ($LASTEXITCODE -ne 0) { throw 'Die versionierten neutralen App-Dateien konnten nicht ermittelt werden.' }

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$archiveName = "Grabenplaner-Server-v$version-linux-x64.zip"
$archivePath = Join-Path $outputRoot $archiveName
$hashPath = "$archivePath.sha256"
if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $hashPath)) {
    throw "Das Ziel enthaelt bereits ein Linux-Serverpaket dieser Version: $outputRoot"
}

$temporaryParent = Join-Path ([IO.Path]::GetTempPath()) 'GrabenplanerLinuxServerPackage'
New-Item -ItemType Directory -Path $temporaryParent -Force | Out-Null
$buildRoot = Join-Path $temporaryParent ".grabenplaner-linux-package-$([Guid]::NewGuid().ToString('N'))"
$roundtripRoot = Join-Path $temporaryParent ".grabenplaner-linux-roundtrip-$([Guid]::NewGuid().ToString('N'))"
$packageComplete = $false
$archiveOwned = $false
$hashOwned = $false

if (-not $PSCmdlet.ShouldProcess($archivePath, 'Deterministisches neutrales Linux-Quellpaket erstellen')) { return }
try {
    New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
    foreach ($relative in $trackedFiles) {
        if ((Test-ExcludedRelativePath $relative) -or -not (Test-AllowedTrackedRuntimePath $relative)) { continue }
        $sourceFile = Join-Path $sourceRoot $relative.Replace('/', '\')
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "Versionierte Paketdatei fehlt: $relative" }
        if (((Get-Item -LiteralPath $sourceFile).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse-Points sind im Linux-Serverpaket nicht erlaubt: $relative"
        }
        $destination = Join-Path $buildRoot $relative.Replace('/', '\')
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile -Destination $destination -Force
    }

    $requiredPackageFiles = @(
        'server.js',
        'package.json',
        'pnpm-lock.yaml',
        'SERVERBETRIEB.md',
        'server-tools\server.env.example',
        'server-tools\caddy\Caddyfile.example',
        'server-tools\linux\offsite\module-schema.json',
        'server-tools\linux\offsite\grabenplaner-offsite-check.sh',
        'server-tools\linux\offsite\grabenplaner-offsite-pre-update.sh',
        'server-tools\linux\offsite\grabenplaner-offsite-prepare.sh',
        'server-tools\linux\offsite\grabenplaner-offsite-read-secret.sh',
        'server-tools\linux\offsite\grabenplaner-offsite-rclone-wrapper.sh',
        'server-tools\linux\offsite\grabenplaner-offsite-restore-test.sh',
        'server-tools\linux\offsite\grabenplaner-offsite-upload.sh',
        'server-tools\linux\offsite\install-grabenplaner-offsite.sh',
        'server-tools\linux\offsite\uninstall-grabenplaner-offsite.sh',
        'server-tools\linux\offsite\test-grabenplaner-offsite.sh',
        'server-tools\linux\offsite\lib\offsite-common.sh',
        'server-tools\linux\offsite\lib\offsite-contract.js',
        'server-tools\linux\offsite\lib\offsite-restore-verify.js',
        'server-tools\linux\offsite\lib\offsite-retention-verify.js',
        'server-tools\linux\offsite\lib\offsite-stage.js',
        'server-tools\linux\offsite\lib\offsite-status.js',
        'server-tools\linux\offsite\lib\offsite-setup-rclone-wrapper.sh',
        'server-tools\linux\offsite\systemd\grabenplaner-offsite-prepare.service.in',
        'server-tools\linux\offsite\systemd\grabenplaner-offsite-upload.service.in',
        'server-tools\linux\offsite\systemd\grabenplaner-offsite-upload.timer.in',
        'server-tools\linux\offsite\systemd\grabenplaner-offsite-check.service.in',
        'server-tools\linux\offsite\systemd\grabenplaner-offsite-check.timer.in',
        'server-tools\linux\offsite\systemd\grabenplaner-offsite-restore-test.service.in',
        'server-tools\linux\offsite\systemd\grabenplaner-offsite-restore-test.timer.in',
        'server-tools\linux\grabenplaner-monitor.service.in',
        'server-tools\linux\grabenplaner-monitor.timer.in',
        'server-tools\linux\monitor\lib\monitor-status.js',
        'server-tools\linux\monitor\run-grabenplaner-monitor.sh',
        'server-tools\linux\migrate-grabenplaner-runtime-v2.sh',
        'server-tools\linux\recovery\grabenplaner-recovery.sh',
        'server-tools\linux\recovery\lib\recovery-apply.js',
        'server-tools\linux\recovery\lib\recovery-metadata.js',
        'server-tools\linux\recovery\lib\recovery-verify.js'
    ) + $expectedHardeningArtifacts
    foreach ($required in $requiredPackageFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $buildRoot $required) -PathType Leaf)) {
            throw "Pflichtdatei fehlt im Linux-Serverpaket: $required"
        }
    }

    $hardeningTreeRoot = Join-Path $buildRoot 'server-tools\linux\hardening'
    $hardeningTreeRootItem = Get-Item -LiteralPath $hardeningTreeRoot -Force
    if (-not $hardeningTreeRootItem.PSIsContainer -or
        (($hardeningTreeRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'Der optionale Hardening-Modulordner ist unzulaessig.'
    }
    $actualHardeningFiles = @()
    $actualHardeningDirectories = @()
    foreach ($item in Get-ChildItem -LiteralPath $hardeningTreeRoot -Recurse -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Links und Reparse-Points sind im Hardening-Modul nicht erlaubt: $($item.FullName)"
        }
        $relative = $item.FullName.Substring($buildRoot.TrimEnd('\').Length + 1).Replace('\', '/')
        if ($item.PSIsContainer) { $actualHardeningDirectories += $relative }
        elseif ($item -is [IO.FileInfo]) { $actualHardeningFiles += $relative }
        else { throw "Unzulaessiger Dateityp im Hardening-Modul: $relative" }
    }
    $actualHardeningFiles = [string[]]$actualHardeningFiles
    $actualHardeningDirectories = [string[]]$actualHardeningDirectories
    $sortedExpectedHardeningFiles = [string[]]$expectedHardeningArtifacts.Clone()
    $sortedExpectedHardeningDirectories = [string[]]$expectedHardeningDirectories.Clone()
    [Array]::Sort($actualHardeningFiles, [StringComparer]::Ordinal)
    [Array]::Sort($actualHardeningDirectories, [StringComparer]::Ordinal)
    [Array]::Sort($sortedExpectedHardeningFiles, [StringComparer]::Ordinal)
    [Array]::Sort($sortedExpectedHardeningDirectories, [StringComparer]::Ordinal)
    if (($actualHardeningFiles -join "`0") -cne ($sortedExpectedHardeningFiles -join "`0") -or
        ($actualHardeningDirectories -join "`0") -cne ($sortedExpectedHardeningDirectories -join "`0")) {
        throw 'Der Hardening-Modulbaum enthaelt nicht exakt die freigegebenen Dateien und Verzeichnisse.'
    }

    $hardeningSchemaPath = Join-Path $buildRoot 'server-tools\linux\hardening\module-schema.json'
    $hardeningSchema = Get-Content -LiteralPath $hardeningSchemaPath -Raw -Encoding utf8 | ConvertFrom-Json
    $hardeningSchemaKeys = @($hardeningSchema.PSObject.Properties.Name | Sort-Object)
    $expectedHardeningSchemaKeys = @('activationPolicy', 'format', 'managedArtifacts', 'moduleVersion', 'schemaVersion')
    if (($hardeningSchemaKeys -join "`0") -cne ($expectedHardeningSchemaKeys -join "`0") -or
        [string]$hardeningSchema.format -cne 'grabenplaner-linux-hardening-module-contract' -or
        [int]$hardeningSchema.schemaVersion -ne 1 -or [int]$hardeningSchema.moduleVersion -ne 2 -or
        [string]$hardeningSchema.activationPolicy -cne 'explicit-root-two-session') {
        throw 'Der separate Hardening-Modulvertrag wird nicht unterstuetzt.'
    }
    $declaredHardeningArtifacts = @($hardeningSchema.managedArtifacts | ForEach-Object { [string]$_ })
    if ($declaredHardeningArtifacts.Count -ne $expectedHardeningArtifacts.Count) {
        throw 'Der Hardening-Modulvertrag enthaelt nicht exakt die freigegebenen Artefakte.'
    }
    for ($index = 0; $index -lt $expectedHardeningArtifacts.Count; $index++) {
        if ($declaredHardeningArtifacts[$index] -cne $expectedHardeningArtifacts[$index]) {
            throw 'Der Hardening-Modulvertrag enthaelt nicht exakt die freigegebenen Artefakte.'
        }
    }
    $sortedHardeningArtifacts = [string[]]$expectedHardeningArtifacts.Clone()
    [Array]::Sort($sortedHardeningArtifacts, [StringComparer]::Ordinal)
    $hardeningContractFiles = @()
    $hardeningFingerprintPayload = [Text.StringBuilder]::new()
    foreach ($relative in $sortedHardeningArtifacts) {
        $candidate = Join-Path $buildRoot $relative.Replace('/', '\')
        $hash = Get-Sha256File -Path $candidate
        [void]$hardeningFingerprintPayload.Append($relative).Append([char]0).Append($hash).Append("`n")
        $hardeningContractFiles += [ordered]@{
            path = $relative.Substring($hardeningPrefix.Length)
            sha256 = $hash
        }
    }
    $hardeningModuleContract = [ordered]@{
        format = 'grabenplaner-linux-hardening-installed-contract'
        schemaVersion = [int]$hardeningSchema.schemaVersion
        moduleVersion = [int]$hardeningSchema.moduleVersion
        schemaSha256 = Get-Sha256File -Path $hardeningSchemaPath
        fingerprint = Get-Sha256Text -Value $hardeningFingerprintPayload.ToString()
        files = $hardeningContractFiles
    }
    foreach ($forbidden in @('node_modules', 'runtime', 'data', 'backups', '.env')) {
        if (Test-Path -LiteralPath (Join-Path $buildRoot $forbidden)) { throw "Verbotener Paketinhalt erkannt: $forbidden" }
    }

    $buildPrefix = $buildRoot.TrimEnd('\') + '\'
    $manifestFiles = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -File -Force |
        ForEach-Object {
            [ordered]@{
                path = $_.FullName.Substring($buildPrefix.Length).Replace('\', '/')
                bytes = [int64]$_.Length
                sha256 = Get-Sha256File -Path $_.FullName
            }
        } | Sort-Object { $_.path })
    $manifest = [ordered]@{
        format = 'grabenplaner-server-package'
        schemaVersion = 1
        appVersion = $version
        platform = 'linux'
        architecture = 'x64'
        dependenciesMode = 'source-install'
        minimumNode = $minimumNode
        packageManager = $packageManager
        sourceCommit = $sourceCommit
        createdAt = $sourceTimestamp
        nodeRuntimeIncluded = $false
        nodeRuntimeSha256 = $null
        hardeningModule = $hardeningModuleContract
        files = $manifestFiles
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 7
    [IO.File]::WriteAllText((Join-Path $buildRoot 'grabenplaner-server-manifest.json'), "$manifestJson`n", [Text.UTF8Encoding]::new($false))

    $archiveOwned = $true
    Write-DeterministicZip -SourceRoot $buildRoot -ArchivePath $archivePath
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $roundtripRoot)
    $roundtripManifestPath = Join-Path $roundtripRoot 'grabenplaner-server-manifest.json'
    if (-not (Test-Path -LiteralPath $roundtripManifestPath -PathType Leaf)) { throw 'Manifest fehlt nach dem ZIP-Roundtrip.' }
    $roundtripManifest = Get-Content -LiteralPath $roundtripManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($roundtripManifest.format -ne 'grabenplaner-server-package' -or [int]$roundtripManifest.schemaVersion -ne 1) {
        throw 'Das Linux-Paketmanifest ist nicht mit dem Server-Updater kompatibel.'
    }
    if ([int]$roundtripManifest.hardeningModule.schemaVersion -ne [int]$hardeningModuleContract.schemaVersion -or
        [int]$roundtripManifest.hardeningModule.moduleVersion -ne [int]$hardeningModuleContract.moduleVersion -or
        [string]$roundtripManifest.hardeningModule.fingerprint -cne [string]$hardeningModuleContract.fingerprint -or
        [string]$roundtripManifest.hardeningModule.schemaSha256 -cne [string]$hardeningModuleContract.schemaSha256) {
        throw 'Der Hardening-Modulvertrag hat den ZIP-Roundtrip nicht unveraendert ueberstanden.'
    }
    foreach ($item in $roundtripManifest.files) {
        $candidate = Join-Path $roundtripRoot ([string]$item.path).Replace('/', '\')
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Manifestdatei fehlt nach dem Roundtrip: $($item.path)" }
        $actual = Get-Sha256File -Path $candidate
        if ($actual -ne [string]$item.sha256) { throw "Manifestpruefsumme stimmt nicht: $($item.path)" }
    }
    if (Test-Path -LiteralPath (Join-Path $roundtripRoot 'node_modules')) { throw 'node_modules darf nicht im Linux-Quellpaket enthalten sein.' }

    $packageSha256 = Get-Sha256File -Path $archivePath
    $hashOwned = $true
    [IO.File]::WriteAllText($hashPath, "$packageSha256 *$archiveName`n", [Text.ASCIIEncoding]::new())
    $packageComplete = $true

    [pscustomobject]@{
        Ok = $true
        Package = $archivePath
        Sha256 = $packageSha256
        Sha256File = $hashPath
        AppVersion = $version
        SourceCommit = $sourceCommit
        DependenciesMode = 'source-install'
        FileCount = $manifestFiles.Count
    }
} finally {
    if (-not (Remove-TemporaryTreeBestEffort -Path $buildRoot -ExpectedParent $temporaryParent)) {
        Write-Warning "Der temporaere Paketordner konnte nicht entfernt werden: $buildRoot"
    }
    if (-not (Remove-TemporaryTreeBestEffort -Path $roundtripRoot -ExpectedParent $temporaryParent)) {
        Write-Warning "Der temporaere ZIP-Pruefordner konnte nicht entfernt werden: $roundtripRoot"
    }
    if (-not $packageComplete) {
        if ($archiveOwned) { Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue }
        if ($hashOwned) { Remove-Item -LiteralPath $hashPath -Force -ErrorAction SilentlyContinue }
    }
}

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackageZip,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$PackageSha256,

    [string]$AppDirectory = 'C:\Program Files\Grabenplaner\app',
    [string]$DataDirectory = 'C:\ProgramData\Grabenplaner',
    [string]$DatabasePath,
    [string]$BackupDirectory,
    [string]$AmuDirectory,
    [string]$PublicUrl,
    [string]$NodeExecutable,
    [string]$AppServiceName = 'GrabenplanerServer',
    [string]$ProxyServiceName = 'GrabenplanerCaddy',
    [ValidateRange(1, 1000)]
    [int]$BackupKeep = 30,
    [ValidateRange(30, 600)]
    [int]$HealthTimeoutSeconds = 120,
    [ValidateRange(1048576, 4294967296)]
    [int64]$MaximumExpandedBytes = 2147483648,
    [switch]$AllowDowngradeOrReinstall
)

$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Das Serverupdate muss in einer als Administrator gestarteten PowerShell ausgefuehrt werden.'
    }
}

function Resolve-LocalPath([string]$Path, [switch]$MustExist, [switch]$Directory) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Ein erforderlicher Pfad fehlt.' }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\') -or $fullPath -eq [System.IO.Path]::GetPathRoot($fullPath)) {
        throw "Nicht zulaessiger lokaler Pfad: $fullPath"
    }
    if ($MustExist) {
        $pathType = if ($Directory) { 'Container' } else { 'Leaf' }
        if (-not (Test-Path -LiteralPath $fullPath -PathType $pathType)) { throw "Pfad nicht gefunden: $fullPath" }
    }
    return $fullPath
}

function Test-ChildPath([string]$Candidate, [string]$Parent) {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $parentPrefix = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    return $candidatePath.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)
}

function Compare-SemVer([string]$Current, [string]$Candidate) {
    $pattern = '^(?<core>[0-9]+\.[0-9]+\.[0-9]+)(?:-(?<pre>[A-Za-z0-9.-]+))?$'
    if ($Current -notmatch $pattern) { throw "Installierte Version ist nicht vergleichbar: $Current" }
    $currentCore = [version]$Matches.core
    $currentPre = [string]$Matches.pre
    if ($Candidate -notmatch $pattern) { throw "Paketversion ist nicht vergleichbar: $Candidate" }
    $candidateCore = [version]$Matches.core
    $candidatePre = [string]$Matches.pre
    $coreComparison = $candidateCore.CompareTo($currentCore)
    if ($coreComparison -ne 0) { return $coreComparison }
    if (-not $currentPre -and $candidatePre) { return -1 }
    if ($currentPre -and -not $candidatePre) { return 1 }
    if (-not $currentPre -and -not $candidatePre) { return 0 }
    $currentParts = $currentPre.Split('.')
    $candidateParts = $candidatePre.Split('.')
    for ($index = 0; $index -lt [Math]::Min($currentParts.Length, $candidateParts.Length); $index++) {
        $left = $currentParts[$index]
        $right = $candidateParts[$index]
        $leftNumeric = $left -match '^[0-9]+$'
        $rightNumeric = $right -match '^[0-9]+$'
        if ($leftNumeric -and $rightNumeric) {
            $comparison = [Numerics.BigInteger]::Parse($right).CompareTo([Numerics.BigInteger]::Parse($left))
        } elseif ($leftNumeric -ne $rightNumeric) {
            $comparison = if ($rightNumeric) { -1 } else { 1 }
        } else {
            $comparison = [StringComparer]::Ordinal.Compare($right, $left)
        }
        if ($comparison -ne 0) { return $comparison }
    }
    return $candidateParts.Length.CompareTo($currentParts.Length)
}

function Remove-TreeSafely([string]$Path, [string]$ExpectedParent) {
    if (-not (Test-ChildPath -Candidate $Path -Parent $ExpectedParent)) {
        throw "Sicherheitsabbruch: Der zu entfernende Ordner liegt ausserhalb des Wartungsbereichs: $Path"
    }
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Get-ServiceEnvironmentValue([xml]$ServiceXml, [string]$Name) {
    $item = $ServiceXml.service.env | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    return if ($item) { [string]$item.value } else { $null }
}

function Stop-ManagedService([string]$Name, [int]$TimeoutSeconds = 120) {
    $service = Get-Service -Name $Name -ErrorAction Stop
    if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
        Stop-Service -Name $Name
        $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds($TimeoutSeconds))
    }
}

function Start-ManagedService([string]$Name, [int]$TimeoutSeconds = 60) {
    $service = Get-Service -Name $Name -ErrorAction Stop
    if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
        Start-Service -Name $Name
        $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds($TimeoutSeconds))
    }
}

function Wait-Health([string]$Url, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-RestMethod -Uri $Url -TimeoutSec 8
            if ($response.ok) { return $true }
        } catch {}
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Start-DatabaseMaintenanceLock([string]$Path, [string]$AppRoot, [string]$NodePath, [string]$WorkingDirectory) {
    $lockModule = Join-Path $AppRoot 'lib\database-lock.js'
    if (-not (Test-Path -LiteralPath $lockModule -PathType Leaf)) { throw "Datenbanksperrmodul nicht gefunden: $lockModule" }
    $helperPath = Join-Path $WorkingDirectory ".database-maintenance-lock-$([Guid]::NewGuid().ToString('N')).js"
    $script = @'
const [modulePath, databasePath] = process.argv.slice(2);
const { acquireDatabaseLock, releaseDatabaseLock } = require(modulePath);
const lock = acquireDatabaseLock({ databasePath, kind: 'backup', appVersion: 'server-update-probe' });
let released = false;
function release() {
  if (released) return;
  released = true;
  try { releaseDatabaseLock(lock); } finally { process.exit(0); }
}
process.stdout.write('LOCKED\n');
process.stdin.setEncoding('utf8');
process.stdin.once('data', release);
process.stdin.once('end', release);
process.on('SIGTERM', release);
setInterval(() => {}, 60_000);
'@
    [System.IO.File]::WriteAllText($helperPath, $script, [Text.UTF8Encoding]::new($false))
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NodePath
    $startInfo.Arguments = '"{0}" "{1}" "{2}"' -f $helperPath.Replace('"', '\"'), $lockModule.Replace('"', '\"'), $Path.Replace('"', '\"')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Der Datenbank-Wartungslock konnte nicht gestartet werden.' }
        $lineTask = $process.StandardOutput.ReadLineAsync()
        if (-not $lineTask.Wait(10000) -or $lineTask.Result -ne 'LOCKED') {
            if (-not $process.HasExited) { $process.Kill() }
            $detail = $process.StandardError.ReadToEnd()
            throw "Die Datenbank wird noch verwendet oder der Wartungslock ist fehlgeschlagen. $detail"
        }
        return [pscustomobject]@{ Process = $process; HelperPath = $helperPath }
    } catch {
        $process.Dispose()
        Remove-Item -LiteralPath $helperPath -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Stop-DatabaseMaintenanceLock($Handle) {
    if (-not $Handle) { return }
    try {
        if (-not $Handle.Process.HasExited) {
            $Handle.Process.StandardInput.WriteLine('release')
            $Handle.Process.StandardInput.Flush()
            $Handle.Process.StandardInput.Close()
            if (-not $Handle.Process.WaitForExit(10000)) { $Handle.Process.Kill() }
        }
    } finally {
        $Handle.Process.Dispose()
        Remove-Item -LiteralPath $Handle.HelperPath -Force -ErrorAction SilentlyContinue
    }
}

function Set-ProductionAppAcl([string]$Path) {
    & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-19:(OI)(CI)(RX)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Die produktiven App-Berechtigungen konnten nicht gesetzt werden.' }
    & icacls.exe (Join-Path $Path '*') /reset /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Die App-Berechtigungen konnten nicht rekursiv uebernommen werden.' }
}

function Assert-SupportedScannerReady([string]$NodePath, [string]$AppRoot) {
    $amuModule = Join-Path $AppRoot 'lib\amu-storage.js'
    if (-not (Test-Path -LiteralPath $amuModule -PathType Leaf)) { throw "AUM-Pruefmodul nicht gefunden: $amuModule" }
    $probe = Join-Path ([System.IO.Path]::GetTempPath()) "grabenplaner-update-scan-$([Guid]::NewGuid().ToString('N')).txt"
    try {
        [System.IO.File]::WriteAllText($probe, 'Grabenplaner update scanner probe', [Text.UTF8Encoding]::new($false))
        $script = @'
const [modulePath, probePath] = process.argv.slice(2);
const { scanWithAvailableEngine } = require(modulePath);
scanWithAvailableEngine(probePath, { requireScanner: true })
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => { console.error(error.message); process.exit(1); });
'@
        $result = $script | & $NodePath - $amuModule $probe
        if ($LASTEXITCODE -ne 0) { throw 'Kein unterstuetzter Virenscanner (Microsoft Defender oder ClamAV) ist einsatzbereit.' }
        $scan = $result | Select-Object -Last 1 | ConvertFrom-Json
        if (-not $scan.available -or -not $scan.clean) { throw 'Der Scanner-Preflight hat kein sauberes Ergebnis geliefert.' }
    } finally {
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    }
    return [string]$scan.engine
}

function Expand-VerifiedPackage([string]$ZipPath, [string]$Destination, [int64]$MaximumBytes) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $totalBytes = [int64]0
        $destinationPrefix = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
        foreach ($entry in $archive.Entries) {
            $entryName = $entry.FullName.Replace('/', '\')
            if (-not $entryName) { continue }
            if ([System.IO.Path]::IsPathRooted($entryName) -or $entryName.Contains(':')) { throw "Ungueltiger absoluter ZIP-Eintrag: $($entry.FullName)" }
            $entryTarget = [System.IO.Path]::GetFullPath((Join-Path $Destination $entryName))
            if (-not $entryTarget.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "ZIP-Pfad verlaesst den Staging-Ordner: $($entry.FullName)"
            }
            $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
            if ($unixType -eq 0xA000) { throw "Symbolische Links sind im Serverpaket nicht erlaubt: $($entry.FullName)" }
            $totalBytes += [int64]$entry.Length
            if ($totalBytes -gt $MaximumBytes) { throw 'Das entpackte Serverpaket ueberschreitet die freigegebene Maximalgroesse.' }
        }
    } finally {
        $archive.Dispose()
    }
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
}

function Test-PackageManifest([string]$ExtractRoot) {
    $manifestFiles = @(Get-ChildItem -LiteralPath $ExtractRoot -Filter 'grabenplaner-server-manifest.json' -File -Recurse)
    if ($manifestFiles.Count -ne 1) { throw 'Das Serverpaket muss genau ein grabenplaner-server-manifest.json enthalten.' }
    $manifestPath = $manifestFiles[0].FullName
    $packageRoot = Split-Path -Parent $manifestPath
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.format -ne 'grabenplaner-server-package' -or [int]$manifest.schemaVersion -ne 1 -or -not $manifest.files) {
        throw 'Das Serverpaket-Manifest ist ungueltig oder wird nicht unterstuetzt.'
    }
    $packageMetadata = Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json
    if ([string]$manifest.appVersion -ne [string]$packageMetadata.version) {
        throw 'Manifest-Version und package.json-Version des Serverpakets stimmen nicht ueberein.'
    }
    foreach ($required in @('server.js', 'package.json', 'lib\database-lock.js', 'server-tools\windows\Update-GrabenplanerServer.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $required) -PathType Leaf)) { throw "Pflichtdatei fehlt im Updatepaket: $required" }
    }
    $expected = @{}
    foreach ($item in $manifest.files) {
        $relative = [string]$item.path
        if (-not $relative -or $expected.ContainsKey($relative)) { throw "Doppelter oder leerer Manifestpfad: $relative" }
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $packageRoot $relative.Replace('/', '\')))
        if (-not (Test-ChildPath -Candidate $candidate -Parent $packageRoot) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Manifestpfad ist ungueltig oder fehlt: $relative"
        }
        $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        $actualLength = (Get-Item -LiteralPath $candidate).Length
        if ($actualHash -ne ([string]$item.sha256).ToLowerInvariant() -or $actualLength -ne [int64]$item.bytes) {
            throw "Manifestpruefung fehlgeschlagen: $relative"
        }
        $expected[$relative] = $true
    }
    $runtimeEntry = $manifest.files | Where-Object { [string]$_.path -eq 'runtime/node.exe' } | Select-Object -First 1
    if ([bool]$manifest.nodeRuntimeIncluded -ne [bool]$runtimeEntry) {
        throw 'Die Node-Runtime-Angabe im Manifest ist inkonsistent.'
    }
    if ($runtimeEntry -and ([string]$manifest.nodeRuntimeSha256).ToLowerInvariant() -ne ([string]$runtimeEntry.sha256).ToLowerInvariant()) {
        throw 'Die Node-Runtime-Pruefsumme im Manifest ist inkonsistent.'
    }
    $rootPrefix = $packageRoot.TrimEnd('\') + '\'
    $actualPaths = @(Get-ChildItem -LiteralPath $packageRoot -Recurse -File -Force |
        Where-Object { $_.FullName -ne $manifestPath } |
        ForEach-Object { $_.FullName.Substring($rootPrefix.Length).Replace('\', '/') })
    if ($actualPaths.Count -ne $expected.Count -or $actualPaths.Where({ -not $expected.ContainsKey($_) }).Count -gt 0) {
        throw 'Das Serverpaket enthaelt nicht im Manifest erfasste oder fehlende Dateien.'
    }
    return [pscustomobject]@{
        Root = $packageRoot
        ManifestPath = $manifestPath
        Manifest = $manifest
        ManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Write-UpdateReceipt([string]$HistoryRoot, [System.Collections.IDictionary]$Values) {
    New-Item -ItemType Directory -Path $HistoryRoot -Force | Out-Null
    & icacls.exe $HistoryRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Der geschuetzte Update-Verlauf konnte nicht abgesichert werden.' }
    $receiptPath = Join-Path $HistoryRoot ("update-{0}.json" -f (Get-Date -Format 'yyyy-MM-ddTHH-mm-ss-fff'))
    $Values | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding utf8
    & icacls.exe $receiptPath /inheritance:r /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
    return $receiptPath
}

Assert-Administrator
$packagePath = Resolve-LocalPath -Path $PackageZip -MustExist
if ([System.IO.Path]::GetExtension($packagePath) -ne '.zip') { throw 'Das Updatepaket muss eine ZIP-Datei sein.' }
$actualPackageSha256 = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualPackageSha256 -ne $PackageSha256.ToLowerInvariant()) {
    throw "Die Paketpruefsumme stimmt nicht. Erwartet: $($PackageSha256.ToLowerInvariant()), gefunden: $actualPackageSha256"
}

$appRoot = Resolve-LocalPath -Path $AppDirectory -MustExist -Directory
$dataRoot = Resolve-LocalPath -Path $DataDirectory -MustExist -Directory
if ((Test-ChildPath -Candidate $dataRoot -Parent $appRoot) -or (Test-ChildPath -Candidate $appRoot -Parent $dataRoot) -or $appRoot -eq $dataRoot) {
    throw 'App- und Datenordner muessen vollstaendig getrennt sein.'
}
$serviceXmlPath = Join-Path $dataRoot 'services\Grabenplaner.Service.xml'
if (-not (Test-Path -LiteralPath $serviceXmlPath -PathType Leaf)) { throw "Dienstkonfiguration fehlt: $serviceXmlPath" }
[xml]$serviceXml = Get-Content -LiteralPath $serviceXmlPath -Raw

if (-not $DatabasePath) { $DatabasePath = Get-ServiceEnvironmentValue $serviceXml 'DB_PATH' }
if (-not $BackupDirectory) { $BackupDirectory = Get-ServiceEnvironmentValue $serviceXml 'BACKUP_DIR' }
if (-not $AmuDirectory) { $AmuDirectory = Join-Path $dataRoot 'private\amu' }
if (-not $PublicUrl) { $PublicUrl = Get-ServiceEnvironmentValue $serviceXml 'GRABENPLANER_PUBLIC_URL' }
if (-not $NodeExecutable) { $NodeExecutable = [string]$serviceXml.service.executable }
$port = Get-ServiceEnvironmentValue $serviceXml 'PORT'
if (-not $port) { $port = '3000' }
$internalReadyUrl = "http://127.0.0.1:$port/api/health/ready"
$publicUri = try { [Uri]$PublicUrl } catch { $null }
if (-not $publicUri -or $publicUri.Scheme -ne 'https' -or -not $publicUri.Host -or $publicUri.AbsolutePath -ne '/' -or $publicUri.Query -or $publicUri.Fragment -or $publicUri.UserInfo) {
    throw 'Die produktive HTTPS-Adresse fehlt oder ist ungueltig in der Dienstkonfiguration.'
}
$publicReadyUrl = "$($PublicUrl.TrimEnd('/'))/api/health/ready"

$database = Resolve-LocalPath -Path $DatabasePath -MustExist
$backupRoot = Resolve-LocalPath -Path $BackupDirectory
$amuRoot = Resolve-LocalPath -Path $AmuDirectory -Directory
$nodePath = Resolve-LocalPath -Path $NodeExecutable -MustExist
if (-not (Test-ChildPath -Candidate $database -Parent $dataRoot)) { throw 'DB_PATH muss innerhalb des geschuetzten Datenordners liegen.' }
if (-not (Test-ChildPath -Candidate $amuRoot -Parent $dataRoot)) { throw 'Der AUM-Speicher muss innerhalb des geschuetzten Datenordners liegen.' }
foreach ($tree in @($appRoot, $dataRoot)) {
    if ((Test-ChildPath -Candidate $backupRoot -Parent $tree) -or (Test-ChildPath -Candidate $tree -Parent $backupRoot) -or $backupRoot -eq $tree) {
        throw 'Backup-, App- und Datenordner muessen vollstaendig getrennte Ordnerbaeume sein.'
    }
}
if ((Test-ChildPath -Candidate $nodePath -Parent $dataRoot) -or (Test-ChildPath -Candidate $nodePath -Parent $backupRoot)) {
    throw 'Die Node-Runtime darf nicht im Daten- oder Backupordner liegen.'
}
$backupScript = Join-Path $appRoot 'server-tools\windows\Backup-Grabenplaner.ps1'
if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) { throw "Backupskript fehlt: $backupScript" }
$scannerEngine = Assert-SupportedScannerReady -NodePath $nodePath -AppRoot $appRoot

$appParent = Split-Path -Parent $appRoot
$maintenanceRoot = Join-Path $appParent ".grabenplaner-update-$([Guid]::NewGuid().ToString('N'))"
$extractRoot = Join-Path $maintenanceRoot 'extract'
$rollbackRoot = Join-Path $maintenanceRoot 'previous-app'
$historyRoot = Join-Path $dataRoot 'maintenance\history'
$oldVersion = try { [string](Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json).version } catch { 'unknown' }
$oldServerHash = (Get-FileHash -LiteralPath (Join-Path $appRoot 'server.js') -Algorithm SHA256).Hash.ToLowerInvariant()
$oldNodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
$nodeInsideApp = Test-ChildPath -Candidate $nodePath -Parent $appRoot
$nodeRelativePath = if ($nodeInsideApp) { $nodePath.Substring($appRoot.TrimEnd('\').Length + 1) } else { $null }

$maintenanceMutex = [Threading.Mutex]::new($false, 'Global\GrabenplanerServerMaintenance')
$maintenanceMutexHeld = $false
$servicesTouched = $false
$oldAppMoved = $false
$appSwapped = $false
$databaseLockHandle = $null
$packageInfo = $null
$backupResult = $null
$receiptPath = $null
$updateCommitted = $false
try {
    if (-not $maintenanceMutex.WaitOne(0)) { throw 'Eine andere Grabenplaner-Wartung (Backup, Restore oder Update) ist bereits aktiv.' }
    $maintenanceMutexHeld = $true
    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    Expand-VerifiedPackage -ZipPath $packagePath -Destination $extractRoot -MaximumBytes $MaximumExpandedBytes
    $packageInfo = Test-PackageManifest -ExtractRoot $extractRoot
    if (-not $AllowDowngradeOrReinstall -and $oldVersion -ne 'unknown') {
        if ((Compare-SemVer -Current $oldVersion -Candidate ([string]$packageInfo.Manifest.appVersion)) -le 0) {
            throw 'Gleiche oder aeltere App-Versionen werden nur mit -AllowDowngradeOrReinstall installiert.'
        }
    }
    if ($nodeInsideApp -and -not (Test-Path -LiteralPath (Join-Path $packageInfo.Root $nodeRelativePath) -PathType Leaf)) {
        throw "Das Serverpaket enthaelt die vom Dienst verwendete Node-Runtime nicht: $nodeRelativePath"
    }

    if (-not $PSCmdlet.ShouldProcess($appRoot, "Auf Serverpaket v$($packageInfo.Manifest.appVersion) aktualisieren")) { return }

    foreach ($serviceName in @($AppServiceName, $ProxyServiceName)) {
        $service = Get-Service -Name $serviceName -ErrorAction Stop
        if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
            throw "Der produktive Dienst $serviceName muss vor dem Update laufen. Aktueller Status: $($service.Status)."
        }
    }
    $servicesTouched = $true
    Stop-ManagedService -Name $ProxyServiceName
    Stop-ManagedService -Name $AppServiceName

    $backupResult = & $backupScript -DatabasePath $database -BackupDirectory $backupRoot -Keep $BackupKeep -ServiceName $AppServiceName -NodeExecutable $nodePath -AppDirectory $appRoot -AmuDirectory $amuRoot -Confirm:$false | Select-Object -Last 1
    if (-not $backupResult.Ok) { throw 'Das verifizierte Sicherheitsbackup vor dem Update ist fehlgeschlagen.' }
    $databaseLockHandle = Start-DatabaseMaintenanceLock -Path $database -AppRoot $appRoot -NodePath $nodePath -WorkingDirectory $maintenanceRoot

    Set-ProductionAppAcl $packageInfo.Root
    Move-Item -LiteralPath $appRoot -Destination $rollbackRoot
    $oldAppMoved = $true
    Move-Item -LiteralPath $packageInfo.Root -Destination $appRoot
    $appSwapped = $true
    Set-ProductionAppAcl $appRoot

    $newNodePath = if ($nodeInsideApp) { Join-Path $appRoot $nodeRelativePath } else { $nodePath }
    if (-not (Test-Path -LiteralPath $newNodePath -PathType Leaf)) { throw 'Die Node-Runtime fehlt nach dem Dateiaustausch.' }
    Stop-DatabaseMaintenanceLock $databaseLockHandle
    $databaseLockHandle = $null
    Start-ManagedService -Name $AppServiceName
    if (-not (Wait-Health -Url $internalReadyUrl -TimeoutSeconds $HealthTimeoutSeconds)) {
        throw 'Die neue App wurde intern nicht rechtzeitig betriebsbereit.'
    }
    Start-ManagedService -Name $ProxyServiceName
    if (-not (Wait-Health -Url $publicReadyUrl -TimeoutSeconds $HealthTimeoutSeconds)) {
        throw 'Der oeffentliche HTTPS-Readinesscheck ist nach dem Update fehlgeschlagen.'
    }
    $receiptPath = Write-UpdateReceipt -HistoryRoot $historyRoot -Values ([ordered]@{
        status = 'success'
        completedAt = (Get-Date).ToUniversalTime().ToString('o')
        previousVersion = $oldVersion
        installedVersion = [string]$packageInfo.Manifest.appVersion
        packageFile = [System.IO.Path]::GetFileName($packagePath)
        packageSha256 = $actualPackageSha256
        manifestSha256 = $packageInfo.ManifestSha256
        previousServerSha256 = $oldServerHash
        installedServerSha256 = (Get-FileHash -LiteralPath (Join-Path $appRoot 'server.js') -Algorithm SHA256).Hash.ToLowerInvariant()
        previousNodeSha256 = $oldNodeHash
        installedNodeSha256 = (Get-FileHash -LiteralPath $newNodePath -Algorithm SHA256).Hash.ToLowerInvariant()
        scannerEngine = $scannerEngine
        backupFile = [string]$backupResult.Path
        backupSha256 = [string]$backupResult.Sha256
    })
    $updateCommitted = $true

    [pscustomobject]@{
        Ok = $true
        PreviousVersion = $oldVersion
        InstalledVersion = [string]$packageInfo.Manifest.appVersion
        PackageSha256 = $actualPackageSha256
        Backup = [string]$backupResult.Path
        Receipt = $receiptPath
        PublicReadiness = $publicReadyUrl
    }
} catch {
    $updateError = $_
    $restoreData = [bool]($appSwapped -and $backupResult -and $backupResult.Path)
    if ($servicesTouched -or $oldAppMoved -or $appSwapped) {
        foreach ($serviceName in @($ProxyServiceName, $AppServiceName)) {
            try { Stop-ManagedService -Name $serviceName } catch {
                Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
                $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
                if ($service) { $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30)) }
            }
        }
    }
    Stop-DatabaseMaintenanceLock $databaseLockHandle
    $databaseLockHandle = $null
    if ($oldAppMoved -and (Test-Path -LiteralPath $rollbackRoot -PathType Container)) {
        if (Test-Path -LiteralPath $appRoot -PathType Container) { Remove-TreeSafely -Path $appRoot -ExpectedParent $appParent }
        Move-Item -LiteralPath $rollbackRoot -Destination $appRoot
        $oldAppMoved = $false
        $appSwapped = $false
    }
    $rollbackDataReady = -not $restoreData
    $rollbackDataError = $null
    if ($restoreData) {
        try {
            $restoreScript = Join-Path $appRoot 'server-tools\windows\Restore-Grabenplaner.ps1'
            if (-not (Test-Path -LiteralPath $restoreScript -PathType Leaf)) { throw 'Das Restore-Skript der vorherigen Version fehlt.' }
            & $restoreScript -BackupFile ([string]$backupResult.Path) -DatabasePath $database -ServiceName $AppServiceName -NodeExecutable $nodePath -AppDirectory $appRoot -AmuDirectory $amuRoot -ServiceXmlPath $serviceXmlPath -Confirm:$false | Out-Null
            $rollbackDataReady = $true
        } catch { $rollbackDataError = $_.Exception.Message }
    }
    $rollbackPublicReady = -not $servicesTouched
    if ($rollbackDataReady -and $servicesTouched -and (Test-Path -LiteralPath $appRoot -PathType Container)) {
        try {
            Start-ManagedService -Name $AppServiceName
            if (Wait-Health -Url $internalReadyUrl -TimeoutSeconds $HealthTimeoutSeconds) {
                Start-ManagedService -Name $ProxyServiceName
                $rollbackPublicReady = Wait-Health -Url $publicReadyUrl -TimeoutSeconds $HealthTimeoutSeconds
            }
        } catch {}
    }
    try {
        $receiptPath = Write-UpdateReceipt -HistoryRoot $historyRoot -Values ([ordered]@{
            status = 'rolled-back'
            completedAt = (Get-Date).ToUniversalTime().ToString('o')
            previousVersion = $oldVersion
            requestedVersion = if ($packageInfo) { [string]$packageInfo.Manifest.appVersion } else { $null }
            packageFile = [System.IO.Path]::GetFileName($packagePath)
            packageSha256 = $actualPackageSha256
            error = $updateError.Exception.Message
            backupFile = if ($backupResult) { [string]$backupResult.Path } else { $null }
            dataRestored = $restoreData
            rollbackDataReady = $rollbackDataReady
            rollbackDataError = $rollbackDataError
            rollbackPublicReady = $rollbackPublicReady
        })
    } catch {}
    $recoveryHint = if (-not $rollbackDataReady) {
        " Datenbank/AUM-Rollback unvollstaendig ($rollbackDataError); sofortiger manueller IT-Eingriff ist erforderlich."
    } elseif ($servicesTouched -and -not $rollbackPublicReady) {
        ' Der Rollback ist noch nicht oeffentlich HTTPS-bereit; manueller IT-Eingriff ist erforderlich.'
    } else { '' }
    throw "Serverupdate fehlgeschlagen; die vorherige App-Version wurde wiederhergestellt. $($updateError.Exception.Message)$recoveryHint"
} finally {
    Stop-DatabaseMaintenanceLock $databaseLockHandle
    if (Test-Path -LiteralPath $maintenanceRoot) {
        if ($updateCommitted -or (-not $oldAppMoved -and -not $appSwapped)) {
            try { Remove-TreeSafely -Path $maintenanceRoot -ExpectedParent $appParent } catch {}
        }
    }
    if ($maintenanceMutexHeld) { $maintenanceMutex.ReleaseMutex() }
    $maintenanceMutex.Dispose()
}

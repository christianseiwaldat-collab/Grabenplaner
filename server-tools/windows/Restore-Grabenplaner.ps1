[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$BackupFile,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DatabasePath,

    [string]$ServiceName = 'GrabenplanerServer',
    [string]$NodeExecutable = 'node',
    [string]$InternalHealthUrl = 'http://127.0.0.1:3000/api/health',
    [string]$AppDirectory = 'C:\Program Files\Grabenplaner\app',
    [string]$AmuBackupDirectory,
    [string]$AmuDirectory = 'C:\ProgramData\Grabenplaner\private\amu',
    [string]$AmuKeyId,
    [string]$AmuEncryptionKey,
    [string]$ServiceXmlPath,
    [switch]$StartServiceAfterRestore
)

$ErrorActionPreference = 'Stop'

function Assert-LocalFile([string]$Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.StartsWith('\\')) { throw "SQLite-Dateien auf Netzpfaden werden nicht unterstuetzt: $fullPath" }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Datei nicht gefunden: $fullPath" }
    return $fullPath
}

function Test-SqliteDatabase([string]$Path) {
    $script = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const result = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
  if (result.length !== 1 || result[0] !== 'ok') throw new Error(result.join('; '));
  process.stdout.write('ok');
} finally { db.close(); }
'@
    $output = $script | & $NodeExecutable - $Path
    if ($LASTEXITCODE -ne 0 -or ($output | Select-Object -Last 1) -ne 'ok') {
        throw "SQLite-Integritaetspruefung fehlgeschlagen: $Path"
    }
}

function New-SafetyBackup([string]$Source, [string]$Target) {
    $script = @'
const { DatabaseSync } = require('node:sqlite');
const [source, target] = process.argv.slice(2);
const db = new DatabaseSync(source);
try {
  const escaped = target.replaceAll('\\', '/').replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally { db.close(); }
'@
    $script | & $NodeExecutable - $Source $Target
    if ($LASTEXITCODE -ne 0) { throw 'Sicherheitsbackup vor der Wiederherstellung fehlgeschlagen.' }
    Test-SqliteDatabase -Path $Target
}

function Invoke-AmuStorage([string]$Action, [string]$ModulePath, [string]$Source, [string]$Target) {
    $script = @'
const [action, modulePath, source, target] = process.argv.slice(2);
const storage = require(modulePath);
const result = action === 'backup'
  ? storage.syncEncryptedFilesBackup({ sourceDirectory: source, targetDirectory: target })
  : storage.restoreEncryptedFilesBackup({ backupDirectory: source, targetDirectory: target });
process.stdout.write(JSON.stringify({ ok: true, fileCount: result.fileCount }));
'@
    $result = $script | & $NodeExecutable - $Action $ModulePath $Source $Target
    if ($LASTEXITCODE -ne 0) { throw "AMU-Dateivorgang '$Action' ist fehlgeschlagen." }
    $verification = $result | Select-Object -Last 1 | ConvertFrom-Json
    if (-not $verification.ok) { throw "AMU-Dateivorgang '$Action' konnte nicht verifiziert werden." }
    return $verification
}

$service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
    throw "Der Dienst $ServiceName muss vor der Wiederherstellung vollstaendig beendet sein. Aktueller Status: $($service.Status)."
}

$source = Assert-LocalFile -Path $BackupFile
Test-SqliteDatabase -Path $source
$target = [System.IO.Path]::GetFullPath($DatabasePath)
if ($target.StartsWith('\\')) { throw 'Die Zieldatenbank darf nicht auf einem Netzpfad liegen.' }
if ($source -eq $target) { throw 'Backup-Datei und Zieldatenbank duerfen nicht identisch sein.' }

$targetDirectory = Split-Path -Parent $target
$timestamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss-fff'
$temporary = Join-Path $targetDirectory ".restore-$timestamp.tmp.db"
$rawPrevious = Join-Path $targetDirectory ".pre-restore-$timestamp.raw.db"
$safetyBackup = Join-Path $targetDirectory "dienstplan-pre-restore-$timestamp.db"
$walPath = "$target-wal"
$shmPath = "$target-shm"
$amuRestored = $false
$amuSafetyBackup = Join-Path $targetDirectory ".amu-pre-restore-$timestamp"
$amuTarget = [System.IO.Path]::GetFullPath($AmuDirectory)
$amuModule = Join-Path ([System.IO.Path]::GetFullPath($AppDirectory)) 'lib\amu-storage.js'
if (-not $AmuBackupDirectory) {
    $AmuBackupDirectory = Join-Path (Split-Path -Parent $source) "$([System.IO.Path]::GetFileNameWithoutExtension($source)).amu"
}
$amuSource = [System.IO.Path]::GetFullPath($AmuBackupDirectory)
$amuManifestPath = Join-Path $amuSource 'manifest.json'
if (-not (Test-Path -LiteralPath $amuManifestPath -PathType Leaf)) { throw "Das zum Datenbank-Backup gehörende AMU-Manifest wurde nicht gefunden: $amuSource" }
if (-not (Test-Path -LiteralPath $amuModule -PathType Leaf)) { throw "AMU-Backupmodul nicht gefunden: $amuModule" }
if ($amuTarget -eq [System.IO.Path]::GetPathRoot($amuTarget)) { throw 'Das AMU-Zielverzeichnis darf kein Laufwerksstamm sein.' }
$amuManifest = Get-Content -LiteralPath $amuManifestPath -Raw | ConvertFrom-Json
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($amuManifest.database.fileName -ne [System.IO.Path]::GetFileName($source) -or $amuManifest.database.sha256 -ne $sourceHash) {
    throw 'Datenbank und AMU-Dateien gehören nicht zum selben verifizierten Sicherungspunkt.'
}
if (-not $ServiceXmlPath) {
    $dataRoot = Split-Path -Parent (Split-Path -Parent $target)
    $ServiceXmlPath = Join-Path $dataRoot 'services\Grabenplaner.Service.xml'
}
if ((-not $AmuEncryptionKey -or -not $AmuKeyId) -and (Test-Path -LiteralPath $ServiceXmlPath -PathType Leaf)) {
    [xml]$serviceXml = Get-Content -LiteralPath $ServiceXmlPath -Raw
    $serviceKey = $serviceXml.service.env | Where-Object { $_.name -eq 'GRABENPLANER_AMU_KEY' } | Select-Object -First 1
    $serviceKeyId = $serviceXml.service.env | Where-Object { $_.name -eq 'GRABENPLANER_AMU_KEY_ID' } | Select-Object -First 1
    if (-not $AmuEncryptionKey -and $serviceKey.value) { $AmuEncryptionKey = [string]$serviceKey.value }
    if (-not $AmuKeyId -and $serviceKeyId.value) { $AmuKeyId = [string]$serviceKeyId.value }
}
if (-not $AmuEncryptionKey -or -not $AmuKeyId) {
    throw 'Für die Wiederherstellung ist der gesicherte AMU-Recovery-Schlüssel erforderlich.'
}
$keyValidationScript = @'
const [modulePath, sourceDirectory, keyId, key] = process.argv.slice(2);
const { validateEncryptionKeyForStorage } = require(modulePath);
const result = validateEncryptionKeyForStorage({ sourceDirectory, encryptionKeys: { [keyId]: key }, activeKeyId: keyId });
process.stdout.write(JSON.stringify(result));
'@
$keyValidationScript | & $NodeExecutable - $amuModule $amuSource $AmuKeyId $AmuEncryptionKey | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Der Recovery-Schlüssel kann den gewählten AMU-Sicherungspunkt nicht entschlüsseln.' }

if (-not $PSCmdlet.ShouldProcess($target, "Mit verifiziertem Backup $source wiederherstellen")) { return }

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$hadDatabase = Test-Path -LiteralPath $target -PathType Leaf
if ($hadDatabase) { New-SafetyBackup -Source $target -Target $safetyBackup }

try {
    Copy-Item -LiteralPath $source -Destination $temporary -Force
    Test-SqliteDatabase -Path $temporary
    Remove-Item -LiteralPath $walPath, $shmPath -Force -ErrorAction SilentlyContinue
    if ($hadDatabase) { Move-Item -LiteralPath $target -Destination $rawPrevious -Force }
    Move-Item -LiteralPath $temporary -Destination $target -Force
    Test-SqliteDatabase -Path $target

    if ($AmuBackupDirectory) {
        Invoke-AmuStorage -Action 'backup' -ModulePath $amuModule -Source $amuTarget -Target $amuSafetyBackup | Out-Null
        Invoke-AmuStorage -Action 'restore' -ModulePath $amuModule -Source $amuSource -Target $amuTarget | Out-Null
        $amuRestored = $true
    }

    if ($StartServiceAfterRestore) {
        Start-Service -Name $ServiceName
        $deadline = (Get-Date).AddSeconds(45)
        $healthy = $false
        while ((Get-Date) -lt $deadline) {
            try {
                $health = Invoke-RestMethod -Uri $InternalHealthUrl -TimeoutSec 5
                if ($health.ok) { $healthy = $true; break }
            } catch {}
            Start-Sleep -Seconds 2
        }
        if (-not $healthy) { throw 'Der Dienst wurde nach der Wiederherstellung nicht rechtzeitig betriebsbereit.' }
    }

    Remove-Item -LiteralPath $rawPrevious -Force -ErrorAction SilentlyContinue
    if ($amuRestored -and (Test-Path -LiteralPath $amuSafetyBackup -PathType Container)) {
        $resolvedSafety = [System.IO.Path]::GetFullPath($amuSafetyBackup)
        if (-not $resolvedSafety.StartsWith($targetDirectory + [IO.Path]::DirectorySeparatorChar)) { throw 'Der AMU-Sicherungsordner liegt außerhalb des erwarteten Arbeitsbereichs.' }
        Remove-Item -LiteralPath $resolvedSafety -Recurse -Force
    }
    [pscustomobject]@{
        Ok             = $true
        Database       = $target
        SafetyBackup   = if ($hadDatabase) { $safetyBackup } else { $null }
        ServiceStarted = [bool]$StartServiceAfterRestore
        AmuRestored    = $amuRestored
    }
} catch {
    $restoreError = $_
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $target, $temporary, $walPath, $shmPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $safetyBackup -PathType Leaf) {
        Copy-Item -LiteralPath $safetyBackup -Destination $target -Force
    } elseif (Test-Path -LiteralPath $rawPrevious -PathType Leaf) {
        Move-Item -LiteralPath $rawPrevious -Destination $target -Force
    }
    if ($AmuBackupDirectory -and (Test-Path -LiteralPath (Join-Path $amuSafetyBackup 'manifest.json') -PathType Leaf)) {
        try { Invoke-AmuStorage -Action 'restore' -ModulePath $amuModule -Source $amuSafetyBackup -Target $amuTarget | Out-Null } catch {}
    }
    Remove-Item -LiteralPath $rawPrevious -Force -ErrorAction SilentlyContinue
    if ($StartServiceAfterRestore -and (Test-Path -LiteralPath $target -PathType Leaf)) {
        Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
    }
    throw "Wiederherstellung fehlgeschlagen; die vorherige Datenbank wurde zurueckgesetzt. $($restoreError.Exception.Message)"
} finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
